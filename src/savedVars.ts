// Reading the addon's SavedVariables (AHTrackerDB).
import fs from 'node:fs';
import { parseSavedVariables } from './lua.ts';
import { decode, type Point } from './history.ts';
import { canonicalRealm } from './realm.ts';

/**
 * An item's name and quality, as the addon saw it, what a vendor pays for one (copper),
 * and its category ("classID:subclassID").
 */
export interface ItemName { n: string; q: number | null; v?: number; c?: string }

/** "7:5" */
export const CATEGORY_RE = /^\d{1,3}:\d{1,3}$/;
/** Category names: "7" or "7:5" -> "Trade Goods" / "Cloth" */
export type ClassNames = Record<string, string>;
const CLASS_KEY_RE = /^\d{1,3}(:\d{1,3})?$/;

/** The category names worth keeping from untrusted input. */
export function cleanClassNames(input: unknown): ClassNames {
  const out: ClassNames = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (CLASS_KEY_RE.test(k) && typeof v === 'string' && v.length > 0 && v.length <= 60) out[k] = v;
  }
  return out;
}

/** One scan as uploaded: its time and [itemID, min, mkt, qty] rows. */
export interface Scan { t: number; items: [id: number, min: number, mkt: number, qty: number][] }

/**
 * AHTrackerDB as the addon writes it. Parsed Lua isn't checked against this,
 * so readers still check what they use.
 */
export interface RawItem { h?: string; n?: string; q?: number; v?: number; c?: string }
export interface RawRealm {
  lastScan?: number;
  items?: Record<string, RawItem>;
  ladders?: Record<string, unknown>;
  ladderTime?: number;
  ledger?: Record<string, unknown>;
  /** itemID -> "units:seconds", the addon's running sales estimate */
  sales?: Record<string, unknown>;
}
export interface RawDB {
  realms: Record<string, RawRealm>;
  watch?: Record<string, unknown>;
  classNames?: Record<string, unknown>;
  recipes?: Record<string, unknown>;
  vendorBuy?: Record<string, unknown>;
}
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
  /** itemID -> "units:seconds": units seen selling over that many seconds (recent ones weigh more) */
  sales: Record<string, string>;
}
export interface AccountData {
  realms: Record<string, RealmData>;
  /** itemID -> highest unit price to alert at (/aht watch) */
  watch: Record<string, number>;
  /** category names in the account's game language */
  classNames: ClassNames;
  /** productID -> recipe recorded from a profession window (account-wide) */
  recipes?: Record<string, Recipe>;
  /** itemID -> what a vendor charges for one (crafting reagents) */
  vendorBuy?: Record<string, number>;
}

/** q: units made per craft; r: "reagentID:count,..." (required reagents only) */
export interface Recipe { q: number; r: string }
const REAGENTS_RE = /^\d+:\d+(,\d+:\d+){0,29}$/;

/** The addon's recipes and vendor prices, keeping only well-formed ones. */
export function cleanCrafting(db: Pick<RawDB, 'recipes' | 'vendorBuy'>): { recipes: Record<string, Recipe>; vendorBuy: Record<string, number> } {
  const recipes: Record<string, Recipe> = {};
  for (const [id, raw] of Object.entries(db.recipes || {})) {
    const r = raw as { q?: unknown; r?: unknown } | null;
    if (!/^\d+$/.test(id) || !r || typeof r.r !== 'string' || !REAGENTS_RE.test(r.r)) continue;
    const q = typeof r.q === 'number' && r.q > 0 && r.q < 1000 ? r.q : 1;
    recipes[id] = { q, r: r.r };
  }
  const vendorBuy: Record<string, number> = {};
  for (const [id, price] of Object.entries(db.vendorBuy || {})) {
    if (/^\d+$/.test(id) && Number.isSafeInteger(price) && (price as number) > 0) vendorBuy[id] = price as number;
  }
  return { recipes, vendorBuy };
}

const SALES_RE = /^[\d.]+:\d+$/;

/** Parse a SavedVariables file and return its AHTrackerDB, or null if it has none. */
export function readDB(input: Buffer | string): RawDB | null {
  const db = parseSavedVariables<SavedVariables>(input).AHTrackerDB;
  return db && typeof db.realms === 'object' ? db : null;
}

/** An item list's history points and names, for the items that have them. */
/** An item quality (0 Poor .. 7 Heirloom), or null for unknown, -1 included. */
export const validQuality = (q: unknown): number | null =>
  Number.isInteger(q) && (q as number) >= 0 && (q as number) <= 7 ? (q as number) : null;

export function readItems(items: Record<string, RawItem> = {}): { items: Record<string, Point[]>; names: Record<string, ItemName> } {
  const out: Record<string, Point[]> = {};
  const names: Record<string, ItemName> = {};
  for (const [id, item] of Object.entries(items)) {
    const points = decode(item.h);
    if (points.length) out[id] = points;
    if (item.n) {
      names[id] = {
        n: item.n, q: validQuality(item.q),
        ...(typeof item.v === 'number' && item.v > 0 ? { v: item.v } : {}),
        ...(typeof item.c === 'string' && CATEGORY_RE.test(item.c) ? { c: item.c } : {}),
      };
    }
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
    const sales: Record<string, string> = {};
    for (const [id, packed] of Object.entries(realm.sales || {})) if (typeof packed === 'string' && SALES_RE.test(packed)) sales[id] = packed;
    const data: RealmData = { lastScan: realm.lastScan || 0, items, names, ladders, ladderTime: realm.ladderTime || 0, ledger, sales };
    // old realm keys ("CAMWOWUS2Realm8PvP-Alliance") go under their ruleset ("PvP-Alliance")
    const key = canonicalRealm(realmKey);
    realms[key] = realms[key] ? mergeRealmData(realms[key], data) : data;
  }
  const watch: Record<string, number> = {};
  for (const [id, price] of Object.entries(db.watch || {})) if (typeof price === 'number' && price > 0) watch[id] = price;
  return { realms, watch, classNames: cleanClassNames(db.classNames), ...cleanCrafting(db) };
}

/** Two realms' data as one: every point (one per time), newest ladders, longest sales. */
export function mergeRealmData(a: RealmData, b: RealmData): RealmData {
  const items: Record<string, Point[]> = { ...a.items };
  for (const [id, points] of Object.entries(b.items)) {
    const byTime = new Map((items[id] || []).map((p) => [p[0], p]));
    for (const p of points) if (!byTime.has(p[0])) byTime.set(p[0], p);
    items[id] = [...byTime.values()].sort((x, y) => x[0] - y[0]);
  }
  const sales = { ...a.sales };
  const seconds = (packed?: string) => Number(packed?.split(':')[1]) || 0;
  for (const [id, packed] of Object.entries(b.sales)) if (seconds(packed) > seconds(sales[id])) sales[id] = packed;
  const newer = b.ladderTime > a.ladderTime ? b : a;
  return {
    lastScan: Math.max(a.lastScan, b.lastScan),
    items,
    names: { ...b.names, ...a.names },
    ladders: newer.ladders,
    ladderTime: newer.ladderTime,
    ledger: [...new Set([...a.ledger, ...b.ledger])].sort((x, y) => (Number(x.split(':')[1]) || 0) - (Number(y.split(':')[1]) || 0)),
    sales,
  };
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
