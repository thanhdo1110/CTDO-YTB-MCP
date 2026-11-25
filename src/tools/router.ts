import {
  analyzeNicheOpportunity,
  analyzePackaging,
  compareChannelsMatrix,
  exportYouTubeAsset,
  findCreatorsByTopic,
  mineVideoComments,
} from '../analytics/creator-niche.js';
import {
  findConsistentOutlierChannels,
  findRelatedChannels,
  searchOutlierVideos,
  searchRelatedOutliers,
  searchTrendingFormats,
} from '../analytics/outliers.js';
import { globalCache } from '../core/cache.js';
import { globalKB } from '../core/knowledge-base.js';
import type { OutputFormat } from '../core/types.js';
import { extractVideoId, mapConcurrent, serializeOutput } from '../core/utils.js';
import { fetchTubeLabBalance } from '../providers/enrichers.js';
import { hybridYouTube } from '../providers/hybrid-client.js';
import { fetchInnerTubeTranscript } from '../providers/innertube.js';
import {
  bindMyChannel,
  disconnectMyChannel,
  getMyChannelOverview,
  getMyChannelStatus,
  manageMyPlaylist,
  postOrReplyComment,
  queryMyStudioAnalytics,
  setMyVideoThumbnail,
  startYouTubeOAuthFlow,
  updateMyVideo,
  uploadVideoToMyChannel,
} from '../providers/oauth-studio.js';
import { youtubeApiPool } from '../providers/youtube-api.js';

/**
 * Universal Tool Dispatcher:
 * Routes all 12 Core Power Tools AND all 28+ Compatibility Aliases (TubeLab, Zubeid, IA-Programming, Kirbah)
 * regardless of which CTDO_TOOL_MODE is active!
 */
export async function dispatchToolCall(
  name: string,
  rawArgs: Record<string, any> = {}
): Promise<{ text: string }> {
  const defaultFmt = (process.env.CTDO_OUTPUT_FORMAT as OutputFormat) || 'compact';
  const outFormat: OutputFormat =
    rawArgs.format === 'markdown' || rawArgs.format === 'json' || rawArgs.format === 'compact'
      ? rawArgs.format
      : defaultFmt;

  const data = await executeToolData(name, rawArgs);
  return { text: serializeOutput(data, outFormat) };
}

