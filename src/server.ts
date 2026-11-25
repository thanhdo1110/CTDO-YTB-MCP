import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { globalCache } from './core/cache.js';
import { globalKB } from './core/knowledge-base.js';
import type { ToolWeightMode } from './core/types.js';
import { serializeOutput } from './core/utils.js';
import { hybridYouTube } from './providers/hybrid-client.js';
import { youtubeApiPool } from './providers/youtube-api.js';
import { getToolsForMode } from './tools/definitions.js';
import { dispatchToolCall } from './tools/router.js';

export const CTDO_VERSION = '1.2.0';

export function createCtdoMcpServer(modeOverride?: ToolWeightMode): Server {
  const server = new Server(
    {
      name: 'ctdo-ytb-mcp',
      version: CTDO_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // 1. Tools (Lite / Compact / Full weight modes)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolsForMode(modeOverride),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const { text } = await dispatchToolCall(name, (args || {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error [${name}]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // 2. MCP Resources & Resource Templates (Zero-config direct URI reads)
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'youtube://system/telemetry',
        name: 'CTDO YTB MCP Telemetry & Cache Status',
        mimeType: 'application/json',
        description: 'Live L1/L2 SQLite cache hit rate, API key pool status, and RAG KB metrics.',
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: 'youtube://transcript/{videoId}',
        name: 'YouTube Video Transcript',
        mimeType: 'application/json',
        description: 'Read full transcript for any YouTube video ID.',
      },
      {
        uriTemplate: 'youtube://transcript/{videoId}/{lang}',
        name: 'YouTube Localized/Translated Transcript',
        mimeType: 'application/json',
        description: 'Read or auto-translate transcript in a target language (e.g. vi, en, ja).',
      },
      {
        uriTemplate: 'youtube://video/{videoId}',
        name: 'YouTube Video Full Intelligence',
        mimeType: 'application/json',
        description: 'Lean video metadata, engagement ratios, chapters, SponsorBlock, and dislikes.',
      },
      {
        uriTemplate: 'youtube://channel/{handleOrId}',
        name: 'YouTube Channel Intelligence',
        mimeType: 'application/json',
        description: 'Channel stats, emails/links, upload cadence, and recent videos.',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uriStr = request.params.uri;
    const url = new URL(uriStr);
    const host = url.hostname;
    const parts = url.pathname.split('/').filter(Boolean);

    let payload: unknown;

    if (host === 'system' && parts[0] === 'telemetry') {
      payload = {
        version: CTDO_VERSION,
        cache: globalCache.getTelemetry(),
        apiPool: youtubeApiPool.getStatus(),
        kb: globalKB.getStats(),
      };
    } else if (host === 'transcript' && parts[0]) {
      const videoId = decodeURIComponent(parts[0]);
      const lang = parts[1] ? decodeURIComponent(parts[1]) : 'en';
      const [tx] = await hybridYouTube.getTranscripts({
        videos: [videoId],
        mode: 'full',
        lang,
        translateTo: parts[1] ? lang : undefined,
      });
      payload = tx;
    } else if (host === 'video' && parts[0]) {
      const [vid] = await hybridYouTube.getVideos({
        videos: [decodeURIComponent(parts[0])],
        descriptionDetail: 'snippet',
        includeTags: true,
        includeChapters: true,
        includeSponsorBlock: true,
        includeDislikes: true,
      });
      payload = vid;
    } else if (host === 'channel' && parts[0]) {
      const [ch] = await hybridYouTube.getChannels({
        channels: [decodeURIComponent(parts[0])],
        include: ['stats', 'videos'],
        maxItems: 10,
      });
      payload = ch;
    } else {
      throw new Error(`Unsupported YouTube resource URI: ${uriStr}`);
    }

    return {
      contents: [
        {
          uri: uriStr,
          mimeType: 'application/json',
          text: serializeOutput(payload, 'compact'),
        },
      ],
    };
  });

  // 3. Built-in Creator & Research MCP Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'viral-outlier-blueprint',
        description:
          'Discover outlier videos in a niche, extract viral title formulas, mine viewer comments, and generate 5 data-backed video ideas.',
        arguments: [{ name: 'niche', description: 'Target YouTube niche or topic', required: true }],
      },
      {
        name: 'channel-growth-audit',
        description:
          'Deep CreatorLens-style audit of a YouTube channel: packaging CTR, 40s hook WPM, Shorts vs Long split, and competitor outliers.',
        arguments: [{ name: 'channel', description: '@handle, URL, or Channel ID', required: true }],
      },
      {
        name: 'video-deep-digest',
        description:
          'Sponsor-stripped chapter breakdown, key takeaways, and audience Q&A / pain points mined from comments.',
        arguments: [{ name: 'video', description: 'YouTube video URL or ID', required: true }],
      },
      {
        name: 'niche-viability-report',
        description:
          'Validate a YouTube niche: breakout rate for small channels, saturation, estimated CPM/RPM, and top title templates.',
        arguments: [{ name: 'niche', description: 'Niche keyword', required: true }],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: pArgs } = request.params;
    const topic = pArgs?.niche || pArgs?.channel || pArgs?.video || '';

    const promptMap: Record<string, string> = {
      'viral-outlier-blueprint': `Run a complete viral research workflow for niche "${topic}":
1. Call yt_outliers (action="videos", query="${topic}", minOutlierScore=2) and yt_outliers (action="trending_formats", query="${topic}").
2. Pick the top 2 outlier videos and call yt_packaging + yt_comments (action="mine") on them.
3. Synthesize 5 high-CTR video concepts with exact title variations, thumbnail concepts, 40-second opening hooks, and audience pain points to solve.`,

      'channel-growth-audit': `Audit YouTube channel "${topic}":
1. Call yt_channels (channels=["${topic}"], include=["stats","videos","shorts","top_videos"]).
2. Call yt_packaging on its 3 newest videos and 2 top videos to compare title CTR score & hook speaking WPM.
3. Call yt_outliers (action="related_outliers", seedChannel="${topic}") to see what is working right now for peer channels.
4. Deliver concrete fixes for titles, hooks, upload cadence, and next 3 outlier-backed video topics.`,

      'video-deep-digest': `Create a sponsor-free deep digest of video "${topic}":
1. Call yt_videos (videos=["${topic}"], includeChapters=true, includeSponsorBlock=true, includeDislikes=true).
2. Call yt_transcript (videos=["${topic}"], mode="chapters", stripSponsors=true).
3. Call yt_comments (video="${topic}", action="mine") to surface viewer questions, complaints, and highlighted timestamps.`,

      'niche-viability-report': `Evaluate YouTube niche "${topic}":
1. Call yt_discover (action="analyze_niche", query="${topic}").
2. Call yt_outliers (action="consistent_channels", query="${topic}") to identify repeatable small/mid-sized winners.
3. Present an executive go/no-go verdict with saturation score, RPM range, benchmark channels, and winning formats.`,
    };

    const text = promptMap[name];
    if (!text) throw new Error(`Unknown prompt: ${name}`);

    return {
      description: `CTDO YTB MCP workflow: ${name}`,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text },
        },
      ],
    };
  });

  return server;
}

