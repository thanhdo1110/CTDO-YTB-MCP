import type {
  LeanChannel,
  LeanComment,
  LeanPlaylist,
  LeanVideo,
  TranscriptResult,
} from '../core/types.js';
import {
  extractPlaylistId,
  extractVideoId,
  formatTimestamp,
  mapConcurrent,
  parseChannelRef,
} from '../core/utils.js';
import {
  enrichChannelIntelligence,
  fetchDislikeStats,
  fetchSponsorBlock,
} from './enrichers.js';
import {
  browseChannelInnerTube,
  fetchChannelRss,
  fetchCommentsInnerTube,
  fetchInnerTubeTranscript,
  fetchInnerTubeVideoFull,
  fetchPlaylistInnerTube,
  resolveChannelIdInnerTube,
  searchInnerTube,
} from './innertube.js';
import { youtubeApiPool } from './youtube-api.js';
import { writeFile } from 'node:fs/promises';

/**
 * Hybrid YouTube Orchestrator:
 * Automatically combines Multi-Key YouTube Data API v3 (for 50x batch speed when configured)
 * with 2026 Zero-Key InnerTube (for transcripts, Shorts, comments, and 100% API-keyless operation!).
 */
export class HybridYouTubeClient {
  /**
   * Get single or batch videos with rich optional enrichments (chapters, sponsorblock, dislikes, description level).
   */
  async getVideos(options: {
    videos: string[];
    descriptionDetail?: 'none' | 'snippet' | 'full';
    includeTags?: boolean;
    includeChapters?: boolean;
    includeSponsorBlock?: boolean;
    includeDislikes?: boolean;
  }): Promise<LeanVideo[]> {
    const ids = Array.from(new Set(options.videos.map(extractVideoId)));
    if (ids.length === 0) return [];

    let baseVideos: LeanVideo[] = [];

    if (youtubeApiPool.hasKeys()) {
      try {
        baseVideos = await youtubeApiPool.getVideosBatch(ids);
      } catch {
        baseVideos = [];
      }
    }

    // Fallback or fill missing via concurrent InnerTube mobile/next fetch
    const foundMap = new Map(baseVideos.map((v) => [v.id, v]));
    const missingIds = ids.filter((id) => !foundMap.has(id));
    if (missingIds.length > 0) {
      const itResults = await mapConcurrent(missingIds, 6, async (id) => {
        try {
          const r = await fetchInnerTubeVideoFull(id);
          return r.video;
        } catch {
          return null;
        }
      });
      for (const v of itResults) {
        if (v) foundMap.set(v.id, v);
      }
    }

    const ordered = ids.map((id) => foundMap.get(id)).filter((v): v is LeanVideo => Boolean(v));

    // Optional parallel enrichers (SponsorBlock + ReturnYouTubeDislike + InnerTube Chapters if API didn't have them)
    await mapConcurrent(ordered, 8, async (v) => {
      const tasks: Promise<void>[] = [];

      if (options.includeSponsorBlock) {
        tasks.push(
          fetchSponsorBlock(v.id).then((sb) => {
            if (sb.segments.length > 0) v.sponsorSegments = sb.segments;
            if (sb.highlightSec !== undefined) v.highlightSec = sb.highlightSec;
          })
        );
      }

      if (options.includeDislikes) {
        tasks.push(
          fetchDislikeStats(v.id).then((d) => {
            if (d) v.dislikes = d;
          })
        );
      }

      if (options.includeChapters && (!v.chapters || v.chapters.length === 0) && v.source === 'api') {
        tasks.push(
          fetchInnerTubeVideoFull(v.id)
            .then((it) => {
              if (it.video.chapters?.length) v.chapters = it.video.chapters;
            })
            .catch(() => undefined)
        );
      }

      await Promise.all(tasks);

      // Token-weight shaping
      const descMode = options.descriptionDetail || 'none';
      if (descMode === 'none') {
        delete v.description;
      } else if (descMode === 'snippet' && v.description && v.description.length > 240) {
        v.description = `${v.description.slice(0, 240)}...`;
      } else if (descMode === 'full' && v.description && v.description.length > 2000) {
        v.description = `${v.description.slice(0, 2000)}...`;
      }

      if (!options.includeTags) {
        delete v.tags;
      }
      if (!options.includeChapters) {
        delete v.chapters;
      }
    });

    return ordered;
  }

