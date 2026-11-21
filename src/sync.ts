// One sync: read every account's scans, upload new ones, download realm
// prices, and write AppData.lua for the addon.
import fs from 'node:fs';
import path from 'node:path';
import { listAccounts, appDataPath, addonDir, findWowPath, isWowFolder, type Account } from './wow.ts';
import { readAccount, scansSince, type AccountData, type ClassNames, type ItemName, type Recipe } from './savedVars.ts';
import { decode, encode, merge, trim, DAY, type Point } from './history.ts';
import { ApiClient, ApiError } from './api.ts';
import { buildAppData, writeAppData } from './appData.ts';
import { saveConfig, configDir, type Config } from './config.ts';
import { errorMessage } from './errors.ts';
import { validRealm } from './priceStore.ts';

/** realm -> itemID -> packed history */
export type PackedRealms = Record<string, Record<string, string>>;

// Last download per realm: { items, cursor, days }. It keeps server prices in AppData.lua
// through an outage, and the server's `cursor` is where the next pull starts.
interface CacheEntry { items: Record<string, string>; cursor: number | null; days: number | null; pulled?: number | null }

const cacheFile = (realm: string) => path.join(configDir(), 'cache', encodeURIComponent(realm) + '.json');
function writeCache(realm: string, entry: CacheEntry): void {
  fs.mkdirSync(path.dirname(cacheFile(realm)), { recursive: true });
  fs.writeFileSync(cacheFile(realm) + '.tmp', JSON.stringify(entry));
  fs.renameSync(cacheFile(realm) + '.tmp', cacheFile(realm));
}
function readCacheEntry(realm: string): CacheEntry | null {
  let c: unknown;
  try { c = JSON.parse(fs.readFileSync(cacheFile(realm), 'utf8')); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  // older caches were just the items
  const entry = c as Partial<CacheEntry>;
  return entry.items && typeof entry.items === 'object' ? (entry as CacheEntry) : { items: c as Record<string, string>, cursor: null, days: null };
}
/** Cached server items for a realm (itemID -> packed), or null. */
export function readCache(realm: string): Record<string, string> | null {
  return readCacheEntry(realm)?.items ?? null;
}

/**
 * Pulls a realm's prices: only what changed since the last pull when the cache allows it,
 * merged into the cache. Returns the realm's items (itemID -> packed) and whether it was a full download.
 */
export async function pullRealm(api: ApiClient, realm: string, days: number): Promise<{ items: Record<string, string>; full: boolean; changed: number }> {
  const cache = readCacheEntry(realm);
  // a different `days` needs older history than the cache has: start over
  const since = cache?.cursor && cache.days === days ? cache.cursor : 0;
  const res = await api.prices(realm, days, since || undefined);
  const full = res.full !== false || !since;
  const items = full ? { ...res.items } : { ...cache?.items, ...res.items };
  writeCache(realm, { items, cursor: res.cursor ?? null, days, pulled: res.generated ?? null });
  return { items, full, changed: Object.keys(res.items || {}).length };
}

const SCANS_PER_UPLOAD = 5;
// On the first upload, don't send weeks of old history.
const FIRST_UPLOAD_WINDOW = 2 * DAY;
// Never upload points the addon may already have merged into daily points.
const MAX_UPLOAD_AGE = 13 * DAY;

const decodeItems = (items: Record<string, string>): Record<string, Point[]> =>
  Object.fromEntries(Object.entries(items).map(([id, packed]) => [id, decode(packed)]));

/** Everything read from the accounts' SavedVariables, merged per realm. */
export interface LocalData {
  /** realm -> itemID -> one points list per account */
  local: Record<string, Record<string, Point[][]>>;
  names: Record<string, Record<string, ItemName>>;
  lastScan: Record<string, number>;
  /** the newest scan's listings across accounts */
  ladders: Record<string, { t: number; items: Record<string, string> }>;
  /** ledger record strings from every account, oldest first */
  ledgers: Record<string, string[]>;
  /** realm -> itemID -> "units:seconds", from the account that has watched it longest */
  sales: Record<string, Record<string, string>>;
  /** itemID -> highest price any account watches it at */
  watch: Record<string, number>;
  /** category names ("7" / "7:5" -> name), from every account */
  classes: ClassNames;
  /** recipes and vendor prices from every account (see mergeCrafting) */
  crafting?: Crafting;
  accounts: { name: string; owner: number | null; data: AccountData }[];
}

export interface Crafting { recipes: Record<string, Recipe>; vendorBuy: Record<string, number> }

/** Recipes and vendor prices of several accounts as one. */
export function mergeCrafting(accounts: { recipes?: Record<string, Recipe>; vendorBuy?: Record<string, number> }[]): Crafting {
  const out: Crafting = { recipes: {}, vendorBuy: {} };
  for (const a of accounts) {
    Object.assign(out.recipes, a.recipes);
    Object.assign(out.vendorBuy, a.vendorBuy);
  }
  return out;
}

const salesSeconds = (packed: string | undefined) => Number(packed?.split(':')[1]) || 0;

/** Read every account's AH Tracker data. Unreadable accounts are added to `errors` and skipped. */
export function readLocal(wowPath: string, errors: string[] = [], accountList: Account[] = listAccounts(wowPath)): LocalData {
  const local: LocalData['local'] = {};
  const names: LocalData['names'] = {};
  const lastScan: LocalData['lastScan'] = {};
  const ladders: LocalData['ladders'] = {};
  const ledgers: LocalData['ledgers'] = {};
  const sales: LocalData['sales'] = {};
  const watch: LocalData['watch'] = {};
  const classes: LocalData['classes'] = {};
  const accounts: LocalData['accounts'] = [];
  for (const acct of accountList) {
    let data: AccountData | null;
    try {
      data = readAccount(acct.savedVariables);
    } catch (err) {
      errors.push(`Couldn't read ${acct.name}: ${errorMessage(err)}`);
      continue;
    }
    if (!data) continue;
    accounts.push({ name: acct.name, owner: acct.owner ?? null, data });
    for (const [id, price] of Object.entries(data.watch || {})) watch[id] = Math.max(watch[id] || 0, price);
    Object.assign(classes, data.classNames);
    for (const [realm, r] of Object.entries(data.realms)) {
      if (!validRealm(realm)) continue; // e.g. "-Alliance", saved without a realm name
      const realmItems = (local[realm] ??= {});
      names[realm] = { ...names[realm], ...r.names };
      lastScan[realm] = Math.max(lastScan[realm] || 0, r.lastScan);
      if (r.ladderTime && r.ladderTime > (ladders[realm]?.t || 0)) ladders[realm] = { t: r.ladderTime, items: r.ladders };
      if (r.ledger?.length) (ledgers[realm] ??= []).push(...r.ledger);
      const realmSales = (sales[realm] ??= {});
      for (const [id, packed] of Object.entries(r.sales || {})) {
        if (salesSeconds(packed) > salesSeconds(realmSales[id])) realmSales[id] = packed;
      }
      for (const [id, points] of Object.entries(r.items)) (realmItems[id] ??= []).push(points);
    }
  }
  // records start "kind:time:", so sort by time across accounts
  const time = (rec: string) => Number(rec.split(':')[1]) || 0;
  for (const list of Object.values(ledgers)) list.sort((a, b) => time(a) - time(b));
  return { local, names, lastScan, ladders, ledgers, sales, watch, classes, accounts, crafting: mergeCrafting(accounts.map((a) => a.data)) };
}

/** A watched item listed at or under its price in someone else's scan (from the server). */
export interface WatchAlert { realm: string; id: string; name: string | null; min: number; max: number; t: number }

/** How long after a scan an alert is still worth sending. */
const ALERT_WINDOW = 6 * 3600;

/**
 * Watched items whose newest server point is at or under their price, newer than the
 * last alert for that item. alerted ("realm|id" -> point time) is updated in place.
 * Points from your own scans are skipped: the addon already announced those in game.
 */
export function watchAlerts(
  watch: Record<string, number>, remote: Record<string, Record<string, Point[]>>,
  names: LocalData['names'], alerted: Record<string, number>, now: number,
  local: LocalData['local'] = {},
): WatchAlert[] {
  const out: WatchAlert[] = [];
  for (const [realm, items] of Object.entries(remote)) {
    for (const [id, max] of Object.entries(watch)) {
      const points = items[id];
      const last = points?.[points.length - 1];
      if (!last) continue;
      const [t, min] = last;
      const key = `${realm}|${id}`;
      if (min > max || t <= (alerted[key] || 0) || now - t > ALERT_WINDOW) continue;
      const mine = local[realm]?.[id]?.some((list) => list.some((p) => p[0] >= t));
      if (mine) continue;
      alerted[key] = t;
      out.push({ realm, id, name: names[realm]?.[id]?.n ?? null, min, max, t });
    }
  }
  return out;
}

/** "12g 50s 3c" from copper, like the addon. */
export function formatMoney(copper: number): string {
  const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
  if (g) return `${g}g ${String(s).padStart(2, '0')}s`;
  if (s) return `${s}s ${String(c).padStart(2, '0')}c`;
  return `${c}c`;
}

/** Cached server download for a realm, decoded, or null. */
export function readCachedRemote(realm: string): Record<string, Point[]> | null {
  const cached = readCache(realm);
  return cached ? decodeItems(cached) : null;
}

/**
 * Merge local and server history into packed strings per realm and item.
 * Items not seen for two weeks are left out.
 */
export function buildRealms(local: LocalData['local'], remote: Record<string, Record<string, Point[]>>, now: number, days: number): PackedRealms {
  const out: PackedRealms = {};
  const recent = now - 14 * DAY;
  for (const realm of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const ids = new Set([...Object.keys(local[realm] || {}), ...Object.keys(remote[realm] || {})]);
    const items: Record<string, string> = {};
    for (const id of ids) {
      const lists = [...(local[realm]?.[id] || []), remote[realm]?.[id] || []];
      const points = trim(merge(lists), now, { days });
      if (points.length && points[points.length - 1][0] >= recent) items[id] = encode(points);
    }
    if (Object.keys(items).length) out[realm] = items;
  }
  return out;
}

/**
 * Key for price uploads: a linked PC's token when the price server is the server it's linked
 * to (so uploads count as you), else this install's random apiKey.
 */
export function uploadKey(config: Pick<Config, 'apiKey' | 'serverUrl' | 'pushUrl' | 'pushToken'>): string {
  const origin = (u: string | null) => { try { return new URL(u ?? '').origin; } catch { return null; } };
  if (config.pushToken && config.pushUrl && origin(config.pushUrl) === origin(config.serverUrl)) return config.pushToken;
  return config.apiKey;
}

export function resolveWowPath(config: { wowPath?: string | null }): string {
  const wowPath = config.wowPath || findWowPath();
  if (!isWowFolder(wowPath)) {
    throw new Error(config.wowPath
      ? `"${config.wowPath}" doesn't look like a WoW folder (no WTF or Interface folder).`
      : "Couldn't find WoW Forever. Set the path with: ahtc config set wowPath \"<path to _forever_>\"");
  }
  return wowPath;
}

export interface SyncSummary {
  realms: number;
  items: number;
  uploadedScans: number;
  downloadedRealms: number;
  changedItems?: number;
  wrote: boolean;
  errors: string[];
  /** watched items someone else's scan found at or under your price */
  alerts?: WatchAlert[];
}

export interface SyncOptions {
  log?: (msg: string) => void;
  /** unix seconds, for tests */
  now?: number;
}

/** config: the loaded config; cursors, lastSync and lastSummary are updated and saved. */
export async function sync(config: Config, { log = () => {}, now = Math.floor(Date.now() / 1000) }: SyncOptions = {}): Promise<SyncSummary> {
  const wowPath = resolveWowPath(config);
  if (!fs.existsSync(addonDir(wowPath))) {
    throw new Error(`The AHTracker addon isn't installed in ${addonDir(wowPath)}. Run: ahtc install-addon`);
  }

  const summary: SyncSummary = { realms: 0, items: 0, uploadedScans: 0, downloadedRealms: 0, wrote: false, errors: [] };

  // 1. Read local scans from every account.
  const { local, accounts, watch, names } = readLocal(wowPath, summary.errors);
  log(`Read ${accounts.length} account(s) with AH Tracker data.`);

  // 2. Upload new scans and download realm prices.
  const remote: Record<string, Record<string, Point[]>> = {};
  if (config.serverUrl) {
    const api = new ApiClient(config.serverUrl, uploadKey(config));

    if (config.upload) {
      for (const { name, data } of accounts) {
        for (const [realm, r] of Object.entries(data.realms)) {
          if (!validRealm(realm)) continue;
          const cursorKey = `${name}|${realm}`;
          const since = Math.max(config.cursors[cursorKey] ?? now - FIRST_UPLOAD_WINDOW, now - MAX_UPLOAD_AGE);
          const scans = scansSince(r, since);
          try {
            for (let i = 0; i < scans.length; i += SCANS_PER_UPLOAD) {
              const batch = scans.slice(i, i + SCANS_PER_UPLOAD);
              // names go with the first batch, so the server can show them to everyone
              const first = i === 0;
              await api.uploadScans(realm, batch, first && Object.keys(r.names || {}).length ? r.names : undefined,
                first && Object.keys(data.classNames || {}).length ? data.classNames : undefined);
              config.cursors[cursorKey] = batch[batch.length - 1].t;
              summary.uploadedScans += batch.length;
            }
          } catch (err) {
            summary.errors.push(`Upload for ${realm} failed: ${errorMessage(err)}`);
          }
        }
      }
      if (summary.uploadedScans) log(`Uploaded ${summary.uploadedScans} scan(s).`);
    }

    for (const realm of Object.keys(local)) {
      try {
        const pulled = await pullRealm(api, realm, config.days);
        remote[realm] = decodeItems(pulled.items);
        summary.downloadedRealms++;
        summary.changedItems = (summary.changedItems || 0) + pulled.changed;
      } catch (err) {
        // a realm nobody has uploaded prices for yet (a new character, a new realm key)
        if (err instanceof ApiError && err.status === 404) continue;
        const cached = readCache(realm);
        summary.errors.push(`Download for ${realm} failed: ${errorMessage(err)}${cached ? ' (using the last download)' : ''}`);
        if (cached) remote[realm] = decodeItems(cached);
      }
    }
    if (summary.downloadedRealms) log(`Pulled prices for ${summary.downloadedRealms} realm(s): ${summary.changedItems || 0} item(s) new or changed.`);
  }

  // Watched items that other players' scans found cheap.
  if (Object.keys(watch).length && Object.keys(remote).length) {
    config.alerted ??= {};
    summary.alerts = watchAlerts(watch, remote, names, config.alerted, now, local);
    for (const a of summary.alerts) log(`Watchlist: ${a.name ?? `item ${a.id}`} listed at ${formatMoney(a.min)} on ${a.realm} (your price ${formatMoney(a.max)}).`);
  }

  // 3. Merge (your scans first, they win over server points at the same time) and write.
  const out = buildRealms(local, remote, now, config.days);
  for (const items of Object.values(out)) {
    summary.realms++;
    summary.items += Object.keys(items).length;
  }

  summary.wrote = writeAppData(appDataPath(wowPath), buildAppData(out, now));
  log(summary.wrote
    ? `Wrote prices for ${summary.items} item(s) on ${summary.realms} realm(s). Type /reload in game to load them.`
    : 'Prices unchanged.');

  config.lastSync = now;
  config.lastSummary = summary;
  saveConfig(config);
  return summary;
}
