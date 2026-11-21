// Storage for the price server: scans uploaded by companions (POST /v1/scans) and
// SavedVariables pushed to the hosted server, kept per realm and item with timestamps.
//
// Points go into hour buckets. Each uploader has one report per bucket, and a bucket's
// price is the median across uploaders, so one bad uploader can't move it on its own.
//
// Who counts (anyone can make API keys, so a key alone can't vote):
//   - A linked PC votes as its Battle.net user, and pushes with the server's upload token
//     vote as their account. These are trusted reporters.
//   - A plain API key is an anonymous reporter (its id starts with "anon:"). Its reports
//     are kept but only used for a bucket no trusted reporter has, and never with anon: 'off'.
//   - A report more than OUTLIER times above or below what other uploaders reported over the
//     day before is ignored, unless another uploader reported about the same.
//   - Banned reporters (banned.json in the data folder, see `ahtc ban`) are ignored and
//     their reports removed. Each realm counts its changes (`seq`) and every item remembers the
// count when it last changed (`u`). A pull answers with the count as its `cursor`, and the
// next pull asks for `since` that cursor: exactly the items changed in between, with no
// dependence on anyone's clock.
//
// Older than RAW_DAYS: a bucket per day. Older than KEEP_DAYS: dropped.
// One JSON file per realm in `dir`, written atomically after a change: right away, or with
// `saveDelayMs` at most that often, so a busy server doesn't rewrite a big realm file
// (and block every other request) on each upload. Call flush() before exiting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOUR, DAY, encode, type Point } from './history.ts';
import { HttpError } from './errors.ts';
import { canonicalRealm } from './realm.ts';
import { CATEGORY_RE, cleanClassNames, validQuality, type ClassNames, type ItemName } from './savedVars.ts';

export const RAW_DAYS = 14;
export const KEEP_DAYS = 180;
/** uploads may not be older than this (the addon merges older points into days) */
export const MAX_AGE = 14 * DAY;
const MAX_FUTURE = 10 * 60;
// oxlint-disable-next-line no-control-regex -- realm keys may not hold control characters
const REALM_RE = /^[^\0-\x1f/\\]{1,80}$/;
/** "-Alliance", "Unknown-Alliance": an AH old addons saved when the client gave no realm name */
const NAMELESS_RE = /^(Unknown)?-(Alliance|Horde|Neutral)$/;
const MAX_ITEMS_PER_SCAN = 100_000;

/** Short stable id for an API key, so raw keys are never stored. */
export const reporterId = (key: string): string => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

/** Reporter id for an upload with a plain API key (not a linked PC). */
export const ANON = 'anon:';
export const anonReporter = (key: string): string => ANON + reporterId(key);
export const isAnon = (reporter: string): boolean => reporter.startsWith(ANON);

/** fallback: anonymous reports fill buckets no trusted reporter has; off: they never count. */
export type AnonMode = 'fallback' | 'off';
export const anonModeFrom = (v: string | undefined): AnonMode => (v === 'off' ? 'off' : 'fallback');

/** A report this many times above or below the other uploaders' median is ignored unless someone agrees. */
export const OUTLIER = 3;
/** Two reports within this factor of each other agree. */
const AGREE = 1.5;
/** How far back other uploaders' reports are compared. */
const OUTLIER_WINDOW = DAY;

/** reporter id -> { t: when banned, note } */
export type Bans = Record<string, { t: number; note?: string }>;
export const bansFile = (dir: string): string => path.join(dir, 'banned.json');

export function readBans(dir: string): Bans {
  try {
    const b = JSON.parse(fs.readFileSync(bansFile(dir), 'utf8'));
    return b && typeof b === 'object' ? (b as Bans) : {};
  } catch { return {}; }
}

export function writeBans(dir: string, bans: Bans): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bansFile(dir) + '.tmp', JSON.stringify(bans, null, 2));
  fs.renameSync(bansFile(dir) + '.tmp', bansFile(dir));
}

