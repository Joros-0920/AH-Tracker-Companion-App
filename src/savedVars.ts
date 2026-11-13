// Reading the addon's SavedVariables (AHTrackerDB).
import fs from 'node:fs';
import { parseSavedVariables } from './lua.ts';
import { decode, type Point } from './history.ts';

/** An item's name and quality, as the addon saw it. */
export interface ItemName { n: string; q: number | null }

/** One scan as uploaded: its time and [itemID, min, mkt, qty] rows. */
export interface Scan { t: number; items: [id: number, min: number, mkt: number, qty: number][] }

/**
 * AHTrackerDB as the addon writes it. Parsed Lua isn't checked against this,
 * so readers still check what they use.
 */
export interface RawItem { h?: string; n?: string; q?: number }
export interface RawRealm {
  lastScan?: number;
  items?: Record<string, RawItem>;
  ladders?: Record<string, unknown>;
  ladderTime?: number;
  ledger?: Record<string, unknown>;
}
export interface RawDB { realms: Record<string, RawRealm> }
export interface SavedVariables { AHTrackerDB?: RawDB }

export interface RealmData {
  lastScan: number;
  items: Record<string, Point[]>;
  names: Record<string, ItemName>;
  /** itemID -> "price:qty,..." from the newest scan */
  ladders: Record<string, string>;
  ladderTime: number;
  /** the addon's ledger record strings; see AHTracker/Ledger.lua for the format */
  ledger: string[];
}
export interface AccountData { realms: Record<string, RealmData> }

/** Parse a SavedVariables file and return its AHTrackerDB, or null if it has none. */
export function readDB(input: Buffer | string): RawDB | null {
  const db = parseSavedVariables<SavedVariables>(input).AHTrackerDB;
  return db && typeof db.realms === 'object' ? db : null;
}

/** An item list's history points and names, for the items that have them. */
export function readItems(items: Record<string, RawItem> = {}): { items: Record<string, Point[]>; names: Record<string, ItemName> } {
  const out: Record<string, Point[]> = {};
  const names: Record<string, ItemName> = {};
  for (const [id, item] of Object.entries(items)) {
    const points = decode(item.h);
    if (points.length) out[id] = points;
    if (item.n) names[id] = { n: item.n, q: item.q ?? null };
  }
  return { items: out, names };
}

/** Read one account's AHTrackerDB, or null if the file is missing or has none. */
export function readAccount(file: string): AccountData | null {
  if (!fs.existsSync(file)) return null;
  const db = readDB(fs.readFileSync(file));
  if (!db) return null;
  const realms: Record<string, RealmData> = {};
  for (const [realmKey, realm] of Object.entries(db.realms)) {
    const { items, names } = readItems(realm.items);
    const ladders: Record<string, string> = {};
    for (const [id, packed] of Object.entries(realm.ladders || {})) if (typeof packed === 'string' && packed) ladders[id] = packed;
    const ledger = Object.values(realm.ledger || {}).filter((r): r is string => typeof r === 'string');
    realms[realmKey] = { lastScan: realm.lastScan || 0, items, names, ladders, ladderTime: realm.ladderTime || 0, ledger };
  }
  return { realms };
}

/**
 * Scans newer than `since`, grouped by scan time. Every item from one scan
 * has the same timestamp (see Store.AddScan in the addon).
 * Returns [{ t, items: [[itemID, min, mkt, qty], ...] }] oldest first.
 */
export function scansSince(realm: { items: Record<string, Point[]> }, since: number): Scan[] {
  const byTime = new Map<number, Scan['items']>();
  for (const [id, points] of Object.entries(realm.items)) {
    for (const [t, min, mkt, qty] of points) {
      if (t <= since) continue;
      let list = byTime.get(t);
      if (!list) byTime.set(t, (list = []));
      list.push([Number(id), min, mkt, qty]);
    }
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, items]) => ({ t, items }));
}
