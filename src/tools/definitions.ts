import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolWeightMode } from '../core/types.js';

/**
 * Ultra-lean JSON Schemas engineered for minimal LLM input token footprint (~130 tokens/tool!).
 */
export const CORE_POWER_TOOLS: Tool[] = [
  {
    name: 'yt_search',
    description:
      'Search YouTube videos, Shorts, channels, playlists, trending charts, or categories (works with 0 API key or API v3).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (omit only for trending/categories)' },
        target: {
          type: 'string',
          enum: ['video', 'short', 'channel', 'playlist', 'trending', 'categories'],
          description: 'Default: video',
        },
        maxResults: { type: 'number', description: '1-50 (default 15)' },
        sort: {
          type: 'string',
          enum: [
            'relevance',
            'date',
            'views',
            'rating',
            'indie_priority',
            'subscribers_asc',
            'subscribers_desc',
            'recent_activity',
          ],
        },
        publishedAfter: { type: 'string', description: 'ISO 8601 date' },
        publishedBefore: { type: 'string', description: 'ISO 8601 date' },
        duration: { type: 'string', enum: ['any', 'short', 'medium', 'long'] },
        minSubs: { type: 'number' },
        maxSubs: { type: 'number' },
        creatorOnly: { type: 'boolean' },
        uniqueChannels: { type: 'boolean' },
        regionCode: { type: 'string', description: 'ISO country e.g. US, VN, JP' },
        categoryId: { type: 'string' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
    },
  },
  {
    name: 'yt_videos',
    description:
      'Batch-fetch lean video metadata, views/likes/velocity, chapters, SponsorBlock segments, and ReturnYouTubeDislike stats.',
    inputSchema: {
      type: 'object',
      properties: {
        videos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Video IDs or URLs (1-50 in a single batch)',
        },
        descriptionDetail: { type: 'string', enum: ['none', 'snippet', 'full'] },
        includeTags: { type: 'boolean' },
        includeChapters: { type: 'boolean' },
        includeSponsorBlock: { type: 'boolean', description: 'Include sponsor skip ranges & highlight timestamp' },
        includeDislikes: { type: 'boolean', description: 'Include ReturnYouTubeDislike counts & approval %' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['videos'],
    },
  },
  {
    name: 'yt_transcript',
    description:
      'Fetch, search, chapter-split, sponsor-strip, or translate transcripts for 1 or multiple videos (0 API cost).',
    inputSchema: {
      type: 'object',
      properties: {
        videos: { type: 'array', items: { type: 'string' }, description: 'Video IDs or URLs' },
        mode: {
          type: 'string',
          enum: ['key_segments', 'full', 'timestamped', 'chapters', 'search', 'srt', 'vtt'],
          description: 'Default key_segments (first 45s Hook + last 35s Outro saves 85% tokens)',
        },
        lang: { type: 'string', description: 'Preferred language code e.g. en, vi, ja' },
        translateTo: { type: 'string', description: 'Translate captions on-the-fly e.g. vi, en, es' },
        query: { type: 'string', description: 'Keyword when mode="search"' },
        stripSponsors: { type: 'boolean', description: 'Remove SponsorBlock sponsor/intro segments' },
        saveToFile: { type: 'string', description: 'Optional file path to save full transcript directly' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['videos'],
    },
  },
  {
    name: 'yt_channels',
    description:
      'Get channel stats, emails/links, creator classification, upload cadence, and recent videos/Shorts/top_videos/playlists/RSS by @handle, URL, or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        channels: { type: 'array', items: { type: 'string' }, description: '@handles, URLs, or UC... IDs' },
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['stats', 'videos', 'shorts', 'top_videos', 'playlists', 'rss'],
          },
          description: 'Default: ["stats"]',
        },
        maxItems: { type: 'number', description: 'Items per tab (default 15)' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['channels'],
    },
  },
  {
    name: 'yt_comments',
    description:
      'List video comments OR run Audience Intelligence Mining (questions, video requests, pain points, viewer timestamps, sentiment).',
    inputSchema: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'Video ID or URL' },
        action: { type: 'string', enum: ['list', 'mine'], description: 'Default: list' },
        maxResults: { type: 'number', description: 'Default 30 (or 60 for mine)' },
        sortBy: { type: 'string', enum: ['top', 'newest'] },
        includeReplies: { type: 'boolean' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['video'],
    },
  },
  {
    name: 'yt_playlists',
    description: 'Fetch YouTube playlist metadata and video items.',
    inputSchema: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Playlist ID or URL' },
        maxResults: { type: 'number', description: 'Default 50' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['playlist'],
    },
  },
  {
    name: 'yt_outliers',
    description:
      'TubeLab & Kirbah Outlier Engine: find viral outlier videos (views/subs), related competitor outliers, consistent outlier channels, or trending title templates.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['videos', 'related_outliers', 'consistent_channels', 'trending_formats'],
          description: 'Default: videos',
        },
        query: { type: 'string', description: 'Niche/topic query (for videos, consistent_channels, trending_formats)' },
        seedChannel: { type: 'string', description: '@handle, URL, or ID (for related_outliers)' },
        minOutlierScore: { type: 'number', description: 'Minimum views/subscribers ratio (default 1.5)' },
        maxSubs: { type: 'number', description: 'Max channel subscribers filter' },
        minSubs: { type: 'number' },
        publishedAfter: { type: 'string', description: 'ISO 8601 date' },
        videoType: { type: 'string', enum: ['any', 'long', 'short'] },
        channelAge: { type: 'string', enum: ['NEW', 'ESTABLISHED', 'ANY'] },
        consistencyLevel: { type: 'string', enum: ['MODERATE', 'HIGH'] },
        outlierMagnitude: { type: 'string', enum: ['STANDARD', 'STRONG'] },
        maxResults: { type: 'number', description: 'Default 12' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
    },
  },
  {
    name: 'yt_discover',
    description:
      'Niche & Competitor Suite: find similar channels, discover creators mentioning a topic, validate niche saturation/RPM, or compare channels side-by-side.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['related_channels', 'find_creators', 'analyze_niche', 'compare_channels'],
        },
        query: { type: 'string', description: 'Topic/niche (for find_creators or analyze_niche)' },
        seedChannel: { type: 'string', description: '@handle or ID (for related_channels)' },
        channels: { type: 'array', items: { type: 'string' }, description: '2-10 channels (for compare_channels)' },
        minSubs: { type: 'number' },
        maxSubs: { type: 'number' },
        creatorOnly: { type: 'boolean' },
        publishedAfter: { type: 'string' },
        sortBy: { type: 'string', enum: ['relevance', 'indie_priority', 'subscribers_desc', 'recent_activity'] },
        maxResults: { type: 'number' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'yt_packaging',
    description:
      'Audit video packaging: Title CTR score, First-40s Hook speaking WPM & open-loop triggers, SEO tag density, and high-res thumbnails.',
    inputSchema: {
      type: 'object',
      properties: {
        videos: { type: 'array', items: { type: 'string' }, description: 'Video IDs or URLs' },
        includeHook: { type: 'boolean', description: 'Analyze first 40s transcript hook & WPM (default true)' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['videos'],
    },
  },
  {
    name: 'yt_kb',
    description:
      'Local Hybrid RAG Knowledge Base (SQLite FTS5 BM25 + Vector RRF): index video transcripts and semantically search exact timestamped moments.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['index', 'search', 'list', 'remove', 'clear'] },
        videos: { type: 'array', items: { type: 'string' }, description: 'Video IDs/URLs to index or remove' },
        playlist: { type: 'string', description: 'Optional playlist ID/URL to batch-index' },
        query: { type: 'string', description: 'Semantic/lexical query when action="search"' },
        lang: { type: 'string', description: 'Transcript language when indexing' },
        limit: { type: 'number', description: 'Max search hits (default 8)' },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'yt_export',
    description:
      'Export subtitles (SRT/VTT/TXT), high-res thumbnails, full JSON metadata to disk, or extract direct audio stream URL via yt-dlp.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['transcript', 'thumbnail', 'metadata_json', 'ytdlp_audio_url'] },
        video: { type: 'string', description: 'Video ID or URL' },
        outputPath: { type: 'string', description: 'Destination file path on disk' },
        subFormat: { type: 'string', enum: ['srt', 'vtt', 'txt', 'json'] },
        lang: { type: 'string' },
      },
      required: ['target', 'video'],
    },
  },
  {
    name: 'yt_studio',
    description:
      'Connect & manage YOUR OWN YouTube channel: instant @handle binding OR full Google OAuth2 YouTube Studio Analytics (retention, watch time, traffic, revenue), edit video title/tags/privacy, upload thumbnails/videos, manage playlists, and reply to comments.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'bind_channel',
            'start_oauth',
            'my_overview',
            'analytics',
            'update_video',
            'set_thumbnail',
            'reply_comment',
            'playlist_manage',
            'upload_video',
            'disconnect',
          ],
          description: 'Default: status',
        },
        channel: { type: 'string', description: 'Your @handle, URL, or UC... ID (for bind_channel)' },
        clientSecretFile: { type: 'string', description: 'Path to Google OAuth client_secret.json (for start_oauth)' },
        clientId: { type: 'string' },
        clientSecret: { type: 'string' },
        period: { type: 'string', enum: ['7d', '28d', '90d', '365d'] },
        dimensions: { type: 'string', description: 'e.g. day, video, insightTrafficSourceType, country' },
        metrics: { type: 'string', description: 'Comma-separated YouTube Analytics v2 metrics' },
        video: { type: 'string', description: 'Video ID or URL' },
        filePath: { type: 'string', description: 'Local video or thumbnail file path' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        privacyStatus: { type: 'string', enum: ['private', 'unlisted', 'public'] },
        publishAt: { type: 'string', description: 'ISO 8601 scheduled publish timestamp' },
        parentCommentId: { type: 'string' },
        text: { type: 'string', description: 'Comment or reply text' },
        playlistId: { type: 'string' },
        subAction: { type: 'string', enum: ['create', 'add_video'] },
        format: { type: 'string', enum: ['compact', 'markdown', 'json'] },
      },
    },
  },
  {
    name: 'yt_system',
    description:
      'Inspect L1/L2 cache hit rate, latency, YouTube API key pool & quota saved, Knowledge Base stats, TubeLab balance, or clear cache.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'clear_cache'], description: 'Default: status' },
        namespace: { type: 'string', description: 'Optional cache namespace to clear' },
      },
    },
  },
];

