import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CommentMiningReport,
  LeanChannel,
  LeanVideo,
  NicheValidationReport,
  OutlierVideo,
  PackagingAnalysis,
} from '../core/types.js';
import {
  extractVideoId,
  formatTimestamp,
  mapConcurrent,
  parseDurationSeconds,
} from '../core/utils.js';
import { hybridYouTube } from '../providers/hybrid-client.js';
import { extractFormatsFromVideos, searchOutlierVideos } from './outliers.js';

const execFileAsync = promisify(execFile);

/**
 * Zubeid `channels_findCreators` upgraded:
 * Finds active creator channels mentioning a topic/product/game, filtered by subscriber band & creator classification,
 * enriched with extracted emails, social links, and sample matched videos!
 */
export async function findCreatorsByTopic(options: {
  query: string;
  minSubs?: number;
  maxSubs?: number;
  publishedAfter?: string;
  creatorOnly?: boolean;
  sortBy?: 'relevance' | 'indie_priority' | 'subscribers_desc' | 'recent_activity';
  maxResults?: number;
}) {
  const maxResults = Math.min(25, Math.max(1, options.maxResults || 12));
  const videos = (await hybridYouTube.search({
    query: options.query,
    target: 'video',
    maxResults: 40,
    publishedAfter: options.publishedAfter,
  })) as LeanVideo[];

  const byChannel = new Map<string, LeanVideo[]>();
  const rankOrder = new Map<string, number>();

  videos.forEach((v, idx) => {
    if (!v.channelId) return;
    if (!byChannel.has(v.channelId)) {
      byChannel.set(v.channelId, []);
      rankOrder.set(v.channelId, idx);
    }
    byChannel.get(v.channelId)!.push(v);
  });

  const chMap = await hybridYouTube.getChannelsMap(Array.from(byChannel.keys()));
  let creators = Array.from(chMap.values()).filter((c) => {
    if (options.minSubs !== undefined && (c.subscribers ?? 0) < options.minSubs) return false;
    if (options.maxSubs !== undefined && (c.subscribers ?? 0) > options.maxSubs) return false;
    if (options.creatorOnly && c.classification?.type === 'brand_or_media') return false;
    return true;
  });

  const sort = options.sortBy || 'relevance';
  creators.sort((a, b) => {
    if (sort === 'indie_priority') return (a.subscribers ?? 0) - (b.subscribers ?? 0);
    if (sort === 'subscribers_desc') return (b.subscribers ?? 0) - (a.subscribers ?? 0);
    if (sort === 'recent_activity') {
      return new Date(b.latestUploadAt || 0).getTime() - new Date(a.latestUploadAt || 0).getTime();
    }
    return (rankOrder.get(a.id) ?? 999) - (rankOrder.get(b.id) ?? 999);
  });

  return creators.slice(0, maxResults).map((ch) => ({
    ...ch,
    matchedCount: byChannel.get(ch.id)?.length || 0,
    sampleVideos: (byChannel.get(ch.id) || []).slice(0, 3).map((v) => ({
      id: v.id,
      title: v.title,
      views: v.views,
      publishedAt: v.publishedAt,
    })),
  }));
}

/**
 * TubeLab-style Niche Saturation, Breakout Rate & Monetization/RPM Validator!
 */
