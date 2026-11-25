import { CACHE_TTL, globalCache } from '../core/cache.js';
import type { ChannelHeuristic, DislikeStats, LeanChannel, LeanVideo, SponsorSegment } from '../core/types.js';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+/gi;

const BRAND_KEYWORDS = [
  'official',
  'records',
  'vevo',
  'network',
  'television',
  'studios',
  'publisher',
  'esports',
  'radio',
  'topic',
  'corporation',
  'inc.',
  'newsroom',
];

const CREATOR_KEYWORDS = [
  'my channel',
  'my videos',
  'i upload',
  'i make',
  'i build',
  'i play',
  'let\'s play',
  'lets play',
  'streamer',
  'content creator',
  'creator',
  'vlog',
  'tutorial',
  'subscribe',
  'business inquiries',
  'patreon.com',
  'ko-fi.com',
  'buymeacoffee',
  'discord.gg',
];

/**
 * Fetch SponsorBlock segments & POI Highlight timestamp (0 API key, public crowdsourced database).
 */
export async function fetchSponsorBlock(videoId: string): Promise<{
  segments: SponsorSegment[];
  highlightSec?: number;
}> {
  return globalCache.getOrCompute(
    'sponsorblock',
    videoId,
    CACHE_TTL.SPONSORBLOCK,
    async () => {
      try {
        const categories = JSON.stringify([
          'sponsor',
          'selfpromo',
          'interaction',
          'intro',
          'outro',
          'preview',
          'filler',
          'poi_highlight',
        ]);
        const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(
          videoId
        )}&categories=${encodeURIComponent(categories)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3_500) });
        if (!res.ok) return { segments: [] };

        const rows = (await res.json()) as Array<{
          category: string;
          actionType?: string;
          segment: [number, number];
        }>;
        if (!Array.isArray(rows)) return { segments: [] };

        let highlightSec: number | undefined;
        const segments: SponsorSegment[] = [];

        for (const r of rows) {
          const startSec = Math.round((r.segment?.[0] || 0) * 10) / 10;
          const endSec = Math.round((r.segment?.[1] || 0) * 10) / 10;
          if (r.category === 'poi_highlight') {
            highlightSec = startSec;
            continue;
          }
          segments.push({
            category: r.category,
            startSec,
            endSec,
            durationSec: Math.max(0, Math.round((endSec - startSec) * 10) / 10),
            actionType: r.actionType,
          });
        }
        return { segments, highlightSec };
      } catch {
        return { segments: [] };
      }
    }
  );
}

/**
 * Fetch real-time Dislike estimates & approval ratio via ReturnYouTubeDislike API.
 */
export async function fetchDislikeStats(videoId: string): Promise<DislikeStats | null> {
  return globalCache.getOrCompute('ryd_dislikes', videoId, CACHE_TTL.VIDEO, async () => {
    try {
      const res = await fetch(
        `https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`,
        { signal: AbortSignal.timeout(3_500) }
      );
      if (!res.ok) return null;
      const d = (await res.json()) as any;
      const likes = Number(d?.likes || 0);
      const dislikes = Number(d?.dislikes || 0);
      const total = likes + dislikes;
      return {
        likes,
        dislikes,
        rating: Math.round(Number(d?.rating || 0) * 100) / 100,
        approvalPct: total > 0 ? Math.round((likes / total) * 1000) / 10 : 100,
        rawDislikes: d?.rawDislikes !== undefined ? Number(d.rawDislikes) : undefined,
      };
    } catch {
      return null;
    }
  });
}

/**
 * Enrich LeanChannel with emails, contact/social links, creator vs brand classifier, upload cadence & monetization heuristic!
 */
export function enrichChannelIntelligence(
  channel: LeanChannel,
  recentVideos?: LeanVideo[],
  recentShorts?: LeanVideo[]
): LeanChannel {
  const desc = channel.description || '';
  const emails = Array.from(new Set((desc.match(EMAIL_REGEX) || []).map((e) => e.toLowerCase())));
  const links = Array.from(new Set(desc.match(URL_REGEX) || [])).slice(0, 12);

  const lower = `${channel.title} ${desc}`.toLowerCase();
  const brandHits = BRAND_KEYWORDS.filter((k) => lower.includes(k));
  const creatorHits = CREATOR_KEYWORDS.filter((k) => lower.includes(k));

  let type: ChannelHeuristic['type'] = 'unknown';
  if (brandHits.length >= 2 && brandHits.length > creatorHits.length) {
    type = 'brand_or_media';
  } else if (creatorHits.length > 0 && creatorHits.length >= brandHits.length) {
    type = 'creator';
  } else if ((channel.subscribers || 0) > 0 && (channel.subscribers || 0) < 2_000_000 && brandHits.length === 0) {
    type = 'creator';
  }

  // Estimate upload cadence from recent videos timestamps
  let uploadCadencePerWeek: number | undefined;
  let latestUploadAt = channel.latestUploadAt;
  const datedVideos = (recentVideos || []).filter((v) => Boolean(v.publishedAt));
  if (datedVideos.length >= 2) {
    const timestamps = datedVideos
      .map((v) => new Date(v.publishedAt!).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a);
    if (timestamps.length >= 2) {
      latestUploadAt = new Date(timestamps[0]).toISOString();
      const spanWeeks = Math.max(0.5, (timestamps[0] - timestamps[timestamps.length - 1]) / (7 * 86_400_000));
      uploadCadencePerWeek = Math.round((timestamps.length / spanWeeks) * 10) / 10;
    }
  }

  let shortsRatioPct: number | undefined;
  if (recentVideos && recentShorts && recentVideos.length + recentShorts.length > 0) {
    shortsRatioPct = Math.round(
      (recentShorts.length / (recentVideos.length + recentShorts.length)) * 1000
    ) / 10;
  }

  // TubeLab-inspired YPP monetization heuristic (>= 1,000 subs & realistic total view threshold)
  const monetizationLikely =
    (channel.subscribers || 0) >= 1_000 &&
    ((channel.totalViews || 0) >= 10_000 || (channel.videoCount || 0) >= 5);

  return {
    ...channel,
    latestUploadAt,
    uploadCadencePerWeek,
    shortsRatioPct,
    emails: emails.length > 0 ? emails : undefined,
    links: links.length > 0 ? links : undefined,
    monetizationLikely,
    classification: {
      type,
      confidence: Math.max(1, brandHits.length, creatorHits.length),
      creatorHits: creatorHits.length > 0 ? creatorHits : undefined,
      brandHits: brandHits.length > 0 ? brandHits : undefined,
    },
  };
}

/**
 * Optional TubeLab Public API / Credits checker when user configures TUBELAB_API_KEY.
 */
export async function fetchTubeLabBalance(): Promise<{ configured: boolean; data?: unknown; note: string }> {
  const key = (process.env.TUBELAB_API_KEY || '').trim();
  if (!key) {
    return {
      configured: false,
      note: 'TUBELAB_API_KEY not set — running CTDO Built-in Zero-Cost Outlier & Niche Engine (unlimited free runs!).',
    };
  }
  try {
    const res = await fetch('https://public-api.tubelab.net/v1/credits', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json().catch(() => null);
    return {
      configured: true,
      data,
      note: res.ok ? 'TubeLab API key active' : `TubeLab HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      configured: true,
      note: `TubeLab check failed (${err instanceof Error ? err.message : String(err)}); CTDO built-in engine active.`,
    };
  }
}