export async function startStdioMcpServer(modeOverride?: ToolWeightMode) {
  const server = createCtdoMcpServer(modeOverride);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export async function startHttpMcpServer(options: {
  host?: string;
  port?: number;
  stateless?: boolean;
  mode?: ToolWeightMode;
} = {}) {
  const host = options.host || process.env.MCP_HOST || '127.0.0.1';
  const port = options.port || Number(process.env.MCP_PORT || '8088');
  const stateless = options.stateless ?? process.env.MCP_STATELESS !== 'false';

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (url.pathname === '/ready' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          name: 'CTDO YTB MCP',
          version: CTDO_VERSION,
          transport: 'streamable-http',
          mode: options.mode || process.env.CTDO_TOOL_MODE || 'compact',
          cache: globalCache.getTelemetry(),
        })
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use /mcp or /ready' }));
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        parsedBody = raw ? JSON.parse(raw) : undefined;
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
            id: null,
          })
        );
        return;
      }
    }

    const mcpServer = createCtdoMcpServer(options.mode);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateless ? undefined : () => randomUUID(),
      enableJsonResponse: stateless,
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      mcpServer.close().catch(() => undefined);
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: err instanceof Error ? err.message : 'Internal server error' },
            id: null,
          })
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  console.error(`[CTDO YTB MCP v${CTDO_VERSION}] HTTP server listening at http://${host}:${port}/mcp`);
  return httpServer;
}
