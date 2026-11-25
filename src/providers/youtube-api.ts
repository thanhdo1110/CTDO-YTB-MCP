import { CACHE_TTL, globalCache } from '../core/cache.js';
import type { LeanChannel, LeanComment, LeanPlaylist, LeanVideo } from '../core/types.js';
import {
  calcViewsPerDay,
  extractDescriptionChapters,
  formatTimestamp,
  parseDurationSeconds,
} from '../core/utils.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'dailyLimitExceededUnreg',
  'userRateLimitExceeded',
  'rateLimitExceeded',
]);

interface KeySlot {
  masked: string;
  key: string;
  quotaUsed: number;
  exhaustedAt?: number;
  requests: number;
}

/**
 * Ultra-lightweight YouTube Data API v3 Multi-Key Pool using native Node fetch (0 bytes of `googleapis` SDK bloat!).
 * Supports automatic failover across unlimited keys via YOUTUBE_API_KEYS="k1,k2,k3" or YOUTUBE_API_KEY, YOUTUBE_API_KEY2...
 */
export class YouTubeApiPool {
  private slots: KeySlot[] = [];
  private initialized = false;

  private init() {
    if (this.initialized) return;
    this.initialized = true;

    const rawKeys = [
      ...(process.env.YOUTUBE_API_KEYS || '').split(','),
      process.env.YOUTUBE_API_KEY || '',
      process.env.YOUTUBE_API_KEY2 || '',
      process.env.YOUTUBE_API_KEY3 || '',
      process.env.YOUTUBE_API_KEY4 || '',
    ]
      .map((k) => k.trim())
      .filter(Boolean);

    const unique = Array.from(new Set(rawKeys));
    this.slots = unique.map((key) => ({
      key,
      masked: key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '***',
      quotaUsed: 0,
      requests: 0,
    }));
  }

  hasKeys(): boolean {
    this.init();
    return this.slots.some((s) => !s.exhaustedAt || Date.now() - s.exhaustedAt > 3600_000);
  }

  getStatus() {
    this.init();
    return {
      configuredKeys: this.slots.length,
      activeKeys: this.slots.filter((s) => !s.exhaustedAt).length,
      totalEstimatedQuotaUsed: this.slots.reduce((sum, s) => sum + s.quotaUsed, 0),
      keys: this.slots.map((s) => ({
        key: s.masked,
        requests: s.requests,
        estimatedQuotaUsed: s.quotaUsed,
        exhausted: Boolean(s.exhaustedAt),
      })),
    };
  }

  async request<T = any>(
    endpoint: string,
    params: Record<string, string | number | boolean | string[] | undefined>,
    quotaCost = 1
  ): Promise<T> {
    this.init();
    if (this.slots.length === 0) {
      throw new Error('NO_YOUTUBE_API_KEY');
    }

    const now = Date.now();
    // Reset exhausted flag after 1 hour in case Pacific midnight passed
    for (const s of this.slots) {
      if (s.exhaustedAt && now - s.exhaustedAt > 3600_000) {
        s.exhaustedAt = undefined;
      }
    }

    const candidates = [
      ...this.slots.filter((s) => !s.exhaustedAt),
      ...this.slots.filter((s) => Boolean(s.exhaustedAt)),
    ];

    let lastErr: Error | null = null;

    for (const slot of candidates) {
      const url = new URL(`${API_BASE}/${endpoint}`);
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === '') continue;
        if (Array.isArray(v)) {
          url.searchParams.set(k, v.join(','));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
      url.searchParams.set('key', slot.key);

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });

      slot.requests++;
      slot.quotaUsed += quotaCost;

      if (res.ok) {
        return (await res.json()) as T;
      }

      const errBody = (await res.json().catch(() => ({}))) as any;
      const reason = errBody?.error?.errors?.[0]?.reason || '';
      const message = errBody?.error?.message || `HTTP ${res.status}`;

