import { CACHE_TTL, globalCache } from '../core/cache.js';
import type {
  LeanChannel,
  LeanVideo,
  OutlierChannel,
  OutlierVideo,
  TrendingFormat,
} from '../core/types.js';
import { mapConcurrent } from '../core/utils.js';
import { hybridYouTube } from '../providers/hybrid-client.js';
import { browseChannelInnerTube, fetchInnerTubeVideoFull } from '../providers/innertube.js';

/**
 * TubeLab-grade Outlier Video Finder:
 * Surfaces videos that massively outperform their channel's subscriber baseline (`views / subscribers`).
 * Works 100% free via Hybrid (API v3 or Zero-Key InnerTube)!
 */
export async function searchOutlierVideos(options: {
  query: string;
  minOutlierScore?: number;
  maxSubs?: number;
  minSubs?: number;
  publishedAfter?: string;
  videoType?: 'any' | 'long' | 'short';
  maxResults?: number;
  sortBy?: 'outlier_score' | 'views_per_day' | 'views';
}): Promise<OutlierVideo[]> {
  const minOutlierScore = options.minOutlierScore ?? 1.5;
  const maxResults = Math.min(40, Math.max(1, options.maxResults || 15));

  return globalCache.getOrCompute(
    'outliers_search',
    { ...options, minOutlierScore, maxResults },
    CACHE_TTL.OUTLIERS,
    async () => {
      const target = options.videoType === 'short' ? 'short' : 'video';
      const [relevanceBatch, viewsBatch] = await Promise.all([
        hybridYouTube.search({
          query: options.query,
          target,
          maxResults: 30,
          sort: 'relevance',
          publishedAfter: options.publishedAfter,
          duration: options.videoType === 'long' ? 'medium' : undefined,
        }) as Promise<LeanVideo[]>,
        hybridYouTube.search({
          query: options.query,
          target,
          maxResults: 25,
          sort: 'views',
          publishedAfter: options.publishedAfter,
        }) as Promise<LeanVideo[]>,
      ]);

      // Deduplicate candidate videos
      const uniqueMap = new Map<string, LeanVideo>();
      for (const v of [...(relevanceBatch || []), ...(viewsBatch || [])]) {
        if (!v?.id) continue;
        if (options.videoType === 'long' && v.isShort) continue;
        if (options.videoType === 'short' && v.isShort === false && (v.durationSec ?? 0) > 65) continue;
        uniqueMap.set(v.id, v);
      }

      const candidates = Array.from(uniqueMap.values());
      // Fill missing channelIds for Shorts/collab items (up to 10) so subscriber counts are accurate
      const missingChVids = candidates.filter((v) => !v.channelId).slice(0, 10);
      if (missingChVids.length > 0) {
        await mapConcurrent(missingChVids, 5, async (v) => {
          const full = await fetchInnerTubeVideoFull(v.id).catch(() => null);
          if (full?.video.channelId) {
            v.channelId = full.video.channelId;
            v.channelTitle = v.channelTitle || full.video.channelTitle;
          }
        });
      }

      const channelIds = Array.from(
        new Set(candidates.map((v) => v.channelId).filter((id): id is string => Boolean(id)))
      );

      const channelMap = await hybridYouTube.getChannelsMap(channelIds);
      const outliers: OutlierVideo[] = [];

      for (const v of candidates) {
        const ch = v.channelId ? channelMap.get(v.channelId) : undefined;
        const subs = ch?.subscribers ?? 0;
        if (subs <= 0) continue; // Require verified subscriber baseline for accurate outlier ratio
        if (options.minSubs !== undefined && subs < options.minSubs) continue;
        if (options.maxSubs !== undefined && subs > options.maxSubs) continue;

        const views = v.views ?? 0;
        if (views <= 0) continue;

        const baseline = Math.max(subs, 100);
        const outlierScore = Math.round((views / baseline) * 100) / 100;
        if (outlierScore < minOutlierScore) continue;

        const engagementScore =
          Math.round(((v.likeToViewPct ?? 3) * 0.7 + (v.commentToViewPct ?? 0.2) * 3) * 100) / 100;

        outliers.push({
          ...v,
          channelHandle: v.channelHandle || ch?.handle,
          channelSubscribers: subs,
          outlierScore,
          engagementScore,
        });
      }

      const sortMode = options.sortBy || 'outlier_score';
      outliers.sort((a, b) => {
        if (sortMode === 'views_per_day') return (b.viewsPerDay ?? 0) - (a.viewsPerDay ?? 0);
        if (sortMode === 'views') return (b.views ?? 0) - (a.views ?? 0);
        return b.outlierScore - a.outlierScore;
      });

      return outliers.slice(0, maxResults);
    }
  );
}

