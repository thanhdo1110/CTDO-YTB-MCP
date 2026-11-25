import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { getDataDir } from '../core/cache.js';
import type { LeanChannel } from '../core/types.js';
import { extractVideoId } from '../core/utils.js';
import { hybridYouTube } from './hybrid-client.js';

const ACCOUNT_FILE = () => join(getDataDir(), 'account.json');

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
];

export interface StoredAccountState {
  boundChannel?: {
    id: string;
    title: string;
    handle?: string;
    url: string;
    boundAt: string;
  };
  oauthClient?: {
    clientId: string;
    clientSecret: string;
  };
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scope?: string;
  };
}

function readAccountState(): StoredAccountState {
  const path = ACCOUNT_FILE();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredAccountState;
  } catch {
    return {};
  }
}

function saveAccountState(state: StoredAccountState): void {
  const path = ACCOUNT_FILE();
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
}

function resolveOAuthClient(
  state: StoredAccountState,
  opts?: { clientId?: string; clientSecret?: string; clientSecretFile?: string }
): { clientId: string; clientSecret: string } {
  if (opts?.clientSecretFile && existsSync(opts.clientSecretFile)) {
    const raw = JSON.parse(readFileSync(opts.clientSecretFile, 'utf8'));
    const cfg = raw.installed || raw.web || raw;
    if (cfg?.client_id && cfg?.client_secret) {
      return { clientId: String(cfg.client_id), clientSecret: String(cfg.client_secret) };
    }
  }

  const clientId = (opts?.clientId || process.env.GOOGLE_CLIENT_ID || state.oauthClient?.clientId || '').trim();
  const clientSecret = (
    opts?.clientSecret ||
    process.env.GOOGLE_CLIENT_SECRET ||
    state.oauthClient?.clientSecret ||
    ''
  ).trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing Google OAuth Client credentials. Provide `clientSecretFile` (downloaded JSON from Google Cloud Console -> Credentials -> OAuth 2.0 Desktop Client) or `clientId` + `clientSecret` (or env GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).'
    );
  }

  return { clientId, clientSecret };
}

/**
 * Bind user's public YouTube channel immediately by @handle, URL, or UC... ID (0 OAuth required!).
 */
export async function bindMyChannel(channelInput: string) {
  const [res] = await hybridYouTube.getChannels({
    channels: [channelInput],
    include: ['stats', 'videos'],
    maxItems: 5,
  });
  if (!res?.channel) {
    throw new Error(`Could not find YouTube channel: ${channelInput}`);
  }
  const state = readAccountState();
  state.boundChannel = {
    id: res.channel.id,
    title: res.channel.title,
    handle: res.channel.handle,
    url: res.channel.url,
    boundAt: new Date().toISOString(),
  };
  saveAccountState(state);

  return {
    connected: true,
    mode: state.tokens?.refreshToken ? 'oauth_studio_and_public' : 'public_bound',
    channel: res.channel,
    recentVideos: res.videos,
  };
}

/**
 * Start a local PKCE OAuth 2.0 Loopback flow (http://127.0.0.1:PORT/oauth2callback)
 * to connect the user's official YouTube Studio & Channel Management account!
 */
