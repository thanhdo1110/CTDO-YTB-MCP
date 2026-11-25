export type ToolWeightMode = 'lite' | 'compact' | 'full';
export type OutputFormat = 'compact' | 'markdown' | 'json';

export interface Chapter {
  title: string;
  startSec: number;
  timestamp: string;
}

export interface SponsorSegment {
  category: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  actionType?: string;
}

export interface DislikeStats {
  likes: number;
  dislikes: number;
  rating: number;
  approvalPct: number;
  rawDislikes?: number;
}

export interface LeanVideo {
  id: string;
  url: string;
  title: string;
  channelId?: string;
  channelTitle?: string;
  channelHandle?: string;
  publishedAt?: string;
  publishedText?: string;
  durationSec?: number;
  duration?: string;
  isShort?: boolean;
  isLive?: boolean;
  views?: number;
  likes?: number;
  comments?: number;
  likeToViewPct?: number;
  commentToViewPct?: number;
  viewsPerDay?: number;
  categoryId?: string;
  language?: string;
  description?: string;
  tags?: string[];
  thumbnails?: {
    default?: string;
    hq?: string;
    maxres?: string;
  };
  chapters?: Chapter[];
  sponsorSegments?: SponsorSegment[];
  highlightSec?: number;
  dislikes?: DislikeStats;
  captionLanguages?: string[];
  source?: 'api' | 'innertube' | 'rss';
}

export interface ChannelHeuristic {
  type: 'creator' | 'brand_or_media' | 'unknown';
  confidence: number;
  creatorHits?: string[];
  brandHits?: string[];
}

export interface LeanChannel {
  id: string;
  title: string;
  handle?: string;
  url: string;
  description?: string;
  country?: string;
  language?: string;
  joinedAt?: string;
  subscribers?: number;
  totalViews?: number;
  videoCount?: number;
  avgViewsPerVideo?: number;
  uploadsPlaylistId?: string;
  latestUploadAt?: string;
  uploadCadencePerWeek?: number;
  shortsRatioPct?: number;
  emails?: string[];
  links?: string[];
  monetizationLikely?: boolean;
  classification?: ChannelHeuristic;
  avatarUrl?: string;
  bannerUrl?: string;
  source?: 'api' | 'innertube';
}

export interface LeanPlaylist {
  id: string;
  url: string;
  title: string;
  channelId?: string;
  channelTitle?: string;
  description?: string;
  itemCount?: number;
  publishedAt?: string;
  items?: LeanVideo[];
}

export interface LeanComment {
  id: string;
  author: string;
  authorChannelId?: string;
  text: string;
  likes: number;
  replyCount?: number;
  publishedText?: string;
  publishedAt?: string;
  isPinned?: boolean;
  isHearted?: boolean;
  replies?: LeanComment[];
}

export interface TranscriptSegment {
  startSec: number;
  durationSec: number;
  timestamp: string;
  text: string;
}

export interface TranscriptResult {
  videoId: string;
  language: string;
  translatedTo?: string;
  availableLanguages?: string[];
  segmentCount: number;
  totalDurationSec: number;
  wordCount: number;
  estimatedSpeakingWpm?: number;
  hook?: string;
  outro?: string;
  fullText?: string;
  segments?: TranscriptSegment[];
  chapterSections?: Array<{
    chapter: string;
    startSec: number;
    timestamp: string;
    text: string;
  }>;
  matches?: Array<{
    timestamp: string;
    startSec: number;
    deepLink: string;
    text: string;
  }>;
  savedFilePath?: string;
}

export interface OutlierVideo extends LeanVideo {
  channelSubscribers: number;
  outlierScore: number; // views / subscribers
  channelMedianViews?: number;
  vsChannelMedianScore?: number; // views / medianViews
  engagementScore: number;
}

export interface OutlierChannel {
  channelId: string;
  channelTitle: string;
  channelUrl: string;
  handle?: string;
  subscribers: number;
  videoCount: number;
  channelAgeDays?: number;
  analyzedVideos: number;
  outlierVideoCount: number;
  consistencyPct: number;
  medianOutlierScore: number;
  maxOutlierScore: number;
  confidenceScore: number;
  topOutliers: Array<{
    id: string;
    title: string;
    views: number;
    outlierScore: number;
    publishedAt?: string;
  }>;
}

export interface TrendingFormat {
  template: string;
  count: number;
  uniqueChannels: number;
  avgOutlierScore: number;
  medianViews: number;
  avgViewsPerDay: number;
  examples: Array<{
    id: string;
    title: string;
    views: number;
    outlierScore: number;
    channelTitle?: string;
  }>;
}

export interface CommentMiningReport {
  videoId: string;
  analyzedComments: number;
  sentiment: {
    positivePct: number;
    neutralPct: number;
    negativePct: number;
    overallScore: number;
  };
  questions: Array<{ author: string; likes: number; text: string }>;
  contentRequests: Array<{ author: string; likes: number; text: string }>;
  painPoints: Array<{ author: string; likes: number; text: string }>;
  mentionedTimestamps: Array<{ timestamp: string; startSec: number; deepLink: string; context: string; likes: number }>;
  topKeywords: Array<{ word: string; count: number }>;
  topLikedComments: Array<{ author: string; likes: number; text: string }>;
}

export interface NicheValidationReport {
  niche: string;
  verdict: 'BREAKOUT_GOLDMINE' | 'STRONG_OPPORTUNITY' | 'COMPETITIVE_VIABLE' | 'SATURATED';
  opportunityScore: number; // 0-100
  sampleSize: { videos: number; uniqueChannels: number };
  metrics: {
    medianViews: number;
    avgViews: number;
    medianSubscribers: number;
    medianOutlierScore: number;
    smallChannelBreakoutPct: number; // % of top videos from channels < 50K subs
    avgViewsPerDay: number;
    shortsSharePct: number;
  };
  monetization: {
    estimatedRpmUsdRange: [number, number];
    tier: 'HIGH_CPM' | 'MEDIUM_CPM' | 'VOLUME_AD_DRIVEN';
    sponsorPotential: 'HIGH' | 'MEDIUM' | 'LOW';
  };
  topBreakoutVideos: OutlierVideo[];
  winningTitlePatterns: TrendingFormat[];
}

export interface PackagingAnalysis {
  videoId: string;
  title: string;
  titleAudit: {
    charLength: number;
    wordCount: number;
    optimalLength: boolean;
    hasNumber: boolean;
    hasBracketsOrParens: boolean;
    curiosityTriggers: string[];
    powerWords: string[];
    ctrScore: number; // 0-100
  };
  hookAudit?: {
    first40sText: string;
    wordCount: number;
    speakingWpm: number;
    hasOpenLoop: boolean;
    hasDirectYou: boolean;
    pacingVerdict: 'FAST_PUNCHY' | 'OPTIMAL' | 'SLOW_INTRO';
  };
  seoAudit: {
    tagCount: number;
    tagsInTitleCount: number;
    descriptionWordCount: number;
    chapterCount: number;
    linkCount: number;
  };
  engagementAudit: {
    views: number;
    likes: number;
    comments: number;
    likeToViewPct: number;
    commentToViewPct: number;
    viewsPerDay?: number;
  };
  thumbnails: {
    maxres: string;
    hq: string;
    webp: string;
  };
}

export interface KBSearchResult {
  videoId: string;
  videoTitle: string;
  channelTitle?: string;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  timestamp: string;
  deepLink: string;
  score: number;
  text: string;
}