/**
 * TubeLab `search_related_channels` equivalent:
 * Discovers similar/competitor channels around a seed channel using Watch-Next co-visitation graph + topic queries!
 */
export async function findRelatedChannels(
  seedChannelInput: string,
  maxResults = 12
): Promise<LeanChannel[]> {
  return globalCache.getOrCompute(
    'related_channels',
    { seedChannelInput, maxResults },
    CACHE_TTL.OUTLIERS,
    async () => {
      const [seedInfo] = await hybridYouTube.getChannels({
        channels: [seedChannelInput],
        include: ['stats', 'videos'],
        maxItems: 8,
      });

      if (!seedInfo) return [];
      const seedId = seedInfo.channel.id;
      const seedVideos = seedInfo.videos || [];

      const candidateChannelIds = new Map<string, number>(); // channelId -> co-occurrence weight

      // 1. Harvest Watch-Next recommendations from top 3 recent seed videos (YouTube's own collaborative filtering graph!)
      const sampleVids = seedVideos.slice(0, 3);
      await mapConcurrent(sampleVids, 3, async (sv) => {
        const full = await fetchInnerTubeVideoFull(sv.id).catch(() => null);
        for (const rel of full?.relatedVideos || []) {
          if (rel.channelId && rel.channelId !== seedId) {
            candidateChannelIds.set(rel.channelId, (candidateChannelIds.get(rel.channelId) || 0) + 3);
          }
        }
      });

      // 2. Extract core niche phrase from seed channel's video titles + description
      const nicheQuery = deriveChannelTopicQuery(seedInfo.channel, seedVideos);
      if (nicheQuery) {
        const topicVideos = (await hybridYouTube.search({
          query: nicheQuery,
          target: 'video',
          maxResults: 25,
          uniqueChannels: true,
        })) as LeanVideo[];

        for (const tv of topicVideos) {
          if (tv.channelId && tv.channelId !== seedId) {
            candidateChannelIds.set(tv.channelId, (candidateChannelIds.get(tv.channelId) || 0) + 1);
          }
        }
      }

      const rankedIds = Array.from(candidateChannelIds.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxResults + 6)
        .map(([id]) => id);

      const channelMap = await hybridYouTube.getChannelsMap(rankedIds);
      return rankedIds
        .map((id) => channelMap.get(id))
        .filter((c): c is LeanChannel => Boolean(c))
        .slice(0, maxResults);
    }
  );
}

/**
 * TubeLab `search_related_outliers` equivalent:
 * Finds similar channels to `seedChannel`, scans their recent videos, and surfaces their biggest viral outliers!
 */