export async function startYouTubeOAuthFlow(options: {
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  port?: number;
  monetaryScope?: boolean;
}): Promise<{
  authUrl: string;
  redirectUri: string;
  instructions: string;
  waitForCompletion: () => Promise<StoredAccountState['boundChannel'] | undefined>;
}> {
  const state = readAccountState();
  const client = resolveOAuthClient(state, options);
  state.oauthClient = client;
  saveAccountState(state);

  const port = options.port || 8919;
  const redirectUri = `http://localhost:${port}`;

  // PKCE verifier & S256 challenge
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const csrfState = randomBytes(16).toString('hex');

  const scopes = options.monetaryScope === false ? YOUTUBE_SCOPES.slice(0, 4) : YOUTUBE_SCOPES;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', csrfState);

  let resolveDone!: (ch: StoredAccountState['boundChannel'] | undefined) => void;
  let rejectDone!: (err: Error) => void;
  const completionPromise = new Promise<StoredAccountState['boundChannel'] | undefined>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // Prevent unhandled rejection when caller doesn't await waitForCompletion()
  completionPromise.catch(() => undefined);

  // Spawn temporary 5-minute callback server in background
  const callbackServer = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', redirectUri);
      if (reqUrl.pathname !== '/' && reqUrl.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      if (!code || returnedState !== csrfState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>❌ Xác thực thất bại: Thiếu mã code hoặc sai state.</h2>');
        return;
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
      });

      const tokenJson = (await tokenRes.json()) as any;
      if (!tokenRes.ok || !tokenJson.access_token) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>❌ Lỗi đổi token: ${tokenJson.error_description || tokenJson.error || tokenRes.status}</h2>`);
        return;
      }

      const updated = readAccountState();
      updated.tokens = {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token || updated.tokens?.refreshToken,
        expiresAt: Date.now() + Number(tokenJson.expires_in || 3500) * 1000,
        scope: tokenJson.scope,
      };

      // Auto-fetch authenticated user's own YouTube channel (`mine=true`)
      const meRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { Authorization: `Bearer ${tokenJson.access_token}` } }
      );
      let chTitle = 'YouTube Channel';
      if (meRes.ok) {
        const meJson = (await meRes.json()) as any;
        const me = meJson?.items?.[0];
        if (me?.id) {
          chTitle = me.snippet?.title || me.id;
          const handle = me.snippet?.customUrl;
          updated.boundChannel = {
            id: me.id,
            title: chTitle,
            handle: handle || undefined,
            url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${me.id}`,
            boundAt: new Date().toISOString(),
          };
        }
      }

      saveAccountState(updated);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1>✅ Đã kết nối kênh "${chTitle}" vào CTDO YTB MCP!</h1>
        <p>Bạn có thể đóng tab này và quay lại cửa sổ chat AI để sử dụng YouTube Studio & Quản trị kênh.</p>
      </body></html>`);
      resolveDone(updated.boundChannel);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`OAuth callback error: ${err instanceof Error ? err.message : String(err)}`);
      rejectDone(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setTimeout(() => callbackServer.close(), 500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject);
    callbackServer.listen(port, () => resolve());
  });

  // Auto-close after 15 minutes if unused
  setTimeout(() => {
    callbackServer.close();
    rejectDone(new Error('OAuth flow timed out after 15 minutes'));
  }, 15 * 60 * 1000).unref();

  return {
    authUrl: authUrl.toString(),
    redirectUri,
    instructions:
      'Open `authUrl` in your browser, sign in to your YouTube channel Google account, and click Allow. CTDO YTB MCP will automatically capture the token and bind your channel.',
    waitForCompletion: () => completionPromise,
  };
}

async function getValidAccessToken(): Promise<string> {
  const state = readAccountState();
  if (!state.tokens?.accessToken && !state.tokens?.refreshToken) {
    throw new Error(
      'OAuth2 YouTube Studio not connected yet. Run yt_studio with action="start_oauth" (or `ctdo-ytb-mcp login` in terminal) first.'
    );
  }

  if (state.tokens.accessToken && state.tokens.expiresAt > Date.now() + 60_000) {
    return state.tokens.accessToken;
  }

  if (!state.tokens.refreshToken) {
    throw new Error('OAuth access token expired and no refresh_token stored. Please re-run start_oauth.');
  }

  const client = resolveOAuthClient(state);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: state.tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(`Failed to refresh OAuth token: ${json.error_description || json.error || res.status}`);
  }

  state.tokens.accessToken = json.access_token;
  state.tokens.expiresAt = Date.now() + Number(json.expires_in || 3500) * 1000;
  saveAccountState(state);
  return json.access_token;
}

async function authedRequest<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await getValidAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`YouTube OAuth API HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/**
 * Get connection status + overview of user's bound or OAuth-authenticated channel.
 */
