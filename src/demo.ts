// Made-up price history so the web app can be tried before any real scans.
// Everything here is generated; the realms are "Demo-Horde" and its neutral AH, "Demo-Neutral".
import { DAY, type Point } from './history.ts';
import type { ItemName } from './savedVars.ts';
import type { LocalData } from './sync.ts';

const ITEMS: [id: number, name: string, quality: number, base: number][] = [
  [2589, 'Linen Cloth', 1, 12], [2592, 'Wool Cloth', 1, 35], [4306, 'Silk Cloth', 1, 90],
  [4338, 'Mageweave Cloth', 1, 140], [14047, 'Runecloth', 1, 260], [2770, 'Copper Ore', 1, 45],
  [2771, 'Tin Ore', 1, 70], [2772, 'Iron Ore', 1, 180], [3858, 'Mithril Ore', 1, 260],
  [10620, 'Thorium Ore', 1, 420], [2447, 'Peacebloom', 1, 15], [765, 'Silverleaf', 1, 18],
  [785, 'Mageroyal', 1, 60], [2450, 'Briarthorn', 1, 75], [3356, 'Kingsblood', 1, 160],
  [3818, 'Fadeleaf', 1, 190], [3821, 'Goldthorn', 1, 210], [13463, 'Dreamfoil', 1, 650],
  [13468, 'Black Lotus', 2, 450000], [2318, 'Light Leather', 1, 25], [2319, 'Medium Leather', 1, 55],
  [4234, 'Heavy Leather', 1, 140], [4304, 'Thick Leather', 1, 310], [8170, 'Rugged Leather', 1, 520],
  [12363, 'Arcane Crystal', 2, 220000], [7078, 'Essence of Fire', 2, 18000], [7068, 'Elemental Fire', 1, 3500],
  [14344, 'Large Brilliant Shard', 3, 42000], [13446, 'Major Healing Potion', 1, 4500],
  [13452, 'Elixir of the Mongoose', 1, 16000],
];

// Small deterministic random generator so the demo looks the same every run.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Returns the same shape as readLocal(), with no accounts. */
export function demoData(now = Math.floor(Date.now() / 1000)): LocalData {
  const realm = 'Demo-Horde';
  const rand = rng(42);
  const items: Record<string, Point[][]> = {};
  const names: Record<string, ItemName> = {};
  const scanTimes: number[] = [];
  const ladders: Record<string, string> = {};
  // 3 scans a day for 30 days
  for (let t = now - 30 * DAY; t <= now - 600; t += DAY / 3) scanTimes.push(Math.round(t + rand() * 3600));

  ITEMS.forEach(([id, name, quality, base], idx) => {
    names[id] = { n: name, q: quality };
    // different shapes so every signal shows up: rising, falling, flat, a crash, a spike
    const shape = idx % 6;
    const points: Point[] = [];
    scanTimes.forEach((t, i) => {
      const f = i / scanTimes.length;
      let level = 1;
      if (shape === 1) level = 0.92 + 0.16 * f;        // rising
      if (shape === 2) level = 1.08 - 0.16 * f;        // falling
      if (shape === 3) level = 1 + 0.15 * Math.sin(f * 12); // weekly swing
      if (shape === 4 && i === scanTimes.length - 1) level = 0.65; // someone undercut hard: buy
      if (shape === 5 && i >= scanTimes.length - 2) level = 1.45; // supply dried up: sell
      const mkt = Math.round(base * level * (0.95 + rand() * 0.1));
      const min = Math.round(mkt * (0.93 + rand() * 0.05));
      const qty = Math.round((base > 10000 ? 8 : 600) * (0.5 + rand()) * (shape === 5 && level > 1.2 ? 0.2 : 1));
      points.push([t, shape === 4 && level < 1 ? mkt : min, mkt, Math.max(1, qty)]);
    });
    items[id] = [points];

    // listings for the last scan: a few cheap ones, a band near market, then a thin expensive tail
    const [, min, mkt, qty] = points[points.length - 1];
    const levels: [price: number, n: number][] = [];
    let left = qty;
    for (let i = 0; i < 12 && left > 0; i++) {
      const price = Math.round(i === 0 ? min : mkt * (0.9 + i * 0.06 + rand() * 0.03));
      const n = i === 11 ? left : Math.max(1, Math.min(left, Math.round(qty * (i < 4 ? 0.04 : 0.12) * (0.5 + rand()))));
      if (levels.length && price <= levels[levels.length - 1][0]) continue;
      levels.push([price, n]);
      left -= n;
    }
    ladders[id] = levels.map((l) => l.join(':')).join(',');
  });

  const last = scanTimes[scanTimes.length - 1];

  // a month of made-up trading: buy cheap stacks, sell some of them for more, the odd expiry
  const ledger: string[] = [];
  const traded = ITEMS.slice(0, 12);
  for (let t = now - 28 * DAY; t < now - 3600; t += Math.round(DAY * (0.3 + rand() * 0.5))) {
    const [id, name, , base] = traded[Math.floor(rand() * traded.length)];
    const qty = base > 10000 ? 1 + Math.floor(rand() * 3) : 20 * (1 + Math.floor(rand() * 5));
    const roll = rand();
    const rec = (kind: string, amount: number, fee = 0, extra = 0) => ledger.push(`${kind}:${Math.round(t)}:${kind === 's' ? 0 : id}:${qty}:${Math.round(amount)}:${Math.round(fee)}:${Math.round(extra)}:${ledger.length % 3 ? 'Demo' : 'Demobank'}:${name}`);
    if (roll < 0.45) rec('b', qty * base * (0.75 + rand() * 0.15));
    else if (roll < 0.62) rec('d', qty * base * 0.05, 0, base * 1.2);
    else if (roll < 0.95) { const gross = qty * base * (1.05 + rand() * 0.3); rec('s', gross, gross * 0.05, qty * base * 0.05); }
    else rec('x', 0);
  }
  // The neutral AH: thinner supply, usually a bit dearer, but every fourth item is much
  // cheaper there so the neutral buy suggestions have something to show.
  const neutral = 'Demo-Neutral';
  const nItems: Record<string, Point[][]> = {};
  const nLadders: Record<string, string> = {};
  ITEMS.forEach(([id], idx) => {
    const f = idx % 4 === 2 ? 0.55 : 1.1;
    const scale = (p: number) => Math.max(1, Math.round(p * f * (0.97 + rand() * 0.06)));
    nItems[id] = [items[id][0].filter((_, i) => i % 3 === 0).map(([t, min, mkt, qty]) => [t, scale(min), scale(mkt), Math.max(1, Math.round(qty * 0.3))])];
    nLadders[id] = ladders[id].split(',').map((l) => l.split(':').map(Number))
      .map(([price, qty]) => `${scale(price)}:${Math.max(1, Math.round(qty * 0.3))}`)
      .sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0])).join(',');
  });
  // like a real scan: the neutral AH's last scan is the newest point it has
  const nLast = Math.max(...Object.values(nItems).map(([pts]) => pts[pts.length - 1][0]));

  return {
    local: { [realm]: items, [neutral]: nItems }, names: { [realm]: names, [neutral]: names },
    lastScan: { [realm]: last, [neutral]: nLast },
    ladders: { [realm]: { t: last, items: ladders }, [neutral]: { t: nLast, items: nLadders } },
    ledgers: { [realm]: ledger },
    accounts: [],
  };
}