export async function searchRelatedOutliers(
  seedChannelInput: string,
  minOutlierScore = 1.5,
  maxResults = 15
): Promise<{ relatedChannelsScanned: number; outliers: OutlierVideo[] }> {
  const related = await findRelatedChannels(seedChannelInput, 8);
  const allOutliers: OutlierVideo[] = [];

  await mapConcurrent(related, 4, async (ch) => {
    const browsed = await browseChannelInnerTube(ch.id, {
      includeVideos: true,
      maxResults: 15,
    }).catch(() => null);

    const vids = browsed?.videos || [];
    if (vids.length === 0) return;

    const sortedViews = vids.map((v) => v.views ?? 0).sort((a, b) => a - b);
    const medianViews = sortedViews[Math.floor(sortedViews.length / 2)] || 1;
    const subs = Math.max(ch.subscribers ?? 0, 250);

    for (const v of vids) {
      const views = v.views ?? 0;
      const outlierScore = Math.round((views / subs) * 100) / 100;
      const vsMedian = Math.round((views / Math.max(medianViews, 100)) * 100) / 100;

      if (outlierScore >= minOutlierScore || vsMedian >= 2.5) {
        allOutliers.push({
          ...v,
          channelId: ch.id,
          channelTitle: ch.title,
          channelHandle: ch.handle,
          channelSubscribers: ch.subscribers ?? 0,
          outlierScore,
          channelMedianViews: medianViews,
          vsChannelMedianScore: vsMedian,
          engagementScore: v.likeToViewPct ?? 0,
        });
      }
    }
  });

  allOutliers.sort((a, b) => b.outlierScore - a.outlierScore);
  return {
    relatedChannelsScanned: related.length,
    outliers: allOutliers.slice(0, maxResults),
  };
}

/**
 * Kirbah 4-Phase Consistent Outlier Channel Discovery (upgraded: ZERO MongoDB required, works with or without API key!):
 * Identifies channels that repeatedly punch above their subscriber count in a given niche.
 */
export async function findConsistentOutlierChannels(options: {
  query: string;
  channelAge?: 'NEW' | 'ESTABLISHED' | 'ANY';
  consistencyLevel?: 'MODERATE' | 'HIGH';
  outlierMagnitude?: 'STANDARD' | 'STRONG';
  maxSubs?: number;
  maxResults?: number;
}): Promise<OutlierChannel[]> {
  const consistencyThreshold = options.consistencyLevel === 'HIGH' ? 45 : 25;
  const multiplierThreshold = options.outlierMagnitude === 'STRONG' ? 3.0 : 1.0;
  const maxResults = Math.min(20, Math.max(1, options.maxResults || 10));

  // Phase 1: Candidate discovery
  const candidates = (await hybridYouTube.search({
    query: options.query,
    target: 'video',
    maxResults: 35,
    uniqueChannels: true,
  })) as LeanVideo[];

  const channelIds = Array.from(
    new Set(candidates.map((v) => v.channelId).filter((id): id is string => Boolean(id)))
  ).slice(0, 16);

  // Phase 2: Pre-filter channels by age & subscriber ceiling
  const channelMap = await hybridYouTube.getChannelsMap(channelIds);
  const filteredChannels: LeanChannel[] = [];
  const now = Date.now();

  for (const ch of channelMap.values()) {
    if (options.maxSubs !== undefined && (ch.subscribers ?? 0) > options.maxSubs) continue;
    if ((ch.videoCount ?? 5) < 3) continue;

    if (ch.joinedAt && options.channelAge && options.channelAge !== 'ANY') {
      const ageDays = (now - new Date(ch.joinedAt).getTime()) / 86_400_000;
      if (options.channelAge === 'NEW' && ageDays > 365) continue;
      if (options.channelAge === 'ESTABLISHED' && ageDays <= 180) continue;
    }
    filteredChannels.push(ch);
  }

  // Phase 3: Deep upload consistency analysis
  const analyzed: OutlierChannel[] = [];
  await mapConcurrent(filteredChannels.slice(0, 12), 4, async (ch) => {
    const browsed = await browseChannelInnerTube(ch.id, {
      includeVideos: true,
      maxResults: 15,
    }).catch(() => null);
    const vids = browsed?.videos || [];
    if (vids.length < 3) return;

    const subs = Math.max(ch.subscribers ?? 0, 250);
    const scored = vids.map((v) => {
      const views = v.views ?? 0;
      return {
        id: v.id,
        title: v.title,
        views,
        outlierScore: Math.round((views / subs) * 100) / 100,
        publishedAt: v.publishedAt,
      };
    });

    const hits = scored.filter((s) => s.outlierScore >= multiplierThreshold);
    const consistencyPct = Math.round((hits.length / scored.length) * 1000) / 10;
    if (consistencyPct < consistencyThreshold) return;

    const sortedScores = scored.map((s) => s.outlierScore).sort((a, b) => a - b);
    const medianOutlierScore = sortedScores[Math.floor(sortedScores.length / 2)] || 0;
    const maxOutlierScore = sortedScores[sortedScores.length - 1] || 0;

    // Phase 4 confidence score
    const confidenceScore =
      Math.round(
        consistencyPct *
          Math.log10(hits.length + 1.5) *
          Math.log10(Math.max(10, ch.subscribers ?? 500)) *
          10
      ) / 10;

    const channelAgeDays = ch.joinedAt
      ? Math.floor((now - new Date(ch.joinedAt).getTime()) / 86_400_000)
      : undefined;

    analyzed.push({
      channelId: ch.id,
      channelTitle: ch.title,
      channelUrl: ch.url,
      handle: ch.handle,
      subscribers: ch.subscribers ?? 0,
      videoCount: ch.videoCount ?? vids.length,
      channelAgeDays,
      analyzedVideos: scored.length,
      outlierVideoCount: hits.length,
      consistencyPct,
      medianOutlierScore,
      maxOutlierScore,
      confidenceScore,
      topOutliers: scored.sort((a, b) => b.outlierScore - a.outlierScore).slice(0, 3),
    });
  });

  return analyzed.sort((a, b) => b.confidenceScore - a.confidenceScore).slice(0, maxResults);
}

