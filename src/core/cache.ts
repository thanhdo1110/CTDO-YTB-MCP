import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Singleflight } from './utils.js';

const require = createRequire(import.meta.url);

export const CACHE_TTL = {
  SEARCH: 30 * 60 * 1000,         // 30 minutes
  VIDEO: 6 * 60 * 60 * 1000,      // 6 hours
  CHANNEL: 12 * 60 * 60 * 1000,   // 12 hours
  TRANSCRIPT: 7 * 24 * 60 * 60 * 1000, // 7 days
  COMMENTS: 60 * 60 * 1000,       // 1 hour
  SPONSORBLOCK: 24 * 60 * 60 * 1000, // 24 hours
  OUTLIERS: 2 * 60 * 60 * 1000,   // 2 hours
} as const;

interface L1Entry {
  value: unknown;
  expiresAt: number;
}

interface SqliteDB {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
}

export function getDataDir(): string {
  const dir = process.env.CTDO_DATA_DIR?.trim() || join(homedir(), '.ctdo-ytb-mcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openNativeSqlite(filename: string): SqliteDB | null {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDB };
    const dbPath = join(getDataDir(), filename);
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 3000;
    `);
    return db;
  } catch {
    return null;
  }
}

/**
 * Ultra-fast Two-Tier Cache:
 * - L1: In-Memory Map LRU (<0.05ms read)
 * - L2: Native node:sqlite WAL persistent disk cache (~0.3ms read, survives restarts, saves API quota)
 * - Singleflight request coalescing for concurrent duplicate requests
 */
export class TieredCache {
  private l1 = new Map<string, L1Entry>();
  private readonly maxL1Entries: number;
  private db: SqliteDB | null = null;
  private singleflight = new Singleflight();

  public stats = {
    l1Hits: 0,
    l2Hits: 0,
    misses: 0,
    writes: 0,
    savedQuotaUnits: 0,
    totalCalls: 0,
    totalLatencyMs: 0,
  };

  constructor(maxL1Entries = 2000) {
    this.maxL1Entries = maxL1Entries;
    this.db = openNativeSqlite('cache.sqlite');
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv_cache (
          key TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          payload TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_cache(expires_at);
      `);
      //Opportunistic prune of expired rows on startup
      try {
        this.db.prepare('DELETE FROM kv_cache WHERE expires_at < ?').run(Date.now());
      } catch {
        // ignore
      }
    }
  }

  get<T>(key: string, quotaCostIfHit = 0): T | undefined {
    const now = Date.now();

    // 1. L1 Memory LRU check
    const mem = this.l1.get(key);
    if (mem) {
      if (mem.expiresAt > now) {
        // Promote in Map order (LRU)
        this.l1.delete(key);
        this.l1.set(key, mem);
        this.stats.l1Hits++;
        this.stats.savedQuotaUnits += quotaCostIfHit;
        return mem.value as T;
      }
      this.l1.delete(key);
    }

    // 2. L2 SQLite WAL check
    if (this.db) {
      try {
        const row = this.db
          .prepare('SELECT payload, expires_at FROM kv_cache WHERE key = ?')
          .get(key) as { payload: string; expires_at: number } | undefined;
        if (row) {
          if (row.expires_at > now) {
            const parsed = JSON.parse(row.payload) as T;
            this.setL1(key, parsed, row.expires_at);
            this.stats.l2Hits++;
            this.stats.savedQuotaUnits += quotaCostIfHit;
            return parsed;
          }
          this.db.prepare('DELETE FROM kv_cache WHERE key = ?').run(key);
        }
      } catch {
        // ignore corrupt cache entry
      }
    }

    this.stats.misses++;
    return undefined;
  }

  set<T>(key: string, namespace: string, value: T, ttlMs: number): void {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.setL1(key, value, expiresAt);
    this.stats.writes++;

    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT INTO kv_cache (key, namespace, payload, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               payload = excluded.payload,
               expires_at = excluded.expires_at`
          )
          .run(key, namespace, JSON.stringify(value), expiresAt, now);
      } catch {
        // ignore disk write error
      }
    }
  }

  async getOrCompute<T>(
    namespace: string,
    keyParts: unknown,
    ttlMs: number,
    compute: () => Promise<T>,
    quotaCost = 0
  ): Promise<T> {
    const key = `${namespace}:${typeof keyParts === 'string' ? keyParts : JSON.stringify(keyParts)}`;
    const started = performance.now();
    this.stats.totalCalls++;

    const cached = this.get<T>(key, quotaCost);
    if (cached !== undefined) {
      this.stats.totalLatencyMs += performance.now() - started;
      return cached;
    }

    return this.singleflight.do(key, async () => {
      const val = await compute();
      if (val !== undefined && val !== null) {
        // Don't cache empty transcript arrays permanently if transient error occurred
        const isEmptyArr = Array.isArray(val) && val.length === 0;
        if (!isEmptyArr) {
          this.set(key, namespace, val, ttlMs);
        }
      }
      this.stats.totalLatencyMs += performance.now() - started;
      return val;
    });
  }

  clear(namespace?: string): { clearedL1: number; clearedL2: number } {
    let clearedL1 = 0;
    if (!namespace) {
      clearedL1 = this.l1.size;
      this.l1.clear();
    } else {
      for (const k of this.l1.keys()) {
        if (k.startsWith(`${namespace}:`)) {
          this.l1.delete(k);
          clearedL1++;
        }
      }
    }

    let clearedL2 = 0;
    if (this.db) {
      try {
        const res = namespace
          ? this.db.prepare('DELETE FROM kv_cache WHERE namespace = ?').run(namespace)
          : this.db.prepare('DELETE FROM kv_cache').run();
        clearedL2 = res.changes;
      } catch {
        // ignore
      }
    }
    return { clearedL1, clearedL2 };
  }

  getTelemetry() {
    const totalLookups = this.stats.l1Hits + this.stats.l2Hits + this.stats.misses;
    const hitRatePct =
      totalLookups > 0
        ? Math.round(((this.stats.l1Hits + this.stats.l2Hits) / totalLookups) * 1000) / 10
        : 0;
    let l2Count = 0;
    if (this.db) {
      try {
        const r = this.db.prepare('SELECT COUNT(*) as c FROM kv_cache WHERE expires_at > ?').get(Date.now());
        l2Count = Number(r?.c || 0);
      } catch {
        // ignore
      }
    }
    return {
      l1Entries: this.l1.size,
      l2PersistentEntries: l2Count,
      sqliteEnabled: Boolean(this.db),
      l1Hits: this.stats.l1Hits,
      l2Hits: this.stats.l2Hits,
      misses: this.stats.misses,
      coalescedInflightHits: this.singleflight.coalescedCount,
      hitRatePct,
      estimatedQuotaUnitsSaved: this.stats.savedQuotaUnits,
      avgLookupOrFetchMs:
        this.stats.totalCalls > 0
          ? Math.round((this.stats.totalLatencyMs / this.stats.totalCalls) * 100) / 100
          : 0,
    };
  }

  private setL1(key: string, value: unknown, expiresAt: number) {
    if (this.l1.has(key)) {
      this.l1.delete(key);
    } else if (this.l1.size >= this.maxL1Entries) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey !== undefined) this.l1.delete(oldestKey);
    }
    this.l1.set(key, { value, expiresAt });
  }
}

export const globalCache = new TieredCache();