export async function analyzeNicheOpportunity(niche: string): Promise<NicheValidationReport> {
  const outliers = await searchOutlierVideos({
    query: niche,
    minOutlierScore: 0.1,
    maxResults: 35,
  });

  const uniqueChannels = new Set(outliers.map((v) => v.channelId || v.channelTitle || v.id)).size;
  const viewsList = outliers.map((v) => v.views ?? 0).sort((a, b) => a - b);
  const subsList = outliers.map((v) => v.channelSubscribers).sort((a, b) => a - b);
  const scoreList = outliers.map((v) => v.outlierScore).sort((a, b) => a - b);

  const medianViews = viewsList[Math.floor(viewsList.length / 2)] || 0;
  const avgViews =
    outliers.length > 0 ? Math.round(viewsList.reduce((a, b) => a + b, 0) / outliers.length) : 0;
  const medianSubscribers = subsList[Math.floor(subsList.length / 2)] || 0;
  const medianOutlierScore = scoreList[Math.floor(scoreList.length / 2)] || 0;

  const smallChannelHits = outliers.filter(
    (v) => v.channelSubscribers > 0 && v.channelSubscribers < 50_000 && (v.views ?? 0) >= 10_000
  ).length;
  const smallChannelBreakoutPct =
    outliers.length > 0 ? Math.round((smallChannelHits / outliers.length) * 1000) / 10 : 0;

  const avgViewsPerDay =
    outliers.length > 0
      ? Math.round(outliers.reduce((s, v) => s + (v.viewsPerDay ?? 0), 0) / outliers.length)
      : 0;

  const shortsCount = outliers.filter((v) => v.isShort).length;
  const shortsSharePct =
    outliers.length > 0 ? Math.round((shortsCount / outliers.length) * 1000) / 10 : 0;

  const monetization = estimateNicheMonetization(niche);

  // Composite Opportunity Score (0 - 100)
  const demandComponent = Math.min(35, Math.log10(Math.max(100, medianViews)) * 6.5);
  const outlierComponent = Math.min(30, medianOutlierScore * 12);
  const breakoutComponent = Math.min(25, smallChannelBreakoutPct * 0.65);
  const rpmComponent =
    monetization.tier === 'HIGH_CPM' ? 10 : monetization.tier === 'MEDIUM_CPM' ? 7 : 4;
  const opportunityScore = Math.min(
    99,
    Math.max(10, Math.round(demandComponent + outlierComponent + breakoutComponent + rpmComponent))
  );

  const verdict: NicheValidationReport['verdict'] =
    opportunityScore >= 78
      ? 'BREAKOUT_GOLDMINE'
      : opportunityScore >= 60
        ? 'STRONG_OPPORTUNITY'
        : opportunityScore >= 42
          ? 'COMPETITIVE_VIABLE'
          : 'SATURATED';

  return {
    niche,
    verdict,
    opportunityScore,
    sampleSize: { videos: outliers.length, uniqueChannels },
    metrics: {
      medianViews,
      avgViews,
      medianSubscribers,
      medianOutlierScore,
      smallChannelBreakoutPct,
      avgViewsPerDay,
      shortsSharePct,
    },
    monetization,
    topBreakoutVideos: outliers
      .sort((a, b) => b.outlierScore - a.outlierScore)
      .slice(0, 6) as OutlierVideo[],
    winningTitlePatterns: extractFormatsFromVideos(outliers, 5),
  };
}

function estimateNicheMonetization(niche: string): NicheValidationReport['monetization'] {
  const lower = niche.toLowerCase();
  if (
    /\b(finance|investing|trading|crypto|saas|b2b|software|ai|coding|programming|cloud|cybersecurity|real estate|business|marketing|ecommerce|shopify|legal|insurance|tax)\b/.test(
      lower
    )
  ) {
    return {
      estimatedRpmUsdRange: [12, 32],
      tier: 'HIGH_CPM',
      sponsorPotential: 'HIGH',
    };
  }
  if (
    /\b(tech|gadget|camera|productivity|notion|design|education|science|health|fitness|career|self improvement|tutorial|diy|home|auto|car)\b/.test(
      lower
    )
  ) {
    return {
      estimatedRpmUsdRange: [5, 14],
      tier: 'MEDIUM_CPM',
      sponsorPotential: 'MEDIUM',
    };
  }
  return {
    estimatedRpmUsdRange: [1.5, 5.5],
    tier: 'VOLUME_AD_DRIVEN',
    sponsorPotential: 'LOW',
  };
}

/**
 * Side-by-Side Competitor Channel Matrix across 2–10 channels!
 */
