import type { OutputFormat } from './types.js';

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const CHANNEL_ID_REGEX = /^UC[a-zA-Z0-9_-]{22}$/;

/**
 * Extract 11-char YouTube Video ID from any URL format or raw ID.
 */
export function extractVideoId(input: string): string {
  const trimmed = (input || '').trim();
  if (VIDEO_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id && VIDEO_ID_REGEX.test(id)) return id;
    }
    const vParam = url.searchParams.get('v');
    if (vParam && VIDEO_ID_REGEX.test(vParam)) return vParam;

    const parts = url.pathname.split('/').filter(Boolean);
    const markerIdx = parts.findIndex((p) => ['shorts', 'embed', 'live', 'v', 'watch'].includes(p));
    if (markerIdx !== -1 && parts[markerIdx + 1] && VIDEO_ID_REGEX.test(parts[markerIdx + 1])) {
      return parts[markerIdx + 1];
    }
  } catch {
    // Fallback regex scan
  }

  const fallback = trimmed.match(/(?:v=|\/shorts\/|\/live\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (fallback?.[1]) return fallback[1];

  throw new Error(`Invalid YouTube video ID or URL: "${input}"`);
}

/**
 * Extract Playlist ID from URL or raw playlist ID.
 */
export function extractPlaylistId(input: string): string {
  const trimmed = (input || '').trim();
  if (/^(PL|UU|LL|FL|OLAK5uy_|RD|VL)[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed.startsWith('VL') ? trimmed.slice(2) : trimmed;
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const list = url.searchParams.get('list');
    if (list) return list;
  } catch {
    // ignore
  }

  const match = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];

  return trimmed;
}

export interface ParsedChannelRef {
  kind: 'id' | 'handle' | 'url' | 'query';
  value: string;
}

/**
 * Parse any channel identifier: UC... ID, @handle, full URL, or name.
 */
export function parseChannelRef(input: string): ParsedChannelRef {
  const trimmed = (input || '').trim();
  if (CHANNEL_ID_REGEX.test(trimmed)) {
    return { kind: 'id', value: trimmed };
  }
  if (trimmed.startsWith('@') && !trimmed.includes('/')) {
    return { kind: 'handle', value: trimmed };
  }

  if (trimmed.includes('youtube.com/') || trimmed.startsWith('http')) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && parts[1] && CHANNEL_ID_REGEX.test(parts[1])) {
        return { kind: 'id', value: parts[1] };
      }
      if (parts[0]?.startsWith('@')) {
        return { kind: 'handle', value: parts[0] };
      }
      if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) {
        return { kind: 'url', value: `https://www.youtube.com/${parts[0]}/${parts[1]}` };
      }
      if (parts[0] && !['watch', 'shorts', 'playlist'].includes(parts[0])) {
        return { kind: 'url', value: `https://www.youtube.com/${parts[0]}` };
      }
    } catch {
      // ignore
    }
  }

  return { kind: 'query', value: trimmed };
}

/**
 * Parse ISO 8601 duration (PT1H2M3S) or colon duration ("1:02:03", "4:31") into seconds.
 */
export function parseDurationSeconds(input?: string | number | null): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.round(input));
  if (!input || typeof input !== 'string') return undefined;
  const s = input.trim();
  if (!s) return undefined;

  if (/^\d+$/.test(s)) return Number(s);

  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) {
    const h = Number(iso[1] || 0);
    const m = Number(iso[2] || 0);
    const sec = Number(iso[3] || 0);
    return h * 3600 + m * 60 + sec;
  }

  if (/^\d+(?::\d+){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }

  if (s.toUpperCase() === 'SHORTS') return 45;
  return undefined;
}

/**
 * Format seconds into compact human timestamp ("4:05" or "1:02:03").
 */
export function formatTimestamp(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Parse human-formatted YouTube numbers ("4.34M subscribers", "1,234,567 views", "1.7K", "850 N", "2,1 Tr").
 */
export function parseHumanCount(input?: string | number | null): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
  if (!input || typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (!raw || /no views|waiting/i.test(raw)) return 0;

  // Exact digits with commas/spaces: "2,435,124 views"
  const exactMatch = raw.match(/^([\d,.\s]+)\s*(?:views|subscribers|likes|videos|comments|lượt xem|người đăng ký)?$/i);
  if (exactMatch && !/[KMBT]|Tr|N\b/i.test(raw)) {
    const digitsOnly = exactMatch[1].replace(/[^\d]/g, '');
    if (digitsOnly) return Number(digitsOnly);
  }

  // Abbreviated: "4.34M", "1.7 million", "235K", "1.2B"
  const abbr = raw.match(/([\d]+(?:[.,]\d+)?)\s*(K|M|B|T|million|billion|thousand|Tr|N)\b/i);
  if (abbr) {
    const num = parseFloat(abbr[1].replace(',', '.'));
    const unit = abbr[2].toLowerCase();
    const mult =
      unit === 'k' || unit === 'thousand' || unit === 'n'
        ? 1_000
        : unit === 'm' || unit === 'million' || unit === 'tr'
          ? 1_000_000
          : unit === 'b' || unit === 'billion'
            ? 1_000_000_000
            : 1_000_000_000_000;
    return Math.round(num * mult);
  }

  const anyDigits = raw.match(/(\d[\d,]*)/);
  if (anyDigits) {
    return Number(anyDigits[1].replace(/,/g, ''));
  }
  return undefined;
}

/**
 * Convert relative published text ("8 days ago", "Streamed 3 months ago", "2 hours ago") into approximate ISO 8601 date.
 */
export function parseRelativeDate(text?: string | null, nowMs = Date.now()): string | undefined {
  if (!text) return undefined;
  const clean = text.toLowerCase().replace(/streamed|premiered|updated/g, '').trim();

  // Already ISO or YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const m = clean.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  if (!m) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  const count = Number(m[1]);
  const unit = m[2].toLowerCase();
  const unitMs: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30.4375 * 86_400_000,
    year: 365.25 * 86_400_000,
  };
  return new Date(nowMs - count * (unitMs[unit] || 86_400_000)).toISOString();
}