/**
 * TubeLab `search_trending_formats` equivalent:
 * Extracts repeatable viral title templates/formulas from outlier videos in any niche!
 */
export async function searchTrendingFormats(options: {
  query: string;
  maxFormats?: number;
}): Promise<TrendingFormat[]> {
  const outliers = await searchOutlierVideos({
    query: options.query,
    minOutlierScore: 0.8,
    maxResults: 40,
  });
  return extractFormatsFromVideos(outliers, options.maxFormats || 10);
}

export function extractFormatsFromVideos(
  videos: Array<LeanVideo & { outlierScore?: number }>,
  maxFormats = 10
): TrendingFormat[] {
  const buckets = new Map<
    string,
    {
      template: string;
      videos: Array<LeanVideo & { outlierScore: number }>;
      channels: Set<string>;
    }
  >();

  for (const v of videos) {
    const template = generalizeTitleToTemplate(v.title);
    if (!template) continue;
    const bucket = buckets.get(template) || {
      template,
      videos: [],
      channels: new Set<string>(),
    };
    bucket.videos.push({ ...v, outlierScore: v.outlierScore ?? 1 });
    bucket.channels.add(v.channelId || v.channelTitle || v.id);
    buckets.set(template, bucket);
  }

  const formats: TrendingFormat[] = [];
  for (const b of buckets.values()) {
    const viewsArr = b.videos.map((v) => v.views ?? 0).sort((a, b) => a - b);
    const medianViews = viewsArr[Math.floor(viewsArr.length / 2)] || 0;
    const avgOutlierScore =
      Math.round((b.videos.reduce((s, v) => s + v.outlierScore, 0) / b.videos.length) * 100) / 100;
    const avgViewsPerDay = Math.round(
      b.videos.reduce((s, v) => s + (v.viewsPerDay ?? 0), 0) / b.videos.length
    );

    formats.push({
      template: b.template,
      count: b.videos.length,
      uniqueChannels: b.channels.size,
      avgOutlierScore,
      medianViews,
      avgViewsPerDay,
      examples: b.videos
        .sort((a, b) => b.outlierScore - a.outlierScore)
        .slice(0, 3)
        .map((v) => ({
          id: v.id,
          title: v.title,
          views: v.views ?? 0,
          outlierScore: v.outlierScore,
          channelTitle: v.channelTitle,
        })),
    });
  }

  // Rank multi-video / multi-channel patterns first, then highest outlier multiplier
  formats.sort((a, b) => {
    const spreadDiff = Math.min(3, b.uniqueChannels) - Math.min(3, a.uniqueChannels);
    if (spreadDiff !== 0) return spreadDiff;
    return b.avgOutlierScore * Math.sqrt(b.count) - a.avgOutlierScore * Math.sqrt(a.count);
  });

  return formats.slice(0, maxFormats);
}