const LITE_TOOL_NAMES = new Set(['yt_search', 'yt_videos', 'yt_transcript', 'yt_channels']);

/**
 * Full Compatibility Alias Schemas (TubeLab + Zubeid + IA-Programming + Kirbah)
 * Registered in list_tools when CTDO_TOOL_MODE=full, and ALWAYS accepted in call_tool!
 */
export const COMPATIBILITY_ALIAS_TOOLS: Tool[] = [
  // TubeLab aliases
  {
    name: 'get_channel',
    description: 'Get channel details by ID, URL, or @handle (TubeLab compatible).',
    inputSchema: { type: 'object', properties: { channel: { type: 'string' }, channelId: { type: 'string' } } },
  },
  {
    name: 'get_channel_videos',
    description: 'Get recent long-form videos from a channel (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, channelId: { type: 'string' }, maxResults: { type: 'number' } },
    },
  },
  {
    name: 'get_channel_shorts',
    description: 'Get recent YouTube Shorts from a channel (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, channelId: { type: 'string' }, maxResults: { type: 'number' } },
    },
  },
  {
    name: 'get_video',
    description: 'Get detailed video metadata and stats (TubeLab compatible).',
    inputSchema: { type: 'object', properties: { video: { type: 'string' }, videoId: { type: 'string' } } },
  },
  {
    name: 'get_video_transcript',
    description: 'Get full video transcript (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: { video: { type: 'string' }, videoId: { type: 'string' }, lang: { type: 'string' } },
    },
  },
  {
    name: 'get_video_comments',
    description: 'Get top comments for a video (TubeLab & Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: { video: { type: 'string' }, videoId: { type: 'string' }, maxResults: { type: 'number' } },
    },
  },
  {
    name: 'search_channels',
    description: 'Search channels with subscriber and creator filters (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        minSubscribers: { type: 'number' },
        maxSubscribers: { type: 'number' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_related_channels',
    description: 'Find channels similar to a given seed channel (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, channelId: { type: 'string' }, maxResults: { type: 'number' } },
    },
  },
  {
    name: 'search_outliers',
    description: 'Find viral outlier videos outperforming subscriber baselines (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        minOutlierScore: { type: 'number' },
        maxSubscribers: { type: 'number' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_related_outliers',
    description: 'Find outlier videos from channels similar to a target channel (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        channelId: { type: 'string' },
        minOutlierScore: { type: 'number' },
        maxResults: { type: 'number' },
      },
    },
  },
  {
    name: 'search_trending_formats',
    description: 'Extract viral title templates/formats from outlier videos (TubeLab compatible).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'get_credits_balance',
    description: 'Check TubeLab credits, API quota pool, and CTDO cache telemetry.',
    inputSchema: { type: 'object', properties: {} },
  },

  // Zubeid aliases
  {
    name: 'videos_getVideo',
    description: 'Get video details (Zubeid compatible).',
    inputSchema: { type: 'object', properties: { videoId: { type: 'string' } }, required: ['videoId'] },
  },
  {
    name: 'videos_searchVideos',
    description: 'Search YouTube videos with advanced creator/subscriber filters (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
        order: { type: 'string' },
        publishedAfter: { type: 'string' },
        publishedBefore: { type: 'string' },
        channelId: { type: 'string' },
        uniqueChannels: { type: 'boolean' },
        channelMinSubscribers: { type: 'number' },
        channelMaxSubscribers: { type: 'number' },
        creatorOnly: { type: 'boolean' },
        sortBy: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'transcripts_getTranscript',
    description: 'Get video transcript (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: { videoId: { type: 'string' }, language: { type: 'string' } },
      required: ['videoId'],
    },
  },
  {
    name: 'channels_getChannel',
    description: 'Get channel info (Zubeid compatible).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'] },
  },
  {
    name: 'channels_getChannels',
    description: 'Batch get multiple channels (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: { channelIds: { type: 'array', items: { type: 'string' } } },
      required: ['channelIds'],
    },
  },
  {
    name: 'channels_searchChannels',
    description: 'Search channels (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
        minSubscribers: { type: 'number' },
        maxSubscribers: { type: 'number' },
        creatorOnly: { type: 'boolean' },
        sortBy: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'channels_findCreators',
    description: 'Find creator channels from video mentions (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
        channelMinSubscribers: { type: 'number' },
        channelMaxSubscribers: { type: 'number' },
        creatorOnly: { type: 'boolean' },
        sortBy: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'channels_listVideos',
    description: 'List channel videos (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['channelId'],
    },
  },
  {
    name: 'playlists_getPlaylist',
    description: 'Get playlist details (Zubeid compatible).',
    inputSchema: { type: 'object', properties: { playlistId: { type: 'string' } }, required: ['playlistId'] },
  },
  {
    name: 'playlists_getPlaylistItems',
    description: 'Get playlist items (Zubeid compatible).',
    inputSchema: {
      type: 'object',
      properties: { playlistId: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['playlistId'],
    },
  },

  // IA-Programming aliases
  {
    name: 'search-youtube',
    description: 'Search YouTube videos without API key (IA-Programming compatible).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'get-transcript',
    description: 'Get transcript from video URL (IA-Programming compatible).',
    inputSchema: { type: 'object', properties: { video_url: { type: 'string' } }, required: ['video_url'] },
  },
  {
    name: 'store-video-info',
    description: 'Index video transcript & metadata into local RAG DB (IA-Programming compatible).',
    inputSchema: {
      type: 'object',
      properties: { video_url: { type: 'string' }, metadata: { type: 'object' } },
      required: ['video_url'],
    },
  },
  {
    name: 'search-transcripts',
    description: 'Semantic/hybrid search across stored video transcripts (IA-Programming compatible).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },

  // Kirbah aliases
  {
    name: 'getVideoDetails',
    description: 'Batch get token-optimized video details (Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'string' } },
        includeTags: { type: 'boolean' },
        descriptionDetail: { type: 'string', enum: ['NONE', 'SNIPPET', 'LONG'] },
      },
      required: ['videoIds'],
    },
  },
  {
    name: 'getTranscripts',
    description: 'Batch get transcripts in key_segments or full_text format (Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'string' } },
        lang: { type: 'string' },
        format: { type: 'string', enum: ['full_text', 'key_segments'] },
      },
      required: ['videoIds'],
    },
  },
  {
    name: 'getChannelStatistics',
    description: 'Batch get lean channel stats (Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: { channelIds: { type: 'array', items: { type: 'string' } } },
      required: ['channelIds'],
    },
  },
  {
    name: 'getChannelTopVideos',
    description: 'Get top-performing videos of a channel (Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['channelId'],
    },
  },
  {
    name: 'getTrendingVideos',
    description: 'Get trending videos by region and category (Kirbah compatible).',
    inputSchema: {
      type: 'object',
      properties: { regionCode: { type: 'string' }, categoryId: { type: 'string' }, maxResults: { type: 'number' } },
    },
  },
  {
    name: 'getVideoCategories',
    description: 'Get YouTube video categories for a region (Kirbah compatible).',
    inputSchema: { type: 'object', properties: { regionCode: { type: 'string' } } },
  },
  {
    name: 'findConsistentOutlierChannels',
    description: '4-phase Consistent Outlier Channel Finder (Kirbah compatible, no MongoDB required!).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        channelAge: { type: 'string', enum: ['NEW', 'ESTABLISHED'] },
        consistencyLevel: { type: 'string', enum: ['MODERATE', 'HIGH'] },
        outlierMagnitude: { type: 'string', enum: ['STANDARD', 'STRONG'] },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

export function getToolsForMode(mode?: ToolWeightMode): Tool[] {
  const m = (mode || (process.env.CTDO_TOOL_MODE as ToolWeightMode) || 'compact').toLowerCase() as ToolWeightMode;
  if (m === 'lite') {
    return CORE_POWER_TOOLS.filter((t) => LITE_TOOL_NAMES.has(t.name));
  }
  if (m === 'full') {
    return [...CORE_POWER_TOOLS, ...COMPATIBILITY_ALIAS_TOOLS];
  }
  return CORE_POWER_TOOLS;
}