export async function compareChannelsMatrix(channelInputs: string[]) {
  const details = await hybridYouTube.getChannels({
    channels: channelInputs,
    include: ['stats', 'videos', 'shorts'],
    maxItems: 15,
  });

  const rows = details.map(({ channel, videos = [], shorts = [] }) => {
    const viewsArr = videos.map((v) => v.views ?? 0).sort((a, b) => a - b);
    const medianRecentViews = viewsArr[Math.floor(viewsArr.length / 2)] || 0;
    const subs = Math.max(channel.subscribers ?? 0, 250);
    const outlierHits = videos.filter((v) => (v.views ?? 0) >= subs * 1.5).length;
    const outlierRatePct =
      videos.length > 0 ? Math.round((outlierHits / videos.length) * 1000) / 10 : 0;
    const topRecentVideo = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];

    return {
      id: channel.id,
      title: channel.title,
      handle: channel.handle,
      subscribers: channel.subscribers ?? 0,
      totalViews: channel.totalViews,
      videoCount: channel.videoCount,
      uploadCadencePerWeek: channel.uploadCadencePerWeek ?? 0,
      shortsRatioPct: channel.shortsRatioPct ?? 0,
      medianRecentViews,
      viewToSubRatio: Math.round((medianRecentViews / subs) * 1000) / 1000,
      outlierRatePct,
      monetizationLikely: channel.monetizationLikely,
      topRecentVideo: topRecentVideo
        ? { id: topRecentVideo.id, title: topRecentVideo.title, views: topRecentVideo.views }
        : undefined,
    };
  });

  rows.sort((a, b) => b.medianRecentViews - a.medianRecentViews);
  return { comparedCount: rows.length, channels: rows };
}

/**
 * Audience Intelligence Comment Miner:
 * Mines questions, video requests, pain points/complaints, viewer-curated timestamps, keywords & multilingual sentiment!
 */
export async function mineVideoComments(
  videoInput: string,
  maxComments = 60
): Promise<CommentMiningReport> {
  const videoId = extractVideoId(videoInput);
  const comments = await hybridYouTube.getComments({
    video: videoId,
    maxResults: maxComments,
    sortBy: 'top',
  });

  const POS_WORDS =
    /\b(great|awesome|amazing|love|helpful|best|thank|thanks|clear|perfect|goat|insane|brilliant|fire|hay|tuyệt|đỉnh|cảm ơn|hữu ích|xuất sắc)\b/i;
  const NEG_WORDS =
    /\b(bad|worst|wrong|broken|confusing|boring|clickbait|fake|disappointed|outdated|slow|annoying|error|fail|tệ|lỗi|sai|chán|khó hiểu)\b/i;
  const REQ_PATTERNS =
    /\b(please make|can you make|can you cover|could you do|next video|part 2|tutorial on|would love a video|talk about|review|làm về|mong anh|mong bạn|ra phần 2|hướng dẫn thêm)\b/i;
  const PAIN_PATTERNS =
    /\b(doesn't work|didn't work|not working|stuck|confused|struggling|issue|problem|bug|hard to|wish|too fast|audio|bị lỗi|không chạy|không được|khó quá|vướng)\b/i;
  const TS_REGEX = /\b((?:\d{1,2}:)?\d{1,2}:\d{2})\b/;

  let pos = 0;
  let neg = 0;
  let neu = 0;

  const questions: Array<{ author: string; likes: number; text: string }> = [];
  const contentRequests: Array<{ author: string; likes: number; text: string }> = [];
  const painPoints: Array<{ author: string; likes: number; text: string }> = [];
  const mentionedTimestamps: Array<{
    timestamp: string;
    startSec: number;
    deepLink: string;
    context: string;
    likes: number;
  }> = [];
  const wordFreq = new Map<string, number>();

  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'was', 'are', 'have', 'not',
    'but', 'from', 'just', 'like', 'what', 'how', 'why', 'can', 'video', 'really', 'about',
    'one', 'all', 'more', 'out', 'very', 'get', 'has', 'had', 'they', 'their', 'there',
    'của', 'và', 'các', 'những', 'một', 'này', 'cho', 'không', 'được', 'trong', 'mình', 'bạn',
  ]);

  for (const c of comments) {
    const t = c.text;
    if (!t) continue;

    const isPos = POS_WORDS.test(t);
    const isNeg = NEG_WORDS.test(t);
    if (isPos && !isNeg) pos++;
    else if (isNeg && !isPos) neg++;
    else neu++;

    const compactEntry = {
      author: c.author,
      likes: c.likes,
      text: t.length > 220 ? `${t.slice(0, 220)}...` : t,
    };

    if (t.includes('?') && t.length >= 15) {
      questions.push(compactEntry);
    }
    if (REQ_PATTERNS.test(t)) {
      contentRequests.push(compactEntry);
    }
    if (PAIN_PATTERNS.test(t)) {
      painPoints.push(compactEntry);
    }

    const tsMatch = t.match(TS_REGEX);
    if (tsMatch?.[1]) {
      const startSec = parseDurationSeconds(tsMatch[1]);
      if (startSec !== undefined) {
        mentionedTimestamps.push({
          timestamp: formatTimestamp(startSec),
          startSec,
          deepLink: `https://youtu.be/${videoId}?t=${startSec}s`,
          context: compactEntry.text,
          likes: c.likes,
        });
      }
    }

    const tokens = t
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !stopWords.has(w) && !/^\d+$/.test(w));
    for (const w of tokens) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
  }

  const total = Math.max(1, comments.length);
  const byLikes = <T extends { likes: number }>(arr: T[], cap = 10) =>
    arr.sort((a, b) => b.likes - a.likes).slice(0, cap);

  return {
    videoId,
    analyzedComments: comments.length,
    sentiment: {
      positivePct: Math.round((pos / total) * 1000) / 10,
      neutralPct: Math.round((neu / total) * 1000) / 10,
      negativePct: Math.round((neg / total) * 1000) / 10,
      overallScore: Math.round(((pos - neg) / total) * 100) / 100,
    },
    questions: byLikes(questions, 10),
    contentRequests: byLikes(contentRequests, 10),
    painPoints: byLikes(painPoints, 10),
    mentionedTimestamps: byLikes(mentionedTimestamps, 10),
    topKeywords: Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word, count]) => ({ word, count })),
    topLikedComments: byLikes(
      comments.map((c) => ({
        author: c.author,
        likes: c.likes,
        text: c.text.length > 220 ? `${c.text.slice(0, 220)}...` : c.text,
      })),
      8
    ),
  };
}

