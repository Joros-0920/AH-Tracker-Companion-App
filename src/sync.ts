// One sync: read every account's scans, upload new ones, download realm
// prices, and write AppData.lua for the addon.
import fs from 'node:fs';
import path from 'node:path';
import { listAccounts, appDataPath, addonDir, findWowPath, isWowFolder, type Account } from './wow.ts';
import { readAccount, scansSince, type AccountData, type ItemName } from './savedVars.ts';
import { decode, encode, merge, trim, DAY, type Point } from './history.ts';
import { ApiClient } from './api.ts';
import { buildAppData, writeAppData } from './appData.ts';
import { saveConfig, configDir, type Config } from './config.ts';
import { errorMessage } from './errors.ts';

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
  accounts: { name: string; owner: number | null; data: AccountData }[];
}

/** Read every account's AH Tracker data. Unreadable accounts are added to `errors` and skipped. */
export function readLocal(wowPath: string, errors: string[] = [], accountList: Account[] = listAccounts(wowPath)): LocalData {
  const local: LocalData['local'] = {};
  const names: LocalData['names'] = {};
  const lastScan: LocalData['lastScan'] = {};
  const ladders: LocalData['ladders'] = {};
  const ledgers: LocalData['ledgers'] = {};
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
    for (const [realm, r] of Object.entries(data.realms)) {
      const realmItems = (local[realm] ??= {});
      names[realm] = { ...names[realm], ...r.names };
      lastScan[realm] = Math.max(lastScan[realm] || 0, r.lastScan);
      if (r.ladderTime && r.ladderTime > (ladders[realm]?.t || 0)) ladders[realm] = { t: r.ladderTime, items: r.ladders };
      if (r.ledger?.length) (ledgers[realm] ??= []).push(...r.ledger);
      for (const [id, points] of Object.entries(r.items)) (realmItems[id] ??= []).push(points);
    }
  }
  // records start "kind:time:", so sort by time across accounts
  const time = (rec: string) => Number(rec.split(':')[1]) || 0;
  for (const list of Object.values(ledgers)) list.sort((a, b) => time(a) - time(b));
  return { local, names, lastScan, ladders, ledgers, accounts };
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
  const { local, accounts } = readLocal(wowPath, summary.errors);
  log(`Read ${accounts.length} account(s) with AH Tracker data.`);

  // 2. Upload new scans and download realm prices.
  const remote: Record<string, Record<string, Point[]>> = {};
  if (config.serverUrl) {
    const api = new ApiClient(config.serverUrl, uploadKey(config));

    if (config.upload) {
      for (const { name, data } of accounts) {
        for (const [realm, r] of Object.entries(data.realms)) {
          const cursorKey = `${name}|${realm}`;
          const since = Math.max(config.cursors[cursorKey] ?? now - FIRST_UPLOAD_WINDOW, now - MAX_UPLOAD_AGE);
          const scans = scansSince(r, since);
          try {
            for (let i = 0; i < scans.length; i += SCANS_PER_UPLOAD) {
              const batch = scans.slice(i, i + SCANS_PER_UPLOAD);
              // names go with the first batch, so the server can show them to everyone
              await api.uploadScans(realm, batch, i === 0 && Object.keys(r.names || {}).length ? r.names : undefined);
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
        const cached = readCache(realm);
        summary.errors.push(`Download for ${realm} failed: ${errorMessage(err)}${cached ? ' (using the last download)' : ''}`);
        if (cached) remote[realm] = decodeItems(cached);
      }
    }
    if (summary.downloadedRealms) log(`Pulled prices for ${summary.downloadedRealms} realm(s): ${summary.changedItems || 0} item(s) new or changed.`);
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