  /**
   * Universal Search across Videos, Shorts, Channels, Playlists, Trending, and Categories.
   */
  async search(options: {
    query?: string;
    target?: 'video' | 'short' | 'channel' | 'playlist' | 'trending' | 'categories';
    maxResults?: number;
    sort?:
      | 'relevance'
      | 'date'
      | 'views'
      | 'rating'
      | 'indie_priority'
      | 'subscribers_asc'
      | 'subscribers_desc'
      | 'recent_activity';
    publishedAfter?: string;
    publishedBefore?: string;
    channelId?: string;
    regionCode?: string;
    categoryId?: string;
    duration?: 'any' | 'short' | 'medium' | 'long';
    minSubs?: number;
    maxSubs?: number;
    creatorOnly?: boolean;
    uniqueChannels?: boolean;
  }): Promise<unknown> {
    const target = options.target || 'video';
    const maxResults = Math.min(50, Math.max(1, options.maxResults || 15));
    const regionCode = options.regionCode || process.env.CTDO_DEFAULT_REGION || 'US';

    if (target === 'categories') {
      if (youtubeApiPool.hasKeys()) {
        try {
          return await youtubeApiPool.getVideoCategories(regionCode);
        } catch {
          // fallback static standard YouTube category map
        }
      }
      return STANDARD_YOUTUBE_CATEGORIES;
    }

    if (target === 'trending') {
      if (youtubeApiPool.hasKeys()) {
        try {
          const vids = await youtubeApiPool.getTrendingVideos(regionCode, options.categoryId, maxResults);
          return vids.map(stripHeavyVideoFields);
        } catch {
          // fallback InnerTube trending query
        }
      }
      const it = await searchInnerTube({
        query: options.query || 'trending viral today',
        sort: 'views',
        maxResults,
        gl: regionCode,
      });
      return it.videos.map(stripHeavyVideoFields);
    }

    if (!options.query) {
      throw new Error('`query` is required unless target is "trending" or "categories".');
    }

    // Channel search
    if (target === 'channel') {
      let channels: LeanChannel[] = [];
      if (youtubeApiPool.hasKeys()) {
        try {
          const items = await youtubeApiPool.search({
            query: options.query,
            type: 'channel',
            maxResults: Math.min(50, maxResults * 2),
          });
          const ids = items.map((i) => i?.snippet?.channelId || i?.id?.channelId).filter(Boolean);
          const rawChannels = await youtubeApiPool.getChannelsBatch(ids);
          channels = rawChannels.map((c) => enrichChannelIntelligence(c));
        } catch {
          channels = [];
        }
      }
      if (channels.length === 0) {
        const it = await searchInnerTube({ query: options.query, type: 'channel', maxResults: maxResults * 2 });
        channels = it.channels.map((c) => enrichChannelIntelligence(c));
      }
      return filterAndSortChannels(channels, options).slice(0, maxResults);
    }

    // Playlist search
    if (target === 'playlist') {
      if (youtubeApiPool.hasKeys()) {
        try {
          const items = await youtubeApiPool.search({
            query: options.query,
            type: 'playlist',
            maxResults,
          });
          return items.map((i: any) => ({
            id: i?.id?.playlistId,
            url: `https://www.youtube.com/playlist?list=${i?.id?.playlistId}`,
            title: i?.snippet?.title,
            channelTitle: i?.snippet?.channelTitle,
            publishedAt: i?.snippet?.publishedAt,
          }));
        } catch {
          // fallback
        }
      }
      const it = await searchInnerTube({ query: options.query, type: 'playlist', maxResults });
      return it.playlists;
    }

    // Video or Short search
    let videos: LeanVideo[] = [];
    const apiOrder =
      options.sort === 'date'
        ? 'date'
        : options.sort === 'views'
          ? 'viewCount'
          : options.sort === 'rating'
            ? 'rating'
            : 'relevance';

    if (youtubeApiPool.hasKeys()) {
      try {
        const items = await youtubeApiPool.search({
          query: options.query,
          type: 'video',
          maxResults: Math.min(50, Math.max(maxResults, 20)),
          order: apiOrder,
          publishedAfter: options.publishedAfter,
          publishedBefore: options.publishedBefore,
          channelId: options.channelId,
          regionCode,
          videoDuration: target === 'short' ? 'short' : options.duration,
          videoCategoryId: options.categoryId,
        });
        const vIds = items.map((i) => i?.id?.videoId).filter(Boolean);
        videos = await youtubeApiPool.getVideosBatch(vIds);
      } catch {
        videos = [];
      }
    }

    if (videos.length === 0) {
      const it = await searchInnerTube({
        query: options.query,
        type: target === 'short' ? 'short' : 'video',
        sort: options.sort === 'views' ? 'views' : options.sort === 'date' ? 'date' : 'relevance',
        maxResults: Math.max(maxResults, 25),
        gl: regionCode,
      });
      videos = it.videos;
    }

    // Apply date filters if InnerTube was used
    if (options.publishedAfter) {
      const minT = new Date(options.publishedAfter).getTime();
      videos = videos.filter((v) => v.publishedAt && new Date(v.publishedAt).getTime() >= minT);
    }
    if (options.publishedBefore) {
      const maxT = new Date(options.publishedBefore).getTime();
      videos = videos.filter((v) => v.publishedAt && new Date(v.publishedAt).getTime() <= maxT);
    }
    if (target === 'short') {
      videos = videos.filter((v) => v.isShort || (v.durationSec !== undefined && v.durationSec <= 61));
    }

    if (options.uniqueChannels) {
      const seen = new Set<string>();
      videos = videos.filter((v) => {
        const key = v.channelId || v.channelTitle || v.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Optional channel-band filtering & ranking (Zubeid-style indie_priority / subscriber filters)
    const needsChannelEnrich =
      options.minSubs !== undefined ||
      options.maxSubs !== undefined ||
      options.creatorOnly ||
      ['indie_priority', 'subscribers_asc', 'subscribers_desc', 'recent_activity'].includes(options.sort || '');

    if (needsChannelEnrich && videos.length > 0) {
      const chIds = Array.from(new Set(videos.map((v) => v.channelId).filter((id): id is string => Boolean(id))));
      const chMap = await this.getChannelsMap(chIds);
      videos = videos.filter((v) => {
        const ch = v.channelId ? chMap.get(v.channelId) : undefined;
        if (!ch) return true;
        if (options.minSubs !== undefined && (ch.subscribers ?? 0) < options.minSubs) return false;
        if (options.maxSubs !== undefined && (ch.subscribers ?? 0) > options.maxSubs) return false;
        if (options.creatorOnly && ch.classification?.type !== 'creator') return false;
        return true;
      });

      if (options.sort === 'indie_priority' || options.sort === 'subscribers_asc') {
        videos.sort(
          (a, b) =>
            (chMap.get(a.channelId || '')?.subscribers ?? Number.MAX_SAFE_INTEGER) -
            (chMap.get(b.channelId || '')?.subscribers ?? Number.MAX_SAFE_INTEGER)
        );
      } else if (options.sort === 'subscribers_desc') {
        videos.sort(
          (a, b) =>
            (chMap.get(b.channelId || '')?.subscribers ?? 0) -
            (chMap.get(a.channelId || '')?.subscribers ?? 0)
        );
      }
    } else if (options.sort === 'views') {
      videos.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    } else if (options.sort === 'date' || options.sort === 'recent_activity') {
      videos.sort(
        (a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime()
      );
    }

    return videos.slice(0, maxResults).map(stripHeavyVideoFields);
  }

  /**
   * Fetch rich Channel intelligence + optional tabs (videos, shorts, top_videos, playlists, rss).
   */
  async getChannels(options: {
    channels: string[];
    include?: Array<'stats' | 'videos' | 'shorts' | 'top_videos' | 'playlists' | 'rss'>;
    maxItems?: number;
  }): Promise<
    Array<{
      channel: LeanChannel;
      videos?: LeanVideo[];
      shorts?: LeanVideo[];
      topVideos?: LeanVideo[];
      playlists?: LeanPlaylist[];
      rss?: LeanVideo[];
    }>
  > {
    const includeSet = new Set(options.include || ['stats']);
    const maxItems = Math.min(50, Math.max(1, options.maxItems || 15));

    return mapConcurrent(options.channels, 5, async (input) => {
      const ref = parseChannelRef(input);
      let channelId: string;
      let baseChannel: LeanChannel | null = null;

      if (ref.kind === 'id') {
        channelId = ref.value;
      } else if (ref.kind === 'handle' && youtubeApiPool.hasKeys()) {
        baseChannel = await youtubeApiPool.getChannelByHandle(ref.value).catch(() => null);
        channelId = baseChannel?.id || (await resolveChannelIdInnerTube(input));
      } else {
        channelId = await resolveChannelIdInnerTube(input);
      }

      if (!baseChannel && youtubeApiPool.hasKeys()) {
        const batch = await youtubeApiPool.getChannelsBatch([channelId]).catch(() => []);
        baseChannel = batch[0] || null;
      }

      const needItVideos = includeSet.has('videos') || includeSet.has('top_videos') || !baseChannel;
      const needItShorts = includeSet.has('shorts');
      const needItPlaylists = includeSet.has('playlists');

      const [itBrowse, rssItems] = await Promise.all([
        needItVideos || needItShorts || needItPlaylists
          ? browseChannelInnerTube(channelId, {
              includeVideos: needItVideos,
              includeShorts: needItShorts,
              includePlaylists: needItPlaylists,
              maxResults: Math.max(maxItems, 25),
            }).catch(() => null)
          : Promise.resolve(null),
        includeSet.has('rss') ? fetchChannelRss(channelId).catch(() => []) : Promise.resolve(undefined),
      ]);

      const mergedChannel = enrichChannelIntelligence(
        {
          ...(itBrowse?.channel || {
            id: channelId,
            title: channelId,
            url: `https://www.youtube.com/channel/${channelId}`,
          }),
          ...(baseChannel || {}),
          handle: baseChannel?.handle || itBrowse?.channel?.handle,
          latestUploadAt: itBrowse?.channel?.latestUploadAt || rssItems?.[0]?.publishedAt,
        },
        itBrowse?.videos,
        itBrowse?.shorts
      );

      const out: {
        channel: LeanChannel;
        videos?: LeanVideo[];
        shorts?: LeanVideo[];
        topVideos?: LeanVideo[];
        playlists?: LeanPlaylist[];
        rss?: LeanVideo[];
      } = { channel: mergedChannel };

      if (includeSet.has('videos') && itBrowse?.videos) {
        out.videos = itBrowse.videos.slice(0, maxItems).map(stripHeavyVideoFields);
      }
      if (includeSet.has('shorts') && itBrowse?.shorts) {
        out.shorts = itBrowse.shorts.slice(0, maxItems).map(stripHeavyVideoFields);
      }
      if (includeSet.has('top_videos')) {
        const pool = [...(itBrowse?.videos || []), ...(itBrowse?.shorts || [])];
        out.topVideos = pool
          .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
          .slice(0, maxItems)
          .map(stripHeavyVideoFields);
      }
      if (includeSet.has('playlists') && itBrowse?.playlists) {
        out.playlists = itBrowse.playlists.slice(0, maxItems);
      }
      if (includeSet.has('rss') && rssItems) {
        out.rss = rssItems.slice(0, maxItems).map(stripHeavyVideoFields);
      }

      return out;
    });
  }

  async getChannelsMap(channelIds: string[]): Promise<Map<string, LeanChannel>> {
    const unique = Array.from(new Set(channelIds.filter(Boolean)));
    const map = new Map<string, LeanChannel>();
    if (unique.length === 0) return map;

    if (youtubeApiPool.hasKeys()) {
      try {
        const batch = await youtubeApiPool.getChannelsBatch(unique);
        for (const c of batch) {
          map.set(c.id, enrichChannelIntelligence(c));
        }
      } catch {
        // fallback to InnerTube below
      }
    }

    const missing = unique.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const browsed = await mapConcurrent(missing, 6, async (id) => {
        try {
          const b = await browseChannelInnerTube(id);
          return enrichChannelIntelligence(b.channel);
        } catch {
          return null;
        }
      });
      for (const c of browsed) {
        if (c) map.set(c.id, c);
      }
    }

    return map;
  }

  /**
   * Multi-mode Transcript Engine:
   * Supports batching, `key_segments` (Intro Hook + Outro CTA), `full`, `timestamped`, `chapters`, `search`, `srt`, `vtt`,
   * instant translation (`translateTo`), SponsorBlock sponsor-stripping (`stripSponsors`), and `saveToFile`!
   */
  async getTranscripts(options: {
    videos: string[];
    mode?: 'key_segments' | 'full' | 'timestamped' | 'chapters' | 'search' | 'srt' | 'vtt';
    lang?: string;
    translateTo?: string;
    query?: string;
    stripSponsors?: boolean;
    saveToFile?: string;
  }): Promise<TranscriptResult[]> {
    const mode = options.mode || 'key_segments';
    const lang = options.lang || process.env.CTDO_DEFAULT_LANG || 'en';

    return mapConcurrent(options.videos, 5, async (input) => {
      const videoId = extractVideoId(input);
      const [rawTx, sbData, videoMeta] = await Promise.all([
        fetchInnerTubeTranscript(videoId, lang, options.translateTo),
        options.stripSponsors ? fetchSponsorBlock(videoId) : Promise.resolve({ segments: [] }),
        mode === 'chapters' ? fetchInnerTubeVideoFull(videoId, lang).catch(() => null) : Promise.resolve(null),
      ]);

      let segments = rawTx.segments;
      if (options.stripSponsors && sbData.segments.length > 0) {
        const sponsorRanges = sbData.segments.filter((s) =>
          ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'].includes(s.category)
        );
        segments = segments.filter(
          (seg) => !sponsorRanges.some((r) => seg.startSec >= r.startSec && seg.startSec <= r.endSec)
        );
      }

      const lastSeg = segments[segments.length - 1];
      const totalDurationSec = lastSeg ? Math.round(lastSeg.startSec + lastSeg.durationSec) : 0;
      const fullJoined = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      const wordCount = fullJoined ? fullJoined.split(/\s+/).length : 0;
      const estimatedSpeakingWpm =
        totalDurationSec > 15 ? Math.round((wordCount / totalDurationSec) * 60) : undefined;

      const base: TranscriptResult = {
        videoId,
        language: rawTx.language,
        translatedTo: rawTx.translatedTo,
        availableLanguages: rawTx.availableLanguages,
        segmentCount: segments.length,
        totalDurationSec,
        wordCount,
        estimatedSpeakingWpm,
      };

      if (segments.length === 0) {
        return base;
      }

      if (mode === 'key_segments') {
        const hook = segments
          .filter((s) => s.startSec <= 45)
          .map((s) => s.text)
          .join(' ')
          .trim();
        const outroStart = Math.max(45, totalDurationSec - 35);
        const outro = segments
          .filter((s) => s.startSec >= outroStart)
          .map((s) => s.text)
          .join(' ')
          .trim();
        base.hook = hook;
        base.outro = outro || undefined;
      } else if (mode === 'full') {
        base.fullText = fullJoined;
      } else if (mode === 'timestamped') {
        base.segments = segments;
      } else if (mode === 'chapters') {
        const chapters = videoMeta?.video.chapters || [];
        if (chapters.length > 0) {
          base.chapterSections = chapters.map((ch, idx) => {
            const nextStart = chapters[idx + 1]?.startSec ?? Number.MAX_SAFE_INTEGER;
            const text = segments
              .filter((s) => s.startSec >= ch.startSec && s.startSec < nextStart)
              .map((s) => s.text)
              .join(' ')
              .trim();
            return {
              chapter: ch.title,
              startSec: ch.startSec,
              timestamp: ch.timestamp,
              text,
            };
          });
        } else {
          base.fullText = fullJoined;
        }
      } else if (mode === 'search') {
        const q = (options.query || '').toLowerCase().trim();
        base.matches = q
          ? segments
              .filter((s) => s.text.toLowerCase().includes(q))
              .slice(0, 40)
              .map((s) => ({
                timestamp: s.timestamp,
                startSec: Math.floor(s.startSec),
                deepLink: `https://youtu.be/${videoId}?t=${Math.floor(s.startSec)}s`,
                text: s.text,
              }))
          : [];
      } else if (mode === 'srt' || mode === 'vtt') {
        base.fullText = formatSubtitlesFile(segments, mode);
      }

      if (options.saveToFile && options.videos.length === 1) {
        const contentToSave =
          mode === 'srt' || mode === 'vtt'
            ? formatSubtitlesFile(segments, mode)
            : mode === 'timestamped'
              ? segments.map((s) => `[${s.timestamp}] ${s.text}`).join('\n')
              : fullJoined;
        await writeFile(options.saveToFile, contentToSave, 'utf8');
        base.savedFilePath = options.saveToFile;
        // Omit giant inline text when saved directly to file to conserve 99% context tokens!
        delete base.fullText;
        delete base.segments;
      }

      return base;
    });
  }

  async getComments(options: {
    video: string;
    maxResults?: number;
    sortBy?: 'top' | 'newest';
    includeReplies?: boolean;
  }): Promise<LeanComment[]> {
    const videoId = extractVideoId(options.video);
    const maxResults = Math.min(100, Math.max(1, options.maxResults || 30));

    if (youtubeApiPool.hasKeys()) {
      try {
        return await youtubeApiPool.getComments(
          videoId,
          maxResults,
          options.sortBy === 'newest' ? 'time' : 'relevance',
          Boolean(options.includeReplies)
        );
      } catch {
        // fallback to InnerTube
      }
    }

    return fetchCommentsInnerTube(videoId, maxResults, options.sortBy || 'top');
  }

  async getPlaylist(playlistInput: string, maxResults = 50): Promise<LeanPlaylist> {
    const playlistId = extractPlaylistId(playlistInput);
    if (youtubeApiPool.hasKeys()) {
      try {
        return await youtubeApiPool.getPlaylistWithItems(playlistId, maxResults);
      } catch {
        // fallback
      }
    }
    return fetchPlaylistInnerTube(playlistId, maxResults);
  }
}

function stripHeavyVideoFields(v: LeanVideo): LeanVideo {
  const copy = { ...v };
  if (copy.description && copy.description.length > 160) {
    copy.description = `${copy.description.slice(0, 160)}...`;
  }
  delete copy.tags;
  delete copy.thumbnails;
  return copy;
}

function filterAndSortChannels(
  channels: LeanChannel[],
  options: {
    minSubs?: number;
    maxSubs?: number;
    creatorOnly?: boolean;
    sort?: string;
  }
): LeanChannel[] {
  const filtered = channels.filter((c) => {
    if (options.minSubs !== undefined && (c.subscribers ?? 0) < options.minSubs) return false;
    if (options.maxSubs !== undefined && (c.subscribers ?? 0) > options.maxSubs) return false;
    if (options.creatorOnly && c.classification?.type !== 'creator') return false;
    return true;
  });

  if (options.sort === 'subscribers_desc') {
    filtered.sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0));
  } else if (options.sort === 'subscribers_asc' || options.sort === 'indie_priority') {
    filtered.sort((a, b) => (a.subscribers ?? 0) - (b.subscribers ?? 0));
  }
  return filtered;
}

export function formatSubtitlesFile(segments: Array<{ startSec: number; durationSec: number; text: string }>, fmt: 'srt' | 'vtt'): string {
  const toTimecode = (sec: number, sep: ',' | '.') => {
    const ms = Math.floor((sec % 1) * 1000);
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
  };

  if (fmt === 'vtt') {
    const blocks = segments.map(
      (seg) => `${toTimecode(seg.startSec, '.')} --> ${toTimecode(seg.startSec + seg.durationSec, '.')}\n${seg.text}`
    );
    return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
  }

  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${toTimecode(seg.startSec, ',')} --> ${toTimecode(seg.startSec + seg.durationSec, ',')}\n${seg.text}`
    )
    .join('\n\n');
}

const STANDARD_YOUTUBE_CATEGORIES = [
  { id: '1', title: 'Film & Animation' },
  { id: '2', title: 'Autos & Vehicles' },
  { id: '10', title: 'Music' },
  { id: '15', title: 'Pets & Animals' },
  { id: '17', title: 'Sports' },
  { id: '19', title: 'Travel & Events' },
  { id: '20', title: 'Gaming' },
  { id: '22', title: 'People & Blogs' },
  { id: '23', title: 'Comedy' },
  { id: '24', title: 'Entertainment' },
  { id: '25', title: 'News & Politics' },
  { id: '26', title: 'Howto & Style' },
  { id: '27', title: 'Education' },
  { id: '28', title: 'Science & Technology' },
  { id: '29', title: 'Nonprofits & Activism' },
];

export const hybridYouTube = new HybridYouTubeClient();