/**
 * Packaging, Hook, Speaking Pace (WPM) & SEO Analyzer!
 */
export async function analyzePackaging(
  videoInputs: string[],
  includeHook = true
): Promise<PackagingAnalysis[]> {
  const videos = await hybridYouTube.getVideos({
    videos: videoInputs,
    descriptionDetail: 'full',
    includeTags: true,
    includeChapters: true,
  });

  const txMap = new Map<string, { hook?: string; wpm?: number }>();
  if (includeHook && videos.length > 0) {
    const txs = await hybridYouTube.getTranscripts({
      videos: videos.map((v) => v.id),
      mode: 'key_segments',
    });
    for (const tx of txs) {
      txMap.set(tx.videoId, { hook: tx.hook, wpm: tx.estimatedSpeakingWpm });
    }
  }

  return videos.map((v) => {
    const title = v.title || '';
    const charLength = title.length;
    const words = title.trim().split(/\s+/).filter(Boolean);
    const optimalLength = charLength >= 38 && charLength <= 68;
    const hasNumber = /\d/.test(title);
    const hasBracketsOrParens = /[\[\]()]/.test(title);

    const curiosityVocab = ['why', 'secret', 'actually', 'never', 'truth', 'nobody', 'stop', 'mistake', 'lost', 'tried', 'happened', 'sự thật', 'bí mật', 'đừng', 'tại sao'];
    const powerVocab = ['ultimate', 'insane', 'free', 'fast', 'easy', 'best', 'new', 'complete', 'proven', 'exact', 'siêu', 'nhanh', 'đỉnh', 'miễn phí'];

    const lowerTitle = title.toLowerCase();
    const curiosityTriggers = curiosityVocab.filter((w) => lowerTitle.includes(w));
    const powerWords = powerVocab.filter((w) => lowerTitle.includes(w));

    let ctrScore = 50;
    if (optimalLength) ctrScore += 15;
    if (hasNumber) ctrScore += 10;
    if (hasBracketsOrParens) ctrScore += 7;
    ctrScore += Math.min(12, curiosityTriggers.length * 6);
    ctrScore += Math.min(6, powerWords.length * 3);
    ctrScore = Math.min(99, ctrScore);

    const tx = txMap.get(v.id);
    const hookText = tx?.hook || '';
    const hookWords = hookText ? hookText.split(/\s+/).length : 0;
    const wpm = tx?.wpm || (hookWords > 0 ? Math.round((hookWords / 40) * 60) : 0);

    const tags = v.tags || [];
    const tagsInTitleCount = tags.filter((tag) => lowerTitle.includes(tag.toLowerCase())).length;
    const desc = v.description || '';
    const descLinks = (desc.match(/https?:\/\/\S+/g) || []).length;

    return {
      videoId: v.id,
      title,
      titleAudit: {
        charLength,
        wordCount: words.length,
        optimalLength,
        hasNumber,
        hasBracketsOrParens,
        curiosityTriggers,
        powerWords,
        ctrScore,
      },
      hookAudit: hookText
        ? {
            first40sText: hookText.slice(0, 450),
            wordCount: hookWords,
            speakingWpm: wpm,
            hasOpenLoop: /\?|here's why|but |however|until|most people|secret|nhưng|tuy nhiên/i.test(hookText),
            hasDirectYou: /\b(you|your|bạn|anh em)\b/i.test(hookText),
            pacingVerdict: wpm >= 165 ? 'FAST_PUNCHY' : wpm >= 125 ? 'OPTIMAL' : 'SLOW_INTRO',
          }
        : undefined,
      seoAudit: {
        tagCount: tags.length,
        tagsInTitleCount,
        descriptionWordCount: desc ? desc.split(/\s+/).length : 0,
        chapterCount: v.chapters?.length || 0,
        linkCount: descLinks,
      },
      engagementAudit: {
        views: v.views ?? 0,
        likes: v.likes ?? 0,
        comments: v.comments ?? 0,
        likeToViewPct: v.likeToViewPct ?? 0,
        commentToViewPct: v.commentToViewPct ?? 0,
        viewsPerDay: v.viewsPerDay,
      },
      thumbnails: {
        maxres: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
        hq: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        webp: `https://i.ytimg.com/vi_webp/${v.id}/maxresdefault.webp`,
      },
    };
  });
}