/**
 * Structural title normalizer turning specific titles into reusable creator title templates.
 */
function generalizeTitleToTemplate(rawTitle: string): string {
  const t = rawTitle.trim();
  if (!t) return '';

  // Recognize canonical high-performing YouTube archetypes first, then slot-normalize
  const lower = t.toLowerCase();
  if (/^i\s+(tried|tested|built|spent|survived|lived|learned|quit)\b/i.test(t)) {
    const verb = t.match(/^i\s+(\w+)/i)?.[1]?.toLowerCase() || 'tried';
    if (/\bfor\s+\d+\s*(days?|hours?|weeks?|months?|years?)/i.test(t)) {
      return `I ${capitalize(verb)} [X] for [N] [Timeframe]`;
    }
    if (/\bin\s+\d+\s*(minutes?|hours?|days?|seconds?)/i.test(t)) {
      return `I ${capitalize(verb)} [X] in [N] [Timeframe]`;
    }
    return `I ${capitalize(verb)} [X] (Here's What Happened)`;
  }

  if (/^how\s+(to|i)\b/i.test(t)) {
    const sub = /^how\s+i\b/i.test(t) ? 'How I [Action]' : 'How to [Achieve Outcome]';
    if (/\bin\s+\d+\s*(minutes?|hours?|days?|steps?)/i.test(t)) {
      return `${sub} in [N] [Timeframe/Steps]`;
    }
    if (/\bwithout\b/i.test(t)) {
      return `${sub} Without [Pain Point]`;
    }
    return `${sub} ([Year/Qualifier])`;
  }

  if (/^why\b/i.test(t)) {
    if (/\b(actually|secretly|really|never|stopped|dead|dying|broken)\b/i.test(lower)) {
      return 'Why [X] Is Actually/Secretly [Contrarian Claim]';
    }
    return 'Why [Subject] [Unexpected Outcome]';
  }

  if (/^\d+\s+/.test(t)) {
    return '[N] [Topic/Items] That [Benefit / You Need to Know]';
  }

  if (/\bvs\.?\b/i.test(t)) {
    return '[Option A] vs [Option B]: Which Is Better?';
  }

  if (/\bin\s+100\s+seconds\b/i.test(lower)) {
    return '[Topic] in 100 Seconds';
  }

  if (/\b(explained|crash course|full course|roadmap|guide)\b/i.test(lower)) {
    return 'The Ultimate [Topic] Guide / Explained';
  }

  // Fallback token-level slot normalization
  return t
    .replace(/\$[\d,.]+[KMB]?/gi, '[$Amount]')
    .replace(/\b202\d\b/g, '[Year]')
    .replace(/\b\d+\s*(days?|hours?|minutes?|seconds?|weeks?|months?|years?|steps?|tips?|ways?)\b/gi, '[N] $1')
    .replace(/\b\d+[KMB%]?\b/g, '[N]')
    .replace(/\([^)]+\)/g, '([Hook Qualifier])');
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function deriveChannelTopicQuery(channel: LeanChannel, videos: LeanVideo[]): string {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'how', 'why', 'what',
    'when', 'who', 'are', 'was', 'were', 'just', 'new', 'video', 'videos', 'official', 'channel',
    'into', 'about', 'more', 'best', 'top', 'out', 'all', 'can', 'will', 'not', 'but', 'have',
  ]);
  const counts = new Map<string, number>();
  const text = `${videos.map((v) => v.title).join(' ')} ${(channel.description || '').slice(0, 300)}`;
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}#+-]+/u)
    .filter((w) => w.length >= 3 && !stop.has(w) && !/^\d+$/.test(w));

  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }

  const chNameParts = new Set(channel.title.toLowerCase().split(/\s+/));
  return Array.from(counts.entries())
    .filter(([w]) => !chNameParts.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)
    .join(' ');
}
