// Storage for the price server: scans uploaded by companions (POST /v1/scans) and
// SavedVariables pushed to the hosted server, kept per realm and item with timestamps.
//
// Points go into hour buckets. Each uploader (a hash of its API key) has one report per
// bucket, and a bucket's price is the median across uploaders, so one bad uploader can't
// move it on its own. Each realm counts its changes (`seq`) and every item remembers the
// count when it last changed (`u`). A pull answers with the count as its `cursor`, and the
// next pull asks for `since` that cursor: exactly the items changed in between, with no
// dependence on anyone's clock.
//
// Older than RAW_DAYS: a bucket per day. Older than KEEP_DAYS: dropped.
// One JSON file per realm in `dir`, written atomically after every change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOUR, DAY, encode, type Point } from './history.ts';
import { HttpError } from './errors.ts';
import type { ItemName } from './savedVars.ts';

export const RAW_DAYS = 14;
export const KEEP_DAYS = 180;
/** uploads may not be older than this (the addon merges older points into days) */
export const MAX_AGE = 14 * DAY;
const MAX_FUTURE = 10 * 60;
// oxlint-disable-next-line no-control-regex -- realm keys may not hold control characters
const REALM_RE = /^[^\0-\x1f/\\]{1,80}$/;
const MAX_ITEMS_PER_SCAN = 100_000;

/** Short stable id for an API key, so raw keys are never stored. */
export const reporterId = (key: string): string => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

export const validRealm = (realm: unknown): realm is string => typeof realm === 'string' && REALM_RE.test(realm);

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const positiveInt = (v: number) => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;

/** reporter id -> its point; '*' is a day bucket made by compact() */
type Reports = Record<string, Point>;

/** One item: its buckets (bucket start time -> reports) and the realm `seq` when it last changed. */
export interface StoredItem { b: Record<string, Reports>; u: number }

interface StoredRealm {
  items: Record<string, StoredItem>;
  names: Record<string, ItemName>;
  lastScan: number;
  updated: number;
  seq: number;
}

export interface RealmHistory<P> {
  items: Record<string, P>;
  names: Record<string, ItemName>;
  lastScan: number | null;
  updated: number | null;
  cursor: number;
}

export interface HistoryOptions {
  /** how far back */
  days?: number;
  /** a cursor from an earlier call; only items changed after it */
  since?: number;
}

/** One point for a bucket: newest scan time, median min/market/quantity across uploaders. */
function aggregate(reports: Reports): Point {
  const r = Object.values(reports);
  if (r.length === 1) return [...r[0]];
  return [Math.max(...r.map((x) => x[0])), median(r.map((x) => x[1])), median(r.map((x) => x[2])), median(r.map((x) => x[3]))];
}

export class PriceStore {
  dir: string;
  now: () => number;
  realms = new Map<string, StoredRealm>();