      if (QUOTA_REASONS.has(reason) || /quota|daily limit|rate limit/i.test(message)) {
        slot.exhaustedAt = Date.now();
        lastErr = new Error(`QUOTA_EXHAUSTED: ${message}`);
        continue;
      }

      throw new Error(`YouTube API (${endpoint}): ${message}`);
    }

    throw lastErr || new Error('All YouTube API keys exhausted');
  }

  /**
   * Batch fetch up to N videos in chunks of 50 (only 1 quota unit per 50 videos!).
   */
  async getVideosBatch(videoIds: string[]): Promise<LeanVideo[]> {
    if (videoIds.length === 0) return [];
    const results: LeanVideo[] = [];

    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const data = await globalCache.getOrCompute(
        'api_videos_batch',
        chunk,
        CACHE_TTL.VIDEO,
        () =>
          this.request(
            'videos',
            {
              part: ['snippet', 'statistics', 'contentDetails', 'liveStreamingDetails'],
              id: chunk,
              maxResults: 50,
            },
            1
          ),
        1
      );

      for (const item of data?.items || []) {
        results.push(mapApiVideo(item));
      }
    }
    return results;
  }

  /**
   * Batch fetch up to N channels in chunks of 50 (only 1 quota unit per 50 channels!).
   */
  async getChannelsBatch(channelIds: string[]): Promise<LeanChannel[]> {
    if (channelIds.length === 0) return [];
    const results: LeanChannel[] = [];

    for (let i = 0; i < channelIds.length; i += 50) {
      const chunk = channelIds.slice(i, i + 50);
      const data = await globalCache.getOrCompute(
        'api_channels_batch',
        chunk,
        CACHE_TTL.CHANNEL,
        () =>
          this.request(
            'channels',
            {
              part: ['snippet', 'statistics', 'contentDetails', 'brandingSettings'],
              id: chunk,
              maxResults: 50,
            },
            1
          ),
        1
      );

      for (const item of data?.items || []) {
        results.push(mapApiChannel(item));
      }
    }
    return results;
  }

  async getChannelByHandle(handle: string): Promise<LeanChannel | null> {
    const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
    const data = await globalCache.getOrCompute(
      'api_channel_handle',
      cleanHandle,
      CACHE_TTL.CHANNEL,
      () =>
        this.request(
          'channels',
          {
            part: ['snippet', 'statistics', 'contentDetails', 'brandingSettings'],
            forHandle: cleanHandle,
          },
          1
        ),
      1
    );
    const item = data?.items?.[0];
    return item ? mapApiChannel(item) : null;
  }

  async search(options: {
    query?: string;
    type?: 'video' | 'channel' | 'playlist';
    maxResults?: number;
    order?: 'relevance' | 'date' | 'viewCount' | 'rating';
    publishedAfter?: string;
    publishedBefore?: string;
    channelId?: string;
    regionCode?: string;
    relevanceLanguage?: string;
    videoDuration?: 'any' | 'short' | 'medium' | 'long';
    videoCategoryId?: string;
  }): Promise<any[]> {
    const maxResults = Math.min(50, Math.max(1, options.maxResults || 15));
    const data = await globalCache.getOrCompute(
      'api_search',
      { ...options, maxResults },
      CACHE_TTL.SEARCH,
      () =>
        this.request(
          'search',
          {
            part: ['snippet'],
            q: options.query,
            type: options.type || 'video',
            maxResults,
            order: options.order || 'relevance',
            publishedAfter: options.publishedAfter,
            publishedBefore: options.publishedBefore,
            channelId: options.channelId,
            regionCode: options.regionCode,
            relevanceLanguage: options.relevanceLanguage,
            videoDuration: options.type === 'video' ? options.videoDuration : undefined,
            videoCategoryId: options.type === 'video' ? options.videoCategoryId : undefined,
          },
          100
        ),
      100
    );
    return data?.items || [];
  }

  async getTrendingVideos(regionCode = 'US', categoryId?: string, maxResults = 20): Promise<LeanVideo[]> {
    const data = await globalCache.getOrCompute(
      'api_trending',
      { regionCode, categoryId, maxResults },
      CACHE_TTL.SEARCH,
      () =>
        this.request(
          'videos',
          {
            part: ['snippet', 'statistics', 'contentDetails'],
            chart: 'mostPopular',
            regionCode,
            videoCategoryId: categoryId,
            maxResults: Math.min(50, maxResults),
          },
          1
        ),
      1
    );
    return (data?.items || []).map(mapApiVideo);
  }

  async getVideoCategories(regionCode = 'US'): Promise<Array<{ id: string; title: string }>> {
    const data = await globalCache.getOrCompute(
      'api_categories',
      regionCode,
      7 * 24 * 60 * 60 * 1000,
      () =>
        this.request(
          'videoCategories',
          {
            part: ['snippet'],
            regionCode,
          },
          1
        ),
      1
    );
    return (data?.items || [])
      .filter((c: any) => c?.snippet?.assignable !== false)
      .map((c: any) => ({ id: String(c.id), title: String(c.snippet?.title || '') }));
  }

  async getPlaylistWithItems(playlistId: string, maxResults = 50): Promise<LeanPlaylist> {
    const [plData, itemsData] = await Promise.all([
      globalCache.getOrCompute('api_pl', playlistId, CACHE_TTL.VIDEO, () =>
        this.request('playlists', { part: ['snippet', 'contentDetails'], id: playlistId }, 1)
      ),
      globalCache.getOrCompute('api_pl_items', { playlistId, maxResults }, CACHE_TTL.SEARCH, () =>
        this.request(
          'playlistItems',
          {
            part: ['snippet', 'contentDetails'],
            playlistId,
            maxResults: Math.min(50, maxResults),
          },
          1
        )
      ),
    ]);

    const pl = plData?.items?.[0];
    const videoIds = (itemsData?.items || [])
      .map((it: any) => it?.contentDetails?.videoId || it?.snippet?.resourceId?.videoId)
      .filter(Boolean);

    const enrichedVideos = videoIds.length > 0 ? await this.getVideosBatch(videoIds) : [];

    return {
      id: playlistId,
      url: `https://www.youtube.com/playlist?list=${playlistId}`,
      title: pl?.snippet?.title || playlistId,
      channelId: pl?.snippet?.channelId,
      channelTitle: pl?.snippet?.channelTitle,
      description: pl?.snippet?.description || undefined,
      itemCount: pl?.contentDetails?.itemCount ?? enrichedVideos.length,
      publishedAt: pl?.snippet?.publishedAt,
      items: enrichedVideos,
    };
  }

  async getComments(
    videoId: string,
    maxResults = 30,
    order: 'relevance' | 'time' = 'relevance',
    includeReplies = false
  ): Promise<LeanComment[]> {
    const parts = includeReplies ? ['snippet', 'replies'] : ['snippet'];
    const data = await globalCache.getOrCompute(
      'api_comments',
      { videoId, maxResults, order, includeReplies },
      CACHE_TTL.COMMENTS,
      () =>
        this.request(
          'commentThreads',
          {
            part: parts,
            videoId,
            maxResults: Math.min(100, maxResults),
            order,
            textFormat: 'plainText',
          },
          1
        ),
      1
    );

    return (data?.items || []).map((item: any) => {
      const top = item?.snippet?.topLevelComment?.snippet || {};
      const repliesRaw = item?.replies?.comments || [];
      return {
        id: String(item.id),
        author: String(top.authorDisplayName || 'User'),
        authorChannelId: top.authorChannelId?.value,
        text: String(top.textDisplay || top.textOriginal || '').trim(),
        likes: Number(top.likeCount || 0),
        replyCount: Number(item?.snippet?.totalReplyCount || 0),
        publishedAt: top.publishedAt,
        replies: includeReplies
          ? repliesRaw.slice(0, 5).map((r: any) => ({
              id: String(r.id),
              author: String(r.snippet?.authorDisplayName || 'User'),
              text: String(r.snippet?.textDisplay || '').trim(),
              likes: Number(r.snippet?.likeCount || 0),
              publishedAt: r.snippet?.publishedAt,
            }))
          : undefined,
      };
    });
  }
}

