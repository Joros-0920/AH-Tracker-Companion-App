// Price history helpers. Same packed format as the addon's Store.lua:
// "t:min:mkt:qty,t:min:mkt:qty" oldest first. A point is [t, min, mkt, qty].

export const HOUR = 3600;
export const DAY = 86400;

/** One price point: scan time (unix seconds), lowest buyout, market price, quantity listed. */
export type Point = [t: number, min: number, mkt: number, qty: number];

export function decode(packed: string | null | undefined): Point[] {
  if (!packed) return [];
  const out: Point[] = [];
  for (const part of packed.split(',')) {
    const f = part.split(':');
    if (f.length !== 4) continue;
    const p = f.map(Number);
    if (p.every(Number.isFinite)) out.push(p as Point);
  }
  return out;
}

export function encode(points: readonly (readonly number[])[]): string {
  return points.map((p) => p.map((v) => Math.round(v)).join(':')).join(',');
}

/**
 * Merge several point lists into one sorted list. Points closer than
 * `window` seconds to an already kept point are dropped, and earlier lists
 * win ties. Put the most trusted source first.
 */
export function merge(lists: readonly Point[][], window = 30 * 60): Point[] {
  const tagged: [Point, number][] = [];
  lists.forEach((list, rank) => { for (const p of list) tagged.push([p, rank]); });
  tagged.sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]);
  const out: Point[] = [];
  let lastRank = -1;
  for (const [p, rank] of tagged) {
    const prev = out[out.length - 1];
    if (prev && p[0] - prev[0] < window) {
      // keep the more trusted of the two
      if (rank < lastRank) { out[out.length - 1] = p; lastRank = rank; }
      continue;
    }
    out.push(p);
    lastRank = rank;
  }
  return out;
}

interface DayBucket { day: number; min: number; mkt: number; qty: number; n: number }

/**
 * Keep the last `days` days. Points older than `rawDays` are merged into one
 * per day (lowest min, average market and quantity), the same way the addon
 * compacts its own history.
 */
export function trim(points: readonly Point[], now: number, { days = 30, rawDays = 3 } = {}): Point[] {
  const from = now - days * DAY;
  const rawFrom = now - rawDays * DAY;
  const out: Point[] = [];
  let bucket: DayBucket | null = null;
  const flush = () => {
    if (!bucket) return;
    out.push([Math.min(bucket.day * DAY + DAY / 2, rawFrom - 1), bucket.min, Math.round(bucket.mkt / bucket.n), Math.round(bucket.qty / bucket.n)]);
    bucket = null;
  };
  for (const p of points) {
    if (p[0] < from) continue;
    if (p[0] >= rawFrom) { flush(); out.push(p); continue; }
    const day = Math.floor(p[0] / DAY);
    if (!bucket || bucket.day !== day) { flush(); bucket = { day, min: p[1], mkt: 0, qty: 0, n: 0 }; }
    bucket.min = Math.min(bucket.min, p[1]);
    bucket.mkt += p[2];
    bucket.qty += p[3];
    bucket.n++;
  }
  flush();
  return out;
}