async function executeToolData(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    // ========================================================================
    // 12 CTDO Power Tools
    // ========================================================================
    case 'yt_search':
      return hybridYouTube.search({
        query: args.query,
        target: args.target,
        maxResults: args.maxResults,
        sort: args.sort,
        publishedAfter: args.publishedAfter,
        publishedBefore: args.publishedBefore,
        duration: args.duration,
        minSubs: args.minSubs,
        maxSubs: args.maxSubs,
        creatorOnly: args.creatorOnly,
        uniqueChannels: args.uniqueChannels,
        regionCode: args.regionCode,
        categoryId: args.categoryId,
      });

    case 'yt_videos': {
      const list = Array.isArray(args.videos) ? args.videos : [args.videos].filter(Boolean);
      return hybridYouTube.getVideos({
        videos: list,
        descriptionDetail: args.descriptionDetail,
        includeTags: args.includeTags,
        includeChapters: args.includeChapters,
        includeSponsorBlock: args.includeSponsorBlock,
        includeDislikes: args.includeDislikes,
      });
    }

    case 'yt_transcript': {
      const list = Array.isArray(args.videos) ? args.videos : [args.videos].filter(Boolean);
      return hybridYouTube.getTranscripts({
        videos: list,
        mode: args.mode,
        lang: args.lang,
        translateTo: args.translateTo,
        query: args.query,
        stripSponsors: args.stripSponsors,
        saveToFile: args.saveToFile,
      });
    }

    case 'yt_channels': {
      const list = Array.isArray(args.channels) ? args.channels : [args.channels].filter(Boolean);
      return hybridYouTube.getChannels({
        channels: list,
        include: args.include,
        maxItems: args.maxItems,
      });
    }

    case 'yt_comments': {
      if (args.action === 'mine') {
        return mineVideoComments(args.video, args.maxResults || 60);
      }
      return hybridYouTube.getComments({
        video: args.video,
        maxResults: args.maxResults,
        sortBy: args.sortBy,
        includeReplies: args.includeReplies,
      });
    }

    case 'yt_playlists':
      return hybridYouTube.getPlaylist(args.playlist, args.maxResults || 50);

    case 'yt_outliers': {
      const action = args.action || 'videos';
      if (action === 'related_outliers') {
        if (!args.seedChannel) throw new Error('`seedChannel` is required for related_outliers');
        return searchRelatedOutliers(args.seedChannel, args.minOutlierScore ?? 1.5, args.maxResults || 15);
      }
      if (action === 'consistent_channels') {
        if (!args.query) throw new Error('`query` is required for consistent_channels');
        return findConsistentOutlierChannels({
          query: args.query,
          channelAge: args.channelAge,
          consistencyLevel: args.consistencyLevel,
          outlierMagnitude: args.outlierMagnitude,
          maxSubs: args.maxSubs,
          maxResults: args.maxResults,
        });
      }
      if (action === 'trending_formats') {
        if (!args.query) throw new Error('`query` is required for trending_formats');
        return searchTrendingFormats({ query: args.query, maxFormats: args.maxResults || 10 });
      }
      if (!args.query) throw new Error('`query` is required for outlier videos search');
      return searchOutlierVideos({
        query: args.query,
        minOutlierScore: args.minOutlierScore,
        maxSubs: args.maxSubs,
        minSubs: args.minSubs,
        publishedAfter: args.publishedAfter,
        videoType: args.videoType,
        maxResults: args.maxResults,
      });
    }

    case 'yt_discover': {
      switch (args.action) {
        case 'related_channels':
          if (!args.seedChannel) throw new Error('`seedChannel` is required for related_channels');
          return findRelatedChannels(args.seedChannel, args.maxResults || 12);
        case 'find_creators':
          if (!args.query) throw new Error('`query` is required for find_creators');
          return findCreatorsByTopic({
            query: args.query,
            minSubs: args.minSubs,
            maxSubs: args.maxSubs,
            creatorOnly: args.creatorOnly,
            publishedAfter: args.publishedAfter,
            sortBy: args.sortBy,
            maxResults: args.maxResults,
          });
        case 'analyze_niche':
          if (!args.query) throw new Error('`query` is required for analyze_niche');
          return analyzeNicheOpportunity(args.query);
        case 'compare_channels':
          if (!Array.isArray(args.channels) || args.channels.length < 2) {
            throw new Error('Provide at least 2 channels in `channels` array for compare_channels');
          }
          return compareChannelsMatrix(args.channels);
        default:
          throw new Error(`Unknown yt_discover action: ${args.action}`);
      }
    }

    case 'yt_packaging':
      return analyzePackaging(args.videos || [], args.includeHook !== false);

    case 'yt_kb': {
      switch (args.action) {
        case 'index': {
          let targets: string[] = Array.isArray(args.videos) ? [...args.videos] : [];
          if (args.playlist) {
            const pl = await hybridYouTube.getPlaylist(args.playlist, 30);
            for (const item of pl.items || []) {
              targets.push(item.id);
            }
          }
          targets = Array.from(new Set(targets.map(extractVideoId)));
          if (targets.length === 0) throw new Error('Provide `videos` or `playlist` to index');

          const metas = await hybridYouTube.getVideos({
            videos: targets,
            descriptionDetail: 'snippet',
          });
          const metaMap = new Map(metas.map((m) => [m.id, m]));

          const indexed = await mapConcurrent(targets, 4, async (id) => {
            const tx = await fetchInnerTubeTranscript(id, args.lang || 'en');
            const meta = metaMap.get(id) || { id, title: id };
            return globalKB.indexVideo(meta, tx.segments);
          });
          return { indexedCount: indexed.length, results: indexed };
        }
        case 'search':
          if (!args.query) throw new Error('`query` is required for yt_kb search');
          return globalKB.search(args.query, args.limit || 8, args.videos?.map(extractVideoId));
        case 'list':
          return globalKB.listVideos();
        case 'remove': {
          const ids = (args.videos || []).map(extractVideoId);
          return { removed: ids.filter((id: string) => globalKB.removeVideo(id)) };
        }
        case 'clear':
          return globalKB.clearAll();
        default:
          throw new Error(`Unknown yt_kb action: ${args.action}`);
      }
    }

    case 'yt_export':
      return exportYouTubeAsset({
        target: args.target,
        video: args.video,
        outputPath: args.outputPath,
        format: args.subFormat,
        lang: args.lang,
      });

    case 'yt_studio': {
      const action = args.action || 'status';
      switch (action) {
        case 'status':
          return getMyChannelStatus();
        case 'bind_channel':
          if (!args.channel) throw new Error('`channel` (@handle, URL, or ID) is required for bind_channel');
          return bindMyChannel(args.channel);
        case 'start_oauth':
          return startYouTubeOAuthFlow({
            clientSecretFile: args.clientSecretFile,
            clientId: args.clientId,
            clientSecret: args.clientSecret,
          });
        case 'my_overview':
          return getMyChannelOverview(args.maxResults || 10);
        case 'analytics':
          return queryMyStudioAnalytics({
            period: args.period,
            dimensions: args.dimensions,
            metrics: args.metrics,
          });
        case 'update_video':
          if (!args.video) throw new Error('`video` is required for update_video');
          return updateMyVideo({
            video: args.video,
            title: args.title,
            description: args.description,
            tags: args.tags,
            privacyStatus: args.privacyStatus,
          });
        case 'set_thumbnail':
          if (!args.video || !args.filePath) throw new Error('`video` and `filePath` are required');
          return setMyVideoThumbnail(args.video, args.filePath);
        case 'reply_comment':
          if (!args.text) throw new Error('`text` is required for reply_comment');
          return postOrReplyComment({
            parentCommentId: args.parentCommentId,
            video: args.video,
            text: args.text,
          });
        case 'playlist_manage':
          return manageMyPlaylist({
            subAction: args.subAction || 'create',
            title: args.title,
            description: args.description,
            privacyStatus: args.privacyStatus,
            playlistId: args.playlistId,
            video: args.video,
          });
        case 'upload_video':
          if (!args.filePath || !args.title) throw new Error('`filePath` and `title` are required for upload_video');
          return uploadVideoToMyChannel({
            filePath: args.filePath,
            title: args.title,
            description: args.description,
            tags: args.tags,
            privacyStatus: args.privacyStatus,
            publishAt: args.publishAt,
            thumbnailPath: args.thumbnailPath,
          });
        case 'disconnect':
          return disconnectMyChannel(true);
        default:
          throw new Error(`Unknown yt_studio action: ${action}`);
      }
    }

    case 'yt_system':
    case 'get_credits_balance': {
      if (args.action === 'clear_cache') {
        return globalCache.clear(args.namespace);
      }
      const tubelab = await fetchTubeLabBalance();
      return {
        server: 'CTDO YTB MCP v1.0.0',
        toolWeightMode: process.env.CTDO_TOOL_MODE || 'compact',
        zeroApiKeyEngine: 'InnerTube 2026 Active (IOS + ANDROID + WEB)',
        youtubeApiPool: youtubeApiPool.getStatus(),
        cache: globalCache.getTelemetry(),
        knowledgeBase: globalKB.getStats(),
        tubelab,
      };
    }

    // ========================================================================
    // TubeLab Compatibility Aliases
    // ========================================================================
    case 'get_channel':
    case 'channels_getChannel': {
      const ch = args.channel || args.channelId;
      const [res] = await hybridYouTube.getChannels({ channels: [ch], include: ['stats'] });
      return res?.channel || null;
    }
    case 'get_channel_videos':
    case 'channels_listVideos': {
      const ch = args.channel || args.channelId;
      const [res] = await hybridYouTube.getChannels({
        channels: [ch],
        include: ['videos'],
        maxItems: args.maxResults || 20,
      });
      return res?.videos || [];
    }
    case 'get_channel_shorts': {
      const ch = args.channel || args.channelId;
      const [res] = await hybridYouTube.getChannels({
        channels: [ch],
        include: ['shorts'],
        maxItems: args.maxResults || 20,
      });
      return res?.shorts || [];
    }
    case 'get_video':
    case 'videos_getVideo': {
      const vid = args.video || args.videoId;
      const [res] = await hybridYouTube.getVideos({
        videos: [vid],
        descriptionDetail: 'snippet',
        includeTags: true,
        includeChapters: true,
      });
      return res || null;
    }
    case 'get_video_transcript':
    case 'transcripts_getTranscript':
    case 'get-transcript': {
      const vid = args.video || args.videoId || args.video_url;
      const [res] = await hybridYouTube.getTranscripts({
        videos: [vid],
        mode: 'full',
        lang: args.lang || args.language || 'en',
      });
      return res || null;
    }
    case 'get_video_comments':
      return hybridYouTube.getComments({
        video: args.video || args.videoId,
        maxResults: args.maxResults || 30,
      });
    case 'search_channels':
    case 'channels_searchChannels':
      return hybridYouTube.search({
        query: args.query,
        target: 'channel',
        minSubs: args.minSubscribers,
        maxSubs: args.maxSubscribers,
        creatorOnly: args.creatorOnly,
        sort: args.sortBy,
        maxResults: args.maxResults || 15,
      });
    case 'search_related_channels':
      return findRelatedChannels(args.channel || args.channelId, args.maxResults || 12);
    case 'search_outliers':
      return searchOutlierVideos({
        query: args.query,
        minOutlierScore: args.minOutlierScore,
        maxSubs: args.maxSubscribers,
        maxResults: args.maxResults || 15,
      });
    case 'search_related_outliers':
      return searchRelatedOutliers(
        args.channel || args.channelId,
        args.minOutlierScore ?? 1.5,
        args.maxResults || 15
      );
    case 'search_trending_formats':
      return searchTrendingFormats({ query: args.query, maxFormats: args.maxResults || 10 });

    // ========================================================================
    // Zubeid, IA-Programming & Kirbah Compatibility Aliases
    // ========================================================================
    case 'videos_searchVideos':
    case 'search-youtube':
      return hybridYouTube.search({
        query: args.query,
        target: 'video',
        maxResults: args.maxResults || args.max_results || 10,
        sort: args.sortBy || args.order,
        publishedAfter: args.publishedAfter,
        publishedBefore: args.publishedBefore,
        channelId: args.channelId,
        uniqueChannels: args.uniqueChannels,
        minSubs: args.channelMinSubscribers,
        maxSubs: args.channelMaxSubscribers,
        creatorOnly: args.creatorOnly,
      });
    case 'channels_getChannels':
    case 'getChannelStatistics': {
      const list = await hybridYouTube.getChannels({
        channels: args.channelIds || [],
        include: ['stats'],
      });
      return list.map((x) => x.channel);
    }
    case 'channels_findCreators':
      return findCreatorsByTopic({
        query: args.query,
        minSubs: args.channelMinSubscribers,
        maxSubs: args.channelMaxSubscribers,
        creatorOnly: args.creatorOnly,
        sortBy: args.sortBy,
        maxResults: args.maxResults || 12,
      });
    case 'playlists_getPlaylist':
      return hybridYouTube.getPlaylist(args.playlistId, 1);
    case 'playlists_getPlaylistItems': {
      const pl = await hybridYouTube.getPlaylist(args.playlistId, args.maxResults || 50);
      return pl.items || [];
    }
    case 'store-video-info': {
      const id = extractVideoId(args.video_url);
      const [[meta], tx] = await Promise.all([
        hybridYouTube.getVideos({ videos: [id], descriptionDetail: 'snippet' }),
        fetchInnerTubeTranscript(id, 'en'),
      ]);
      return globalKB.indexVideo(meta || { id, title: id, ...args.metadata }, tx.segments);
    }
    case 'search-transcripts':
      return globalKB.search(args.query, args.limit || 5);
    case 'getVideoDetails': {
      const dm =
        args.descriptionDetail === 'LONG'
          ? 'full'
          : args.descriptionDetail === 'SNIPPET'
            ? 'snippet'
            : 'none';
      return hybridYouTube.getVideos({
        videos: args.videoIds || [],
        includeTags: args.includeTags,
        descriptionDetail: dm,
      });
    }
    case 'getTranscripts':
      return hybridYouTube.getTranscripts({
        videos: args.videoIds || [],
        lang: args.lang || 'en',
        mode: args.format === 'full_text' ? 'full' : 'key_segments',
      });
    case 'getChannelTopVideos': {
      const [res] = await hybridYouTube.getChannels({
        channels: [args.channelId],
        include: ['top_videos'],
        maxItems: args.maxResults || 10,
      });
      return res?.topVideos || [];
    }
    case 'getTrendingVideos':
      return hybridYouTube.search({
        target: 'trending',
        regionCode: args.regionCode,
        categoryId: args.categoryId,
        maxResults: args.maxResults || 15,
      });
    case 'getVideoCategories':
      return hybridYouTube.search({ target: 'categories', regionCode: args.regionCode });
    case 'findConsistentOutlierChannels':
      return findConsistentOutlierChannels({
        query: args.query,
        channelAge: args.channelAge,
        consistencyLevel: args.consistencyLevel,
        outlierMagnitude: args.outlierMagnitude,
        maxResults: args.maxResults || 10,
      });

    default:
      throw new Error(`Unknown tool "${name}". Use yt_search, yt_videos, yt_transcript, yt_channels, yt_comments, yt_playlists, yt_outliers, yt_discover, yt_packaging, yt_kb, yt_export, or yt_system.`);
  }
}