/**
 * Lightweight Exporter: saves thumbnails, transcripts, or JSON/CSV datasets directly to disk + optional yt-dlp info/subtitles!
 */
export async function exportYouTubeAsset(options: {
  target: 'transcript' | 'thumbnail' | 'metadata_json' | 'ytdlp_audio_url';
  video: string;
  outputPath?: string;
  format?: 'srt' | 'vtt' | 'txt' | 'json';
  lang?: string;
}) {
  const videoId = extractVideoId(options.video);

  if (options.target === 'thumbnail') {
    const urls = [
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    ];
    for (const url of urls) {
      const res = await fetch(url);
      if (res.ok) {
        if (options.outputPath) {
          await mkdir(dirname(options.outputPath), { recursive: true });
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(options.outputPath, buf);
          return { videoId, savedTo: options.outputPath, bytes: buf.byteLength, sourceUrl: url };
        }
        return { videoId, thumbnailUrl: url };
      }
    }
    throw new Error(`Could not fetch thumbnail for ${videoId}`);
  }

  if (options.target === 'transcript') {
    const fmt = options.format === 'srt' || options.format === 'vtt' ? options.format : 'full';
    const [tx] = await hybridYouTube.getTranscripts({
      videos: [videoId],
      mode: fmt,
      lang: options.lang,
      saveToFile: options.outputPath,
    });
    return tx;
  }

  if (options.target === 'metadata_json') {
    const [video] = await hybridYouTube.getVideos({
      videos: [videoId],
      descriptionDetail: 'full',
      includeTags: true,
      includeChapters: true,
      includeSponsorBlock: true,
      includeDislikes: true,
    });
    if (options.outputPath) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, JSON.stringify(video, null, 2), 'utf8');
      return { videoId, savedTo: options.outputPath };
    }
    return video;
  }

  // Optional yt-dlp bridge when installed locally
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['-f', 'bestaudio', '-g', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`], {
      timeout: 15_000,
    });
    return { videoId, bestAudioStreamUrl: stdout.trim() };
  } catch {
    return {
      videoId,
      note: 'yt-dlp binary not installed in PATH. Install via `brew install yt-dlp` to enable direct audio stream extraction.',
    };
  }
}