function mapApiVideo(item: any): LeanVideo {
  const id = String(item.id?.videoId || item.id);
  const sn = item.snippet || {};
  const st = item.statistics || {};
  const cd = item.contentDetails || {};

  const durationSec = parseDurationSeconds(cd.duration);
  const views = st.viewCount !== undefined ? Number(st.viewCount) : undefined;
  const likes = st.likeCount !== undefined ? Number(st.likeCount) : undefined;
  const comments = st.commentCount !== undefined ? Number(st.commentCount) : undefined;
  const publishedAt = sn.publishedAt;
  const viewsPerDay = calcViewsPerDay(views, publishedAt);
  const likeToViewPct =
    views && views > 0 && likes !== undefined ? Math.round((likes / views) * 10000) / 100 : undefined;
  const commentToViewPct =
    views && views > 0 && comments !== undefined ? Math.round((comments / views) * 10000) / 100 : undefined;

  const isShort = durationSec !== undefined && durationSec > 0 && durationSec <= 60;
  const chapters = extractDescriptionChapters(sn.description);

  return {
    id,
    url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    title: sn.title || id,
    channelId: sn.channelId,
    channelTitle: sn.channelTitle,
    publishedAt,
    durationSec,
    duration: durationSec !== undefined ? formatTimestamp(durationSec) : undefined,
    isShort,
    isLive: sn.liveBroadcastContent === 'live',
    views,
    likes,
    comments,
    likeToViewPct,
    commentToViewPct,
    viewsPerDay,
    categoryId: sn.categoryId,
    language: sn.defaultAudioLanguage || sn.defaultLanguage,
    description: sn.description || undefined,
    tags: Array.isArray(sn.tags) ? sn.tags : undefined,
    thumbnails: {
      default: sn.thumbnails?.default?.url || `https://i.ytimg.com/vi/${id}/default.jpg`,
      hq: sn.thumbnails?.high?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      maxres: sn.thumbnails?.maxres?.url || `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    },
    chapters: chapters.length > 0 ? chapters : undefined,
    source: 'api',
  };
}

function mapApiChannel(item: any): LeanChannel {
  const id = String(item.id);
  const sn = item.snippet || {};
  const st = item.statistics || {};
  const br = item.brandingSettings?.channel || {};

  const subscribers = st.subscriberCount !== undefined ? Number(st.subscriberCount) : undefined;
  const totalViews = st.viewCount !== undefined ? Number(st.viewCount) : undefined;
  const videoCount = st.videoCount !== undefined ? Number(st.videoCount) : undefined;
  const handle = sn.customUrl?.startsWith('@') ? sn.customUrl : sn.customUrl ? `@${sn.customUrl}` : undefined;

  return {
    id,
    title: sn.title || id,
    handle,
    url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${id}`,
    description: br.description || sn.description || undefined,
    country: br.country || sn.country || undefined,
    language: br.defaultLanguage || sn.defaultLanguage || undefined,
    joinedAt: sn.publishedAt || undefined,
    subscribers,
    totalViews,
    videoCount,
    avgViewsPerVideo:
      totalViews !== undefined && videoCount && videoCount > 0
        ? Math.round(totalViews / videoCount)
        : undefined,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || (id.startsWith('UC') ? `UU${id.slice(2)}` : undefined),
    avatarUrl: sn.thumbnails?.high?.url || sn.thumbnails?.default?.url,
    bannerUrl: item.brandingSettings?.image?.bannerExternalUrl,
    source: 'api',
  };
}

export const youtubeApiPool = new YouTubeApiPool();