export const validRealm = (realm: unknown): realm is string =>
  typeof realm === 'string' && REALM_RE.test(realm) && !NAMELESS_RE.test(realm);

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
  /** category names, from trusted uploaders */
  classes?: ClassNames;
  lastScan: number;
  updated: number;
  seq: number;
}

export interface RealmHistory<P> {
  items: Record<string, P>;
  names: Record<string, ItemName>;
  classes: ClassNames;
  lastScan: number | null;
  updated: number | null;
  cursor: number;
}

export interface HistoryOptions {
  /** how far back */
  days?: number;
  /** a cursor from an earlier call; only items changed after it */
  since?: number;
  /** just this item id */
  only?: string;
}

/** One point from reports: newest scan time, median min/market/quantity. */
function aggregate(r: Point[]): Point {
  if (r.length === 1) return [...r[0]];
  return [Math.max(...r.map((x) => x[0])), median(r.map((x) => x[1])), median(r.map((x) => x[2])), median(r.map((x) => x[3]))];
}

const far = (v: number, ref: number) => v > ref * OUTLIER || v * OUTLIER < ref;
const near = (a: number, b: number) => a <= b * AGREE && b <= a * AGREE;

export class PriceStore {
  dir: string;
  now: () => number;
  anon: AnonMode;
  realms = new Map<string, StoredRealm>();
  bans: Bans = {};
  private bansStamp = -1;
  private bansChecked = -Infinity;
  private evaluated = new WeakMap<StoredItem, { stamp: string; out: { b: number; point: Point | null; kept: Set<string> }[] }>();
  /** realms changed since they were last written */
  private dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  saveDelayMs: number;

  /**
   * dir: folder for the realm files; anon: whether anonymous reports count (see AnonMode);
   * saveDelayMs: wait this long after a change before writing, batching what comes in meanwhile (0: write at once).
   */
  constructor(dir: string, { now = () => Math.floor(Date.now() / 1000), anon = 'fallback', saveDelayMs = 0 }: { now?: () => number; anon?: AnonMode; saveDelayMs?: number } = {}) {
    this.dir = dir;
    this.now = now;
    this.anon = anon;
    this.saveDelayMs = saveDelayMs;
    fs.mkdirSync(dir, { recursive: true });
    this.checkBans(true);
    this.migrateKeys();
  }