/**
 * Calculate views per day velocity safely.
 */
export function calcViewsPerDay(views?: number, publishedAt?: string, nowMs = Date.now()): number | undefined {
  if (views === undefined || !publishedAt) return undefined;
  const pubMs = new Date(publishedAt).getTime();
  if (Number.isNaN(pubMs)) return undefined;
  const ageDays = Math.max(0.25, (nowMs - pubMs) / 86_400_000);
  return Math.round((views / ageDays) * 10) / 10;
}

/**
 * Parse chapters from a YouTube video description ("00:00 Intro\n02:15 Architecture...").
 */
export function extractDescriptionChapters(description?: string | null): Array<{ title: string; startSec: number; timestamp: string }> {
  if (!description) return [];
  const chapters: Array<{ title: string; startSec: number; timestamp: string }> = [];
  const lines = description.split(/\r?\n/);

  for (const line of lines) {
    const match = line.trim().match(/^(?:[-•*]\s*)?\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*(?:[-–—:|]\s*)?(.{2,120})$/);
    if (match) {
      const startSec = parseDurationSeconds(match[1]);
      const title = match[2].trim();
      if (startSec !== undefined && title) {
        chapters.push({
          title,
          startSec,
          timestamp: formatTimestamp(startSec),
        });
      }
    }
  }

  return chapters.length >= 2 ? chapters : [];
}

/**
 * Bounded concurrency mapper (fast worker pool without external dependencies).
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Singleflight coalescer: deduplicates identical in-flight async calls.
 */
export class Singleflight {
  private inflight = new Map<string, Promise<unknown>>();
  public coalescedCount = 0;

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.coalescedCount++;
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }
}

/**
 * Recursively strip null/undefined/empty values and round floats for maximum LLM token savings.
 */
export function compactValue<T>(val: T): T {
  if (val === null || val === undefined) return undefined as unknown as T;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return undefined as unknown as T;
    return (Number.isInteger(val) ? val : Math.round(val * 1000) / 1000) as unknown as T;
  }
  if (Array.isArray(val)) {
    const cleaned = val.map((item) => compactValue(item)).filter((item) => item !== undefined);
    return (cleaned.length > 0 ? cleaned : undefined) as unknown as T;
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const cv = compactValue(v);
      if (cv !== undefined && cv !== '') {
        out[k] = cv;
        count++;
      }
    }
    return (count > 0 ? out : undefined) as unknown as T;
  }
  return val;
}

/**
 * Format tool output according to requested output mode ('compact' | 'markdown' | 'json').
 * - 'compact': Minified single-line JSON stripped of all nulls/empties (~85% fewer tokens than pretty raw JSON!)
 * - 'json': Pretty 2-space JSON stripped of nulls
 * - 'markdown': Concise human+LLM readable Markdown summary/tables
 */
export function serializeOutput(data: unknown, format: OutputFormat = 'compact'): string {
  const cleaned = compactValue(data) ?? {};
  if (format === 'json') {
    return JSON.stringify(cleaned, null, 2);
  }
  if (format === 'markdown') {
    return toCompactMarkdown(cleaned);
  }
  // 'compact' mode: zero-indentation JSON saves an additional 20-30% whitespace tokens for LLMs!
  return JSON.stringify(cleaned);
}

function toCompactMarkdown(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '_(empty)_';
    return value
      .map((item, idx) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          const headline = rec.title || rec.template || rec.author || rec.id || `Item ${idx + 1}`;
          const rest = Object.entries(rec)
            .filter(([k]) => !['title', 'template'].includes(k))
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' | ');
          return `${idx + 1}. **${headline}** — ${rest}`;
        }
        return `- ${String(item)}`;
      })
      .join('\n');
  }

  const lines: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      lines.push(`${'#'.repeat(Math.min(4, depth + 2))} ${k} (${v.length})\n${toCompactMarkdown(v, depth + 1)}`);
    } else if (v && typeof v === 'object') {
      lines.push(`${'#'.repeat(Math.min(4, depth + 2))} ${k}\n${toCompactMarkdown(v, depth + 1)}`);
    } else {
      lines.push(`- **${k}**: ${v}`);
    }
  }
  return lines.join('\n');
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}