  /** dir: folder for the realm files */
  constructor(dir: string, { now = () => Math.floor(Date.now() / 1000) }: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(realm: string): string { return path.join(this.dir, encodeURIComponent(realm) + '.json'); }

  load(realm: string): StoredRealm {
    let r = this.realms.get(realm);
    if (r) return r;
    try {
      r = JSON.parse(fs.readFileSync(this.file(realm), 'utf8')) as StoredRealm;
    } catch {
      r = { items: {}, names: {}, lastScan: 0, updated: 0, seq: 0 };
    }
    this.realms.set(realm, r);
    return r;
  }

  save(realm: string): void {
    const file = this.file(realm);
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.load(realm)));
    fs.renameSync(file + '.tmp', file);
  }

  /** Realm keys with data, from memory and disk. */
  realmKeys(): string[] {
    const keys = new Set(this.realms.keys());
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json')) keys.add(decodeURIComponent(f.slice(0, -5)));
    return [...keys].filter(validRealm);
  }

  /**
   * Adds scans from one uploader. scans: [{ t, items: [[id, min, mkt, qty], ...] }].
   * names (optional): { id: { n, q } }. Both come straight from uploads, so nothing is
   * assumed about them: points that are too old, in the future or malformed are skipped.
   * Returns { points, skipped }.
   */
  ingest(realm: string, reporter: string, scans: unknown, names?: unknown): { points: number; skipped: number } {
    if (!validRealm(realm)) throw new HttpError(400, 'Bad realm key');
    if (!Array.isArray(scans)) throw new HttpError(400, 'scans must be a list');
    const now = this.now();
    const r = this.load(realm);
    const seq = (r.seq || 0) + 1; // this upload's change number
    let points = 0, skipped = 0;
    for (const scan of scans as { t?: unknown; items?: unknown }[]) {
      const t = Number(scan?.t);
      if (!Number.isInteger(t) || t < now - MAX_AGE || t > now + MAX_FUTURE || !Array.isArray(scan.items) || scan.items.length > MAX_ITEMS_PER_SCAN) {
        skipped += Array.isArray(scan?.items) ? scan.items.length : 1;
        continue;
      }
      const bucket = Math.floor(t / HOUR) * HOUR;
      for (const row of scan.items as unknown[]) {
        const [id, min, mkt, qty] = Array.isArray(row) ? row.map(Number) : [];
        if (!Number.isInteger(id) || id <= 0 || ![min, mkt, qty].every(positiveInt) || mkt === 0) { skipped++; continue; }
        const item = (r.items[id] ??= { b: {}, u: 0 });
        const reports = (item.b[bucket] ??= {});
        const prev = reports[reporter];
        // a later scan in the same hour replaces the uploader's earlier one
        if (prev && prev[0] > t) continue;
        const next: Point = [t, Math.round(min), Math.round(mkt), Math.round(qty)];
        // the same report again (a re-push, a restart) isn't a change
        if (prev && prev.every((v, i) => v === next[i])) continue;
        reports[reporter] = next;
        item.u = seq;
        points++;
      }
      r.lastScan = Math.max(r.lastScan || 0, t);
    }
    if (names && typeof names === 'object') {
      for (const [id, info] of Object.entries(names as Record<string, { n?: unknown; q?: unknown } | null>)) {
        if (/^\d+$/.test(id) && info && typeof info.n === 'string' && info.n.length <= 200) {
          r.names[id] = { n: info.n, q: Number.isInteger(info.q) ? (info.q as number) : null };
        }
      }
    }
    if (points) {
      r.seq = seq;
      r.updated = now;
      this.compact(realm);
      this.save(realm);
    }
    return { points, skipped };
  }

  /** Merges old hour buckets into days and drops what's past KEEP_DAYS. */
  compact(realm: string): void {
    const r = this.load(realm);
    const now = this.now();
    const rawFrom = now - RAW_DAYS * DAY, keepFrom = now - KEEP_DAYS * DAY;
    for (const [id, item] of Object.entries(r.items)) {
      const days = new Map<number, Point[]>();
      for (const key of Object.keys(item.b)) {
        const b = Number(key);
        if (b < keepFrom) { delete item.b[key]; continue; }
        if (b >= rawFrom) continue;
        const reports = item.b[key];
        // already a day bucket
        if (reports['*'] && Object.keys(reports).length === 1 && b % DAY === 0) continue;
        const day = Math.floor(b / DAY) * DAY;
        let pts = days.get(day);
        if (!pts) days.set(day, (pts = []));
        pts.push(aggregate(reports));
        delete item.b[key];
      }
      for (const [day, pts] of days) {
        const existing = item.b[day]?.['*'];
        if (existing) pts.push(existing);
        item.b[day] = { '*': [
          Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])),
          Math.round(pts.reduce((s, p) => s + p[2], 0) / pts.length), Math.round(pts.reduce((s, p) => s + p[3], 0) / pts.length),
        ] };
      }
      if (!Object.keys(item.b).length) delete r.items[id];
    }
  }

  /** One item's points, oldest first. */
  static points(item: StoredItem): Point[] {
    return Object.keys(item.b).map(Number).sort((a, b) => a - b).map((b) => aggregate(item.b[b]));
  }

  /** Price history for a realm, with the cursor to pull only later changes. */
  history(realm: string, { days = 30, since = 0 }: HistoryOptions = {}): RealmHistory<Point[]> {
    const r = this.load(realm);
    const from = this.now() - days * DAY;
    const items: Record<string, Point[]> = {};
    for (const [id, item] of Object.entries(r.items)) {
      if (since && item.u <= since) continue;
      const pts = PriceStore.points(item).filter((p) => p[0] >= from);
      if (pts.length) items[id] = pts;
    }
    return { items, names: r.names, lastScan: r.lastScan || null, updated: r.updated || null, cursor: r.seq || 0 };
  }

  /** Same, packed the way the API and the addon use it. */
  packed(realm: string, opts?: HistoryOptions): RealmHistory<string> {
    const h = this.history(realm, opts);
    return { ...h, items: Object.fromEntries(Object.entries(h.items).map(([id, pts]) => [id, encode(pts)])) };
  }

  summary(): { realm: string; items: number; lastScan: number | null; updated: number | null }[] {
    return this.realmKeys().map((realm) => {
      const r = this.load(realm);
      return { realm, items: Object.keys(r.items).length, lastScan: r.lastScan || null, updated: r.updated || null };
    });
  }
}

/** Per-uploader limit: at most `max` scans per hour. */
export class RateLimit {
  max: number;
  window: number;
  hits = new Map<string, number[]>();

  constructor(max = 120, windowSec = HOUR) {
    this.max = max;
    this.window = windowSec * 1000;
  }

  take(id: string, n = 1): boolean {
    const now = Date.now();
    const list = (this.hits.get(id) || []).filter((t) => now - t < this.window);
    if (list.length + n > this.max) { this.hits.set(id, list); return false; }
    for (let i = 0; i < n; i++) list.push(now);
    this.hits.set(id, list);
    return true;
  }
}