  /**
   * Merges realms stored under old keys ("CAMWOWUS2Realm8PvP-Alliance") into their
   * ruleset's ("PvP-Alliance") and deletes the old files. Each uploader keeps its newest
   * report per bucket; merged items are marked changed so pulls pick them up.
   */
  migrateKeys(): void {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f === 'banned.json') continue;
      const old = decodeURIComponent(f.slice(0, -5));
      const key = canonicalRealm(old);
      if (key === old) continue;
      let from: StoredRealm;
      try {
        from = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as StoredRealm;
      } catch { continue; }
      const to = this.load(key);
      const seq = (to.seq || 0) + 1;
      for (const [id, item] of Object.entries(from.items || {})) {
        const into = (to.items[id] ??= { b: {}, u: 0 });
        for (const [b, reports] of Object.entries(item.b || {})) {
          const bucket = (into.b[b] ??= {});
          for (const [reporter, p] of Object.entries(reports)) if (!bucket[reporter] || bucket[reporter][0] < p[0]) bucket[reporter] = p;
        }
        into.u = seq;
      }
      to.names = { ...from.names, ...to.names };
      if (from.classes) to.classes = { ...from.classes, ...to.classes };
      to.lastScan = Math.max(to.lastScan || 0, from.lastScan || 0);
      to.updated = Math.max(to.updated || 0, from.updated || 0, this.now());
      to.seq = seq;
      this.compact(key);
      this.write(key);
      fs.unlinkSync(path.join(this.dir, f));
    }
  }

  /**
   * Re-reads banned.json if it changed (looks at most every 10 seconds), and removes newly
   * banned reporters' reports everywhere, marking those items changed so pulls pick it up.
   */
  checkBans(force = false): void {
    const now = Date.now();
    if (!force && now - this.bansChecked < 10_000) return;
    this.bansChecked = now;
    let stamp = 0;
    try { stamp = fs.statSync(bansFile(this.dir)).mtimeMs; } catch { /* no bans */ }
    if (stamp === this.bansStamp) return;
    this.bansStamp = stamp;
    const before = this.bans;
    this.bans = readBans(this.dir);
    const added = Object.keys(this.bans).filter((r) => !before[r]);
    if (added.length) this.purge(new Set(added));
  }

  /** Removes these reporters' reports from every realm. Returns how many were removed. */
  purge(reporters: Set<string>): number {
    let removed = 0;
    for (const realm of this.realmKeys()) {
      const r = this.load(realm);
      const seq = (r.seq || 0) + 1;
      let changed = false;
      for (const [id, item] of Object.entries(r.items)) {
        for (const [key, reports] of Object.entries(item.b)) {
          for (const who of Object.keys(reports)) {
            if (!reporters.has(who)) continue;
            delete reports[who];
            item.u = seq;
            removed++;
            changed = true;
          }
          if (!Object.keys(reports).length) delete item.b[key];
        }
        if (!Object.keys(item.b).length) delete r.items[id];
      }
      if (changed) {
        r.seq = seq;
        r.updated = this.now();
        this.save(realm);
      }
    }
    return removed;
  }

  /** Whether a reporter's reports count at all (not banned; not anonymous with anon: 'off'). */
  counts(reporter: string): boolean {
    return !this.bans[reporter] && !(isAnon(reporter) && this.anon === 'off');
  }

  /**
   * Every bucket of an item, oldest first, with the reports that count and the point they
   * make (null when none count). One pass: each report is checked against every other
   * uploader's latest counted report from the day before.
   *   - Trusted reports if the bucket has any, else anonymous ones (not at all with anon: 'off').
   *   - A report whose min or market is OUTLIER times off the others' median is dropped,
   *     unless one of them reported about the same (a real crash or spike).
   *   - If that drops everyone (two uploaders who disagree), whoever matches the last
   *     counted point stays. A lone uploader with nobody to compare against always counts.
   */
  evaluate(item: StoredItem): { b: number; point: Point | null; kept: Set<string> }[] {
    // cached until the item changes (an upload bumps u, compaction and purges change the buckets) or the bans do
    const stamp = `${item.u}:${Object.keys(item.b).length}:${this.bansStamp}:${this.anon}`;
    const hit = this.evaluated.get(item);
    if (hit && hit.stamp === stamp) return hit.out;
    const keys = Object.keys(item.b).map(Number).sort((a, b) => a - b);
    const latest = new Map<string, Point>(); // uploader -> their latest counted report
    let last: Point | null = null;
    const out: { b: number; point: Point | null; kept: Set<string> }[] = [];
    for (const b of keys) {
      const entries = Object.entries(item.b[b]).filter(([who]) => this.counts(who));
      const trusted = entries.some(([who]) => !isAnon(who));
      const pool = trusted ? entries.filter(([who]) => !isAnon(who)) : entries;
      // the others' newest report each: this bucket, else their latest from the day before
      const around = new Map<string, Point>();
      for (const [who, p] of latest) {
        if (p[0] >= b - OUTLIER_WINDOW && (!trusted || !isAnon(who))) around.set(who, p);
      }
      for (const [who, p] of pool) around.set(who, p);
      // usual case: everything is within OUTLIER of everything else, so nothing is an outlier
      let lo1 = Infinity, hi1 = 0, lo2 = Infinity, hi2 = 0;
      for (const q of around.values()) {
        if (q[1] < lo1) lo1 = q[1]; if (q[1] > hi1) hi1 = q[1];
        if (q[2] < lo2) lo2 = q[2]; if (q[2] > hi2) hi2 = q[2];
      }
      const calm = hi1 <= lo1 * OUTLIER && hi2 <= lo2 * OUTLIER;
      let kept = calm ? pool : pool.filter(([who, p]) => {
        const others: Point[] = [];
        for (const [w, q] of around) if (w !== who) others.push(q);
        if (!others.length) return true;
        const off = [1, 2].filter((f) => far(p[f], median(others.map((q) => q[f]))));
        return off.every((f) => others.some((q) => near(q[f], p[f])));
      });
      if (!kept.length && pool.length) {
        const ref = last;
        kept = ref ? pool.filter(([, p]) => !far(p[1], ref[1]) && !far(p[2], ref[2])) : pool;
      }
      const point = kept.length ? aggregate(kept.map(([, p]) => p)) : null;
      if (point) last = point;
      for (const [who, p] of kept) latest.set(who, p);
      out.push({ b, point, kept: new Set(kept.map(([who]) => who)) });
    }
    this.evaluated.set(item, { stamp, out });
    return out;
  }

  /** A realm's file. Old realm keys ("CAMWOWUS2Realm8PvP-Alliance") use their ruleset's ("PvP-Alliance"). */
  file(realm: string): string { return path.join(this.dir, encodeURIComponent(canonicalRealm(realm)) + '.json'); }

  load(realm: string): StoredRealm {
    realm = canonicalRealm(realm);
    let r = this.realms.get(realm);
    if (r) return r;
    try {
      r = JSON.parse(fs.readFileSync(this.file(realm), 'utf8')) as StoredRealm;
    } catch {
      r = { items: {}, names: {}, lastScan: 0, updated: 0, seq: 0 };
    }
    r.items ??= {};
    r.names ??= {};
    this.realms.set(realm, r);
    return r;
  }

  /** Writes a realm's file now, or marks it for the next flush when saves are delayed. */
  save(realm: string): void {
    if (this.saveDelayMs <= 0) return this.write(realm);
    this.dirty.add(realm);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.(); // don't keep the process alive for it; exit handlers call flush()
  }

  /** Writes every realm changed since the last write. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const realms = [...this.dirty];
    this.dirty.clear();
    for (const realm of realms) {
      try {
        this.write(realm);
      } catch (err) {
        this.dirty.add(realm); // try again next time
        throw err;
      }
    }
  }

  private write(realm: string): void {
    const file = this.file(realm);
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.load(realm)));
    fs.renameSync(file + '.tmp', file);
  }

  /** Realm keys with data, from memory and disk. */
  realmKeys(): string[] {
    const keys = new Set(this.realms.keys());
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json') && f !== 'banned.json') keys.add(canonicalRealm(decodeURIComponent(f.slice(0, -5))));
    return [...keys].filter(validRealm);
  }

  /**
   * Adds scans from one uploader. scans: [{ t, items: [[id, min, mkt, qty], ...] }].
   * names (optional): { id: { n, q } }. Both come straight from uploads, so nothing is
   * assumed about them: points that are too old, in the future or malformed are skipped.
   * Returns { points, skipped }.
   */
  ingest(realm: string, reporter: string, scans: unknown, names?: unknown, classes?: unknown): { points: number; skipped: number } {
    if (!validRealm(realm)) throw new HttpError(400, 'Bad realm key');
    if (!Array.isArray(scans)) throw new HttpError(400, 'scans must be a list');
    this.checkBans();
    if (this.bans[reporter]) throw new HttpError(403, 'Uploads from this PC are blocked');
    if (!this.counts(reporter)) throw new HttpError(403, 'This server only takes scans from PCs linked to a Battle.net login. Use "Link to website" in the tray menu, or run: ahtc link');
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
    // names and vendor prices show to everyone: only trusted reporters set vendor prices,
    // and an anonymous one only names an item nobody has named yet
    if (names && typeof names === 'object') {
      for (const [id, info] of Object.entries(names as Record<string, { n?: unknown; q?: unknown; v?: unknown; c?: unknown } | null>)) {
        if (/^\d+$/.test(id) && info && typeof info.n === 'string' && info.n.length <= 200) {
          if (isAnon(reporter) && r.names[id]) continue;
          const v = !isAnon(reporter) && Number.isSafeInteger(info.v) && (info.v as number) > 0 ? { v: info.v as number } : {};
          const c = typeof info.c === 'string' && CATEGORY_RE.test(info.c) ? { c: info.c } : {};
          // the addon used to save -1 (the AH list's "not loaded yet"): unknown never replaces known
          const q = validQuality(info.q) ?? validQuality(r.names[id]?.q);
          r.names[id] = { n: info.n, q, ...v, ...c };
        }
      }
    }
    // category names: trusted uploaders only, since everyone sees them
    if (!isAnon(reporter) && classes) r.classes = { ...r.classes, ...cleanClassNames(classes) };
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
      // work out every point before deleting buckets, since each is checked against the day before it
      const merging: { b: number; p: Point | null }[] = [];
      const before = Object.keys(item.b).length;
      for (const { b, point } of this.evaluate(item)) {
        if (b < keepFrom) { delete item.b[b]; continue; }
        if (b >= rawFrom) continue;
        const reports = item.b[b];
        if (reports['*'] && Object.keys(reports).length === 1 && b % DAY === 0) continue; // already a day bucket
        merging.push({ b, p: point });
      }
      // the buckets change below without bumping u, and the bucket count can come out the
      // same (one hour -> one day), so the cached evaluate() for this item would go stale
      if (merging.length || Object.keys(item.b).length !== before) this.evaluated.delete(item);
      for (const { b, p } of merging) {
        delete item.b[b];
        if (!p) continue;
        const day = Math.floor(b / DAY) * DAY;
        let pts = days.get(day);
        if (!pts) days.set(day, (pts = []));
        pts.push(p);
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

  /** One item's points, oldest first. Buckets where no report counts are left out. */
  points(item: StoredItem): Point[] {
    const out: Point[] = [];
    for (const { point } of this.evaluate(item)) if (point) out.push(point);
    return out;
  }

  /** Every report for an item over the last `hours` and whether it counted, newest first (`ahtc reports`). */
  reports(realm: string, id: string, hours = 24): { bucket: number; reporter: string; point: Point; counted: boolean }[] {
    this.checkBans();
    const item = this.load(realm).items[id];
    if (!item) return [];
    const from = this.now() - hours * HOUR;
    const out: { bucket: number; reporter: string; point: Point; counted: boolean }[] = [];
    for (const { b, kept } of this.evaluate(item)) {
      if (b < from) continue;
      for (const [reporter, point] of Object.entries(item.b[b])) out.push({ bucket: b, reporter, point, counted: kept.has(reporter) });
    }
    return out.reverse();
  }

  /** Price history for a realm, with the cursor to pull only later changes. */
  history(realm: string, { days = 30, since = 0, only }: HistoryOptions = {}): RealmHistory<Point[]> {
    this.checkBans();
    const r = this.load(realm);
    const from = this.now() - days * DAY;
    const items: Record<string, Point[]> = {};
    const entries = only !== undefined ? (r.items[only] ? [[only, r.items[only]] as const] : []) : Object.entries(r.items);
    for (const [id, item] of entries) {
      if (since && item.u <= since) continue;
      const pts = this.points(item).filter((p) => p[0] >= from);
      if (pts.length) items[id] = pts;
    }
    return { items, names: r.names, classes: r.classes || {}, lastScan: r.lastScan || null, updated: r.updated || null, cursor: r.seq || 0 };
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
