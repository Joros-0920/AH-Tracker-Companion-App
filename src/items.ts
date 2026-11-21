// Item details for the web app: icon, quality and tooltip, looked up once per item and kept
// in a JSON file (they don't change). Items nobody can find are kept too, and tried again
// after MISS_TTL.
//
// An icon is its file name on Blizzard's render CDN ("inv_misc_herb_01"); the web app builds
// the image URL. A tooltip is a list of lines, already in the order the game shows them.
//
// Two ways to look an item up:
//   - blizzardItems: Blizzard's Game Data API (the hosted server, with BNET_CLIENT_ID/SECRET)
//   - remoteItems: another AH Tracker server's GET /v1/items (the companion, via its serverUrl)
import fs from 'node:fs';
import path from 'node:path';
import { validQuality } from './savedVars.ts';

export interface TooltipLine {
  text: string;
  /** right-aligned text on the same line ("Staff", "Speed 3.20") */
  right?: string;
  /** "#rrggbb"; white when left out */
  color?: string;
}

export interface Tooltip {
  /** the item's English name from Blizzard (the web app shows its own) */
  name: string;
  lines: TooltipLine[];
  /** what a vendor pays, in copper */
  sell?: number;
}

export interface ItemInfo {
  icon: string | null;
  q: number | null;
  tooltip: Tooltip | null;
}

/** item ID -> its details, or null when the source doesn't know the item; left out = try again later */
export type ItemLookup = (ids: number[]) => Promise<Record<number, ItemInfo | null>>;

const MISS_TTL = 7 * 24 * 3600;
const SAVE_DELAY = 5000;
/** ids per GET /v1/items */
export const MAX_ITEM_IDS = 200;
const ICON_RE = /^[a-z0-9_-]{1,100}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_LINES = 40;
const MAX_TEXT = 400;

export const GREEN = '#1eff00';
export const YELLOW = '#ffd100';

type Entry = ItemInfo | { miss: number };
const isMiss = (e: Entry | undefined): e is { miss: number } => !!e && 'miss' in e;

const text = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.slice(0, MAX_TEXT) : null);

/** A tooltip from any source (Blizzard, another server, our own file), or null if it isn't one. */
export function cleanTooltip(raw: unknown): Tooltip | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as { name?: unknown; lines?: unknown; sell?: unknown };
  const name = text(t.name);
  if (!name || !Array.isArray(t.lines)) return null;
  const lines: TooltipLine[] = [];
  for (const l of t.lines.slice(0, MAX_LINES)) {
    const left = text(l?.text);
    if (!left) continue;
    const right = text(l.right);
    lines.push({
      text: left,
      ...(right ? { right } : {}),
      ...(typeof l.color === 'string' && COLOR_RE.test(l.color) ? { color: l.color.toLowerCase() } : {}),
    });
  }
  return { name, lines, ...(Number.isSafeInteger(t.sell) && (t.sell as number) > 0 ? { sell: t.sell as number } : {}) };
}

/** Item details from any source, or null if there's nothing usable in them. */
export function cleanInfo(raw: unknown): ItemInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { icon?: unknown; q?: unknown; tooltip?: unknown };
  const icon = typeof r.icon === 'string' && ICON_RE.test(r.icon) ? r.icon.toLowerCase() : null;
  const info = { icon, q: validQuality(r.q), tooltip: cleanTooltip(r.tooltip) };
  return info.icon || info.q !== null || info.tooltip ? info : null;
}

export class ItemCache {
  file: string;
  lookup: ItemLookup;
  now: () => number;
  entries: Record<string, Entry> = {};
  /** lookups in flight, so the same item isn't fetched twice at once */
  pending = new Map<number, Promise<void>>();
  saveTimer: NodeJS.Timeout | null = null;