export function getMyChannelStatus() {
  const envCh = (process.env.CTDO_MY_CHANNEL || '').trim();
  const state = readAccountState();
  const hasOAuth = Boolean(state.tokens?.refreshToken || state.tokens?.accessToken);

  return {
    connected: Boolean(state.boundChannel || envCh || hasOAuth),
    oauthStudioConnected: hasOAuth,
    boundChannel: state.boundChannel || (envCh ? { handleOrId: envCh, source: 'env' } : null),
    oauthScopes: state.tokens?.scope?.split(' ') || [],
    capabilitiesUnlocked: {
      publicChannelTrackingAndAudit: Boolean(state.boundChannel || envCh || hasOAuth),
      privateStudioAnalyticsAndRevenue: hasOAuth,
      editVideosThumbnailsPlaylistsCommentsUpload: hasOAuth,
    },
  };
}

export async function getMyChannelOverview(maxItems = 10) {
  const state = readAccountState();
  const target = state.boundChannel?.id || state.boundChannel?.handle || process.env.CTDO_MY_CHANNEL?.trim();

  if (state.tokens?.refreshToken || state.tokens?.accessToken) {
    try {
      const me = await authedRequest(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true'
      );
      const chItem = me?.items?.[0];
      if (chItem?.id) {
        const [pub] = await hybridYouTube.getChannels({
          channels: [chItem.id],
          include: ['stats', 'videos', 'shorts', 'top_videos'],
          maxItems,
        });
        return {
          authMode: 'oauth_owner',
          ...pub,
        };
      }
    } catch {
      // fall through to public bound channel
    }
  }

  if (!target) {
    throw new Error(
      'No personal channel connected yet. Call yt_studio(action="bind_channel", channel="@yourhandle") for instant public binding, or yt_studio(action="start_oauth", ...) for full YouTube Studio OAuth2.'
    );
  }

  const [pub] = await hybridYouTube.getChannels({
    channels: [target],
    include: ['stats', 'videos', 'shorts', 'top_videos'],
    maxItems,
  });
  return {
    authMode: 'public_bound',
    ...pub,
  };
}

/**
 * Query Official YouTube Studio Analytics API v2 (`ids=channel==MINE`).
 */
export async function queryMyStudioAnalytics(options: {
  period?: '7d' | '28d' | '90d' | '365d';
  startDate?: string;
  endDate?: string;
  dimensions?: string;
  metrics?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
}) {
  const now = new Date();
  const endDate = options.endDate || now.toISOString().slice(0, 10);
  const daysMap: Record<string, number> = { '7d': 7, '28d': 28, '90d': 90, '365d': 365 };
  const days = daysMap[options.period || '28d'] || 28;
  const startDate =
    options.startDate || new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

  const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  url.searchParams.set(
    'metrics',
    options.metrics ||
      'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares'
  );
  const dims = options.dimensions || 'day';
  if (dims !== 'none') {
    url.searchParams.set('dimensions', dims);
  }
  if (options.filters) url.searchParams.set('filters', options.filters);
  const effectiveSort =
    options.sort || (dims.includes('video') || dims.includes('TrafficSource') ? '-views' : undefined);
  if (effectiveSort) url.searchParams.set('sort', effectiveSort);
  const effectiveMax = options.maxResults || (dims.includes('video') ? 15 : undefined);
  if (effectiveMax) url.searchParams.set('maxResults', String(effectiveMax));

  const data = await authedRequest(url.toString());
  const headers = (data?.columnHeaders || []).map((h: any) => h.name);
  const rows = (data?.rows || []).map((row: any[]) =>
    Object.fromEntries(headers.map((col: string, i: number) => [col, row[i]]))
  );

  return { startDate, endDate, rowCount: rows.length, rows };
}

function fitYouTubeTitle(raw: string): string {
  const t = raw.trim();
  return t.length <= 100 ? t : t.slice(0, 99).trim();
}

function fitYouTubeTags(tags?: string[]): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: string[] = [];
  let len = 0;
  for (const tag of tags) {
    const clean = tag.trim();
    if (!clean) continue;
    const cost = clean.includes(' ') ? clean.length + 3 : clean.length + 1;
    if (len + cost > 450) break;
    out.push(clean);
    len += cost;
  }
  return out;
}

/**
 * List all uploaded videos on the authenticated owner channel (`publicOnly = true` by default).
 */
export async function listMyUploadedVideos(publicOnly = true) {
  const me = await authedRequest(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true'
  );
  const uploadsId = me?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];

  const ids = new Set<string>();
  let pageToken = '';
  do {
    const pl = await authedRequest(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(
        uploadsId
      )}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    );
    for (const it of pl?.items || []) {
      if (it?.contentDetails?.videoId) ids.add(it.contentDetails.videoId);
    }
    pageToken = pl?.nextPageToken || '';
  } while (pageToken);

  const allIds = Array.from(ids);
  const results: any[] = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const chunk = allIds.slice(i, i + 50);
    const vRes = await authedRequest(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails,statistics&id=${chunk.join(',')}&maxResults=50`
    );
    for (const v of vRes?.items || []) {
      if (publicOnly && v?.status?.privacyStatus !== 'public') continue;
      if (v?.contentDetails?.duration === 'P0D') continue; // skip empty unstreamed live placeholders
      results.push({
        id: v.id,
        title: v.snippet?.title,
        privacyStatus: v.status?.privacyStatus,
        duration: v.contentDetails?.duration,
        categoryId: v.snippet?.categoryId,
        tagCount: (v.snippet?.tags || []).length,
        views: Number(v.statistics?.viewCount || 0),
        publishedAt: v.snippet?.publishedAt,
      });
    }
  }
  return results;
}

/**
 * Update Channel Banner (2560x1440 Full-Bleed PNG) + Channel SEO Description/Keywords + Sync Localizations (`vi_VN`, `en_US`)
 * using separate PUT calls to satisfy YouTube API's part isolation constraint.
 */
export async function updateMyChannelBranding(options: {
  bannerPath?: string;
  description?: string;
  keywords?: string;
  country?: string;
  channelTitleForLocalization?: string;
}) {
  const chGet = await authedRequest(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings,localizations&mine=true'
  );
  const ch = chGet?.items?.[0];
  if (!ch?.id) throw new Error('Authenticated YouTube channel not found.');

  let bannerExternalUrl = ch.brandingSettings?.image?.bannerExternalUrl;
  if (options.bannerPath) {
    const bannerBytes = await readFile(options.bannerPath);
    const mime = options.bannerPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const bRes = await authedRequest(
      'https://www.googleapis.com/upload/youtube/v3/channelBanners/insert',
      {
        method: 'POST',
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bannerBytes.byteLength),
        },
        body: bannerBytes,
      }
    );
    bannerExternalUrl = bRes?.url || bannerExternalUrl;
  }

  const curChannel = { ...(ch.brandingSettings?.channel || {}) };
  delete curChannel.title;
  delete curChannel.defaultLanguage;

  if (options.description !== undefined) {
    curChannel.description = options.description.slice(0, 995);
  }
  if (options.keywords !== undefined) {
    curChannel.keywords = options.keywords.slice(0, 495);
  }
  if (options.country) {
    curChannel.country = options.country;
  }

  const brandingRes = await authedRequest(
    'https://www.googleapis.com/youtube/v3/channels?part=brandingSettings',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: ch.id,
        brandingSettings: {
          channel: curChannel,
          ...(bannerExternalUrl ? { image: { bannerExternalUrl } } : {}),
        },
      }),
    }
  );

  // Sync localizations separately so vi_VN / en_US never display outdated descriptions
  if (options.description !== undefined || options.channelTitleForLocalization) {
    const locTitle = options.channelTitleForLocalization || ch.snippet?.title || 'Channel';
    const locDesc = curChannel.description || ch.snippet?.description || '';
    await authedRequest('https://www.googleapis.com/youtube/v3/channels?part=localizations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: ch.id,
        localizations: {
          ...(ch.localizations || {}),
          vi_VN: { title: locTitle, description: locDesc },
          en_US: { title: locTitle, description: locDesc },
        },
      }),
    }).catch(() => undefined);
  }

  return {
    channelId: ch.id,
    bannerExternalUrl: brandingRes?.brandingSettings?.image?.bannerExternalUrl,
    descriptionLength: curChannel.description?.length || 0,
  };
}

/**
 * Upsert Official Creator Top Comment:
 * Updates existing owner top-level comment in-place (preserving any existing Pin badge!),
 * or creates a new Creator Comment with retry backoff if video was just uploaded.
 */
export async function upsertMyCreatorComment(videoInput: string, text: string) {
  const videoId = extractVideoId(videoInput);
  const state = readAccountState();
  let myChannelId = state.boundChannel?.id;
  if (!myChannelId) {
    const me = await authedRequest('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true');
    myChannelId = me?.items?.[0]?.id;
  }

  const existingList = await authedRequest(
    `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=30`
  ).catch(() => null);

  const existingOwner = (existingList?.items || []).find(
    (it: any) =>
      myChannelId &&
      it?.snippet?.topLevelComment?.snippet?.authorChannelId?.value === myChannelId
  );

  if (existingOwner?.id) {
    const updated = await authedRequest('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: existingOwner.id,
        snippet: { textOriginal: text },
      }),
    });
    return { mode: 'updated_preserving_pin', commentId: updated?.id || existingOwner.id };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const created = await authedRequest(
        'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snippet: {
              videoId,
              topLevelComment: {
                snippet: { textOriginal: text },
              },
            },
          }),
        }
      );
      return { mode: 'created_new', commentId: created?.id };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to post creator comment');
}

/**
 * Update metadata/privacy of your own YouTube video!
 */
export async function updateMyVideo(options: {
  video: string;
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}) {
  const videoId = extractVideoId(options.video);
  const current = await authedRequest(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`
  );
  const item = current?.items?.[0];
  if (!item) throw new Error(`Video ${videoId} not found on authenticated account.`);

  const body = {
    id: videoId,
    snippet: {
      ...item.snippet,
      title: options.title ? fitYouTubeTitle(options.title) : item.snippet.title,
      description: options.description ?? item.snippet.description,
      tags: options.tags ? fitYouTubeTags(options.tags) : item.snippet.tags,
      categoryId: options.categoryId ?? item.snippet.categoryId ?? '28',
      ...(options.defaultLanguage
        ? {
            defaultLanguage: options.defaultLanguage,
            defaultAudioLanguage: options.defaultLanguage,
          }
        : {}),
    },
    status: {
      privacyStatus: options.privacyStatus ?? item.status?.privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  return authedRequest('https://www.googleapis.com/youtube/v3/videos?part=snippet,status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Upload custom thumbnail image (.jpg/.png) to your YouTube video.
 */
export async function setMyVideoThumbnail(videoInput: string, imagePath: string) {
  const videoId = extractVideoId(videoInput);
  const bytes = await readFile(imagePath);
  const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  return authedRequest(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: bytes,
    }
  );
}

/**
 * Reply to an existing comment OR post a new top-level comment on a video!
 */
export async function postOrReplyComment(options: {
  parentCommentId?: string;
  video?: string;
  text: string;
}) {
  if (options.parentCommentId) {
    return authedRequest('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: {
          parentId: options.parentCommentId,
          textOriginal: options.text,
        },
      }),
    });
  }

  if (!options.video) throw new Error('Provide either `parentCommentId` (to reply) or `video` (top-level comment).');
  const videoId = extractVideoId(options.video);
  return authedRequest('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        videoId,
        topLevelComment: {
          snippet: { textOriginal: options.text },
        },
      },
    }),
  });
}