  constructor(file: string, lookup: ItemLookup, { now = () => Math.floor(Date.now() / 1000) }: { now?: () => number } = {}) {
    this.file = file;
    this.lookup = lookup;
    this.now = now;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object') {
        for (const [id, e] of Object.entries(saved as Record<string, unknown>)) {
          if (e && typeof e === 'object' && 'miss' in e && typeof e.miss === 'number') this.entries[id] = { miss: e.miss };
          else {
            const info = cleanInfo(e);
            if (info) this.entries[id] = info;
          }
        }
      }
    } catch { /* first run */ }
  }

  /** Details we already have, without looking anything up. */
  known(ids: number[]): Record<string, ItemInfo> {
    const out: Record<string, ItemInfo> = {};
    for (const id of ids) {
      const e = this.entries[id];
      if (e && !isMiss(e)) out[id] = e;
    }
    return out;
  }

  /** Of `ids`, the ones a `get` would look up: never seen, or a miss old enough to retry. */
  unknown(ids: number[]): number[] {
    const now = this.now();
    return ids.filter((id) => {
      const e = this.entries[id];
      return e === undefined || (isMiss(e) && now - e.miss > MISS_TTL);
    });
  }

  /** Of `ids`, the ones the source said it doesn't know (as of the last try). */
  misses(ids: number[]): number[] {
    return ids.filter((id) => isMiss(this.entries[id]));
  }

  /**
   * Details for `ids`, looking up the ones we don't have. Waits at most `waitMs`; lookups still
   * running after that finish in the background and are there for the next request.
   */
  async get(ids: number[], waitMs = 8000): Promise<Record<string, ItemInfo>> {
    const missing = this.unknown(ids);
    const waits = missing.map((id) => this.pending.get(id)).filter((p): p is Promise<void> => !!p);
    const fresh = missing.filter((id) => !this.pending.has(id));
    if (fresh.length) {
      const job = this.lookup(fresh).then((found) => {
        const t = this.now();
        for (const id of fresh) {
          if (found[id] === undefined) continue;
          this.entries[id] = cleanInfo(found[id]) ?? { miss: t };
        }
        this.scheduleSave();
      }, () => { /* the source is down: try again on a later request */ })
        .finally(() => { for (const id of fresh) this.pending.delete(id); });
      for (const id of fresh) this.pending.set(id, job);
      waits.push(job);
    }
    if (waits.length) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, waitMs); });
      await Promise.race([Promise.all(waits), timeout]);
      clearTimeout(timer);
    }
    return this.known(ids);
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_DELAY);
    this.saveTimer.unref();
  }

  save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.entries));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error(`Couldn't save item details: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Blizzard's Game Data API ------------------------------------------------

const QUALITY_TYPES: Record<string, number> = {
  POOR: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, ARTIFACT: 6, HEIRLOOM: 7,
};

type Display = { display_string?: unknown; color?: { r?: number; g?: number; b?: number } };

/** Blizzard's { r, g, b } (0-255) as "#rrggbb"; white text has no color. */
function hex(c: Display['color']): string | undefined {
  if (!c || typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') return undefined;
  const h = '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  return h === '#ffffff' ? undefined : h;
}

// The parts of GET /data/wow/item/{id} (with locale=en_US) a tooltip uses.
interface BlizzardItem {
  name?: unknown;
  quality?: { type?: string };
  sell_price?: unknown;
  preview_item?: {
    name_description?: Display;
    level?: Display;
    binding?: { name?: unknown };
    unique_equipped?: unknown;
    limit_category?: unknown;
    inventory_type?: { name?: unknown };
    item_subclass?: { name?: unknown };
    is_subclass_hidden?: boolean;
    container_slots?: Display;
    weapon?: { damage?: Display; attack_speed?: Display; dps?: Display };
    armor?: { display?: Display };
    shield_block?: { display?: Display };
    stats?: { display?: Display; is_negated?: boolean }[];
    durability?: Display;
    requirements?: { playable_classes?: Display; playable_races?: Display; level?: Display; skill?: Display; reputation?: Display; ability?: Display };
    spells?: { description?: unknown; display_color?: Display['color'] }[];
    set?: { display_string?: unknown; effects?: { display_string?: unknown }[] };
    description?: unknown;
    crafting_reagent?: unknown;
  };
}

/** The tooltip lines for a Blizzard item, in the order the game shows them. */
export function blizzardTooltip(item: BlizzardItem): Tooltip | null {
  const name = text(item.name);
  if (!name) return null;
  const p = item.preview_item ?? {};
  const lines: TooltipLine[] = [];
  const add = (t: unknown, color?: string, right?: unknown) => {
    const left = text(t);
    if (!left) return;
    const r = text(right);
    lines.push({ text: left, ...(r ? { right: r } : {}), ...(color ? { color } : {}) });
  };
  const show = (d: Display | undefined, fallback?: string) => add(d?.display_string, hex(d?.color) ?? fallback);

  show(p.name_description, GREEN);
  show(p.level, YELLOW);
  add(p.binding?.name);
  add(p.unique_equipped);
  add(p.limit_category);
  // "Two-Hand ............ Staff"
  const slot = text(p.inventory_type?.name);
  const sub = p.is_subclass_hidden ? null : text(p.item_subclass?.name);
  if (slot) add(slot, undefined, sub);
  else if (sub && p.weapon) add(sub);
  show(p.container_slots);
  if (p.weapon) {
    add(p.weapon.damage?.display_string, undefined, p.weapon.attack_speed?.display_string);
    show(p.weapon.dps);
  }
  show(p.armor?.display);
  show(p.shield_block?.display);
  for (const s of p.stats ?? []) if (!s.is_negated) show(s.display);
  show(p.durability);
  const req = p.requirements;
  if (req) for (const r of [req.playable_classes, req.playable_races, req.level, req.skill, req.reputation, req.ability]) show(r);
  for (const s of p.spells ?? []) add(s.description, hex(s.display_color) ?? GREEN);
  if (p.set) {
    add(p.set.display_string, YELLOW);
    for (const e of p.set.effects ?? []) add(e.display_string, '#808080');
  }
  if (typeof p.description === 'string' && p.description.trim()) add(`"${p.description}"`, YELLOW);
  add(p.crafting_reagent, '#66bbff');
  return cleanTooltip({ name, lines, sell: item.sell_price });
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface BlizzardOptions {
  clientId: string;
  clientSecret: string;
  region?: string;
  /**
   * Game Data namespaces to try, in order (default Classic Era, then retail): an item's
   * details come from the first that has it.
   */
  namespaces?: string[];
  oauthBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

/**
 * Blizzard's Game Data API: GET /data/wow/item/{id} for quality and tooltip, and
 * /data/wow/media/item/{id} for the icon, from the first namespace that has the item.
 */
export function blizzardItems({ clientId, clientSecret, region = 'us', namespaces, oauthBase = 'https://oauth.battle.net', apiBase, fetch: fetchFn = fetch }: BlizzardOptions): ItemLookup {
  const base = (apiBase ?? `https://${region}.api.blizzard.com`).replace(/\/+$/, '');
  const spaces = namespaces?.length ? namespaces : [`static-classic1x-${region}`, `static-${region}`];
  let token: { value: Promise<string>; expires: number } | null = null;

  // one request shared by every lookup running at once
  const getToken = (): Promise<string> => {
    if (token && Date.now() < token.expires) return token.value;
    const entry = { value: requestToken().then((t) => { entry.expires = Date.now() + (t.expiresIn - 60) * 1000; return t.value; }), expires: Infinity };
    entry.value.catch(() => { if (token === entry) token = null; });
    token = entry;
    return entry.value;
  };

  const requestToken = async (): Promise<{ value: string; expiresIn: number }> => {
    const res = await fetchFn(`${oauthBase.replace(/\/+$/, '')}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Battle.net token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return { value: body.access_token, expiresIn: body.expires_in };
  };

  /** The JSON at `path` in namespace `ns`, or null on a 404. */
  const get = async <T>(path: string, ns: string): Promise<T | null> => {
    const res = await fetchFn(`${base}${path}?namespace=${ns}&locale=en_US`, {
      headers: { Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (res.status === 401) token = null;
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  };

  const one = async (id: number): Promise<ItemInfo | null> => {
    for (const ns of spaces) {
      const item = await get<BlizzardItem>(`/data/wow/item/${id}`, ns);
      if (!item) continue;
      const media = await get<{ assets?: { key: string; value: string }[] }>(`/data/wow/media/item/${id}`, ns);
      const url = media?.assets?.find((a) => a.key === 'icon')?.value;
      return {
        icon: url?.match(/\/([^/]+)\.(?:jpg|png)$/i)?.[1] ?? null,
        q: QUALITY_TYPES[item.quality?.type ?? ''] ?? null,
        tooltip: blizzardTooltip(item),
      };
    }
    return null;
  };

  return async (ids) => {
    const out: Record<number, ItemInfo | null> = {};
    let failed: unknown = null;
    // Blizzard allows 100 requests a second; each item is two
    await pool(ids, 8, async (id) => {
      try { out[id] = await one(id); } catch (err) { failed = err; }
    });
    // nothing came back at all: let the cache retry instead of storing misses
    if (failed && !Object.keys(out).length) throw failed;
    return out;
  };
}

/** Another AH Tracker server's item details (the companion asks the hosted one). */
export function remoteItems(serverUrl: string, fetchFn: typeof fetch = fetch): ItemLookup {
  const base = serverUrl.replace(/\/+$/, '');
  return async (ids) => {
    const out: Record<number, ItemInfo | null> = {};
    for (let i = 0; i < ids.length; i += MAX_ITEM_IDS) {
      const chunk = ids.slice(i, i + MAX_ITEM_IDS);
      const res = await fetchFn(`${base}/v1/items?tooltips=1&ids=${chunk.join(',')}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Item details from ${base}: ${res.status}`);
      const body = (await res.json()) as { items?: Record<string, unknown>; missing?: number[] };
      // an id in neither list is still being looked up there: leave it out to ask again later
      for (const id of body.missing ?? []) out[id] = null;
      for (const [id, info] of Object.entries(body.items ?? {})) {
        const clean = cleanInfo(info);
        if (clean) out[Number(id)] = clean;
      }
    }
    return out;
  };
}

/**
 * The item source this install should use: Blizzard's API when BNET_CLIENT_ID/SECRET are set
 * (the hosted server), else the price server at `serverUrl` (a companion), else none.
 * BLIZZARD_NAMESPACES (comma-separated) overrides which game versions' data to use.
 */
export function itemCacheFor(dir: string, serverUrl: string | null, env: NodeJS.ProcessEnv = process.env): ItemCache | null {
  const file = path.join(dir, 'items.json');
  const { BNET_CLIENT_ID: clientId, BNET_CLIENT_SECRET: clientSecret } = env;
  if (clientId && clientSecret) {
    const namespaces = (env.BLIZZARD_NAMESPACES || '').split(',').map((s) => s.trim()).filter(Boolean);
    return new ItemCache(file, blizzardItems({ clientId, clientSecret, region: env.BNET_REGION || 'us', namespaces, oauthBase: env.BNET_OAUTH_URL }));
  }
  if (serverUrl) return new ItemCache(file, remoteItems(serverUrl));
  return null;
}