/**
 * Create playlist or add video to playlist on your channel.
 */
export async function manageMyPlaylist(options: {
  subAction: 'create' | 'add_video';
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  playlistId?: string;
  video?: string;
}) {
  if (options.subAction === 'create') {
    if (!options.title) throw new Error('`title` is required to create a playlist');
    return authedRequest('https://www.googleapis.com/youtube/v3/playlists?part=snippet,status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: { title: options.title, description: options.description || '' },
        status: { privacyStatus: options.privacyStatus || 'public' },
      }),
    });
  }

  if (!options.playlistId || !options.video) {
    throw new Error('`playlistId` and `video` are required for add_video');
  }
  const videoId = extractVideoId(options.video);
  return authedRequest('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        playlistId: options.playlistId,
        resourceId: { kind: 'youtube#video', videoId },
      },
    }),
  });
}

/**
 * Resumable Video / Shorts Upload to your YouTube channel!
 */
export async function uploadVideoToMyChannel(options: {
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacyStatus?: 'private' | 'unlisted' | 'public';
  publishAt?: string;
  thumbnailPath?: string;
  creatorComment?: string;
}) {
  const token = await getValidAccessToken();
  const fileBytes = await readFile(options.filePath);
  const mime = options.filePath.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';

  // Step 1: Initiate resumable upload session
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(fileBytes.byteLength),
        'X-Upload-Content-Type': mime,
      },
      body: JSON.stringify({
        snippet: {
          title: fitYouTubeTitle(options.title),
          description: options.description || '',
          tags: fitYouTubeTags(options.tags),
          categoryId: options.categoryId || '28',
          defaultLanguage: options.defaultLanguage || 'vi',
          defaultAudioLanguage: options.defaultLanguage || 'vi',
        },
        status: {
          privacyStatus: options.publishAt ? 'private' : options.privacyStatus || 'public',
          publishAt: options.publishAt,
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  if (!initRes.ok) {
    throw new Error(`Upload init failed HTTP ${initRes.status}: ${await initRes.text()}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('Missing resumable upload Location header');

  // Step 2: Stream binary video payload
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(fileBytes.byteLength),
      'Content-Type': mime,
    },
    body: fileBytes,
  });

  if (!putRes.ok) {
    throw new Error(`Video upload transfer failed HTTP ${putRes.status}: ${await putRes.text()}`);
  }

  const uploaded = (await putRes.json()) as any;
  if (options.thumbnailPath && uploaded?.id) {
    // Wait up to 60s for YouTube transcoding (`processingStatus === 'succeeded'`) so 9:16 Shorts activate `shortsAspectRatio=1080x1920`
    for (let i = 0; i < 12; i++) {
      const p = await authedRequest(
        `https://www.googleapis.com/youtube/v3/videos?part=processingDetails&id=${encodeURIComponent(uploaded.id)}`
      ).catch(() => null);
      if (p?.items?.[0]?.processingDetails?.processingStatus === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    uploaded.thumbnailApplied = await setMyVideoThumbnail(uploaded.id, options.thumbnailPath);
  }

  if (options.creatorComment && uploaded?.id) {
    uploaded.commentPosted = await upsertMyCreatorComment(uploaded.id, options.creatorComment).catch(
      (e) => ({ error: e instanceof Error ? e.message : String(e) })
    );
  }
  return uploaded;
}

export function disconnectMyChannel(clearBoundChannel = true) {
  const state = readAccountState();
  delete state.tokens;
  if (clearBoundChannel) delete state.boundChannel;
  saveAccountState(state);
  return { disconnected: true };
}
