// Local web server for the web app. It serves:
//   GET /v1/realms                       -> { realms: [{ realm, items, lastScan }] }
//   GET /v1/realms/:realm/prices?days=N  -> { realm, generated, items: { id: packed }, names: { id: { n, q } },
//                                            ladders: { id: "price:qty,..." }, ladderTime }
//     ladders are the newest local scan's listings, cheapest first, for buyout math.
//     Also sales: { id: "units:seconds" }, the addon's sell-rate estimate, names[id].v (vendor price),
//     names[id].c (category, "classID:subclassID") and classes: { "7": "Trade Goods", "7:5": "Cloth" }.
//   GET /v1/realms/:realm/ledger         -> { realm, records: ["kind:t:id:qty:amount:fee:extra:char:name", ...], names }
//     your own buys, sales, deposits and expiries from every account. With privateLedger (the
//     hosted server) you must be logged in (401), and you get only the accounts your linked PCs
//     pushed; admins (AHTC_ADMINS) also get files pushed with the shared token.
//   GET /v1/items?ids=1,2,3[&tooltips=1] -> { items: { id: { icon, q, tooltip? } }, missing: [ids no source knows] }
//     icon (a file name on Blizzard's render CDN) and quality, plus the tooltip with tooltips=1
//     (see items.ts); 404 when the server has no item source. Ids in neither list are still
//     being looked up: ask again later.
//   GET /v1/me -> { user, login }: who's logged in; login says whether Battle.net login is set up.
//     With opts.auth, auth.ts also serves /auth/bnet/login, /auth/bnet/callback and /auth/logout.
//   With a price store (the hosted server, AHTC_PRICE_SERVER=1), also:
//   POST /v1/scans  { realm, scans: [{ t, items: [[id, min, mkt, qty]] }], names? } -> { ok, points, skipped }
//     scans from any companion; "Authorization: Bearer <its apiKey>". See priceStore.ts.
//   GET /v1/realms/:realm/prices?days=N&since=C -> only items that changed after cursor C
//     (an earlier answer's `cursor`), with `full: false`. Every answer carries `cursor`.
//   PUT /v1/accounts/:account/savedvariables -> { ok, account, realms, bytes }
//     replaces that account's AHTracker.lua with the request body (gzip allowed). Needs
//     "Authorization: Bearer <token>": a linked PC's device token (stored under its user, in
//     users/<id>/WTF/Account/...) or the shared AHTC_PUSH_TOKEN (stored in WTF/Account/...).
//     The companion's `push` sends this whenever the game saves (see push.ts).
// the same read API the central price server will have, built from your own
// scans plus the last server download. It also serves the built web app (web/dist).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { listAccounts, ADDON, type Account } from './wow.ts';
import { readLocal, readCachedRemote, buildRealms, resolveWowPath, type LocalData } from './sync.ts';
import { demoData } from './demo.ts';
import { readDB, readItems, scansSince, validQuality, type ItemName, type RawDB } from './savedVars.ts';
import { MAX_AGE, RateLimit, anonReporter, reporterId, validRealm, type PriceStore } from './priceStore.ts';
import { HttpError, statusOf, errorMessage } from './errors.ts';
import { canonicalRealm } from './realm.ts';
import type { Auth } from './auth.ts';
import { MAX_ITEM_IDS, type ItemCache, type ItemInfo } from './items.ts';
import type { Config } from './config.ts';

const MAX_UPLOAD = 64 * 1024 * 1024; // bytes after unzipping; real files are a few MB
const MAX_SCAN_UPLOAD = 32 * 1024 * 1024;
// new items one address may have looked up per hour (a big realm is a few thousand items)
const ITEM_LOOKUPS_PER_IP = 6000;
// WoW account folder names: "WOW1", "123456789#1", ...
const ACCOUNT_RE = /^[A-Za-z0-9#_.-]{1,64}$/;

/** The web app's build in this repo; a packaged app passes its own copy as `webDist`. */
export const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

/** The server only needs to know where the WoW-style data folder is. */
export type ServerConfig = Partial<Pick<Config, 'wowPath'>>;

/**
 * Every SavedVariables file on this server: the shared-token ones in WTF/Account (owner null)
 * and each user's in users/<id>/WTF/Account (owner = user id, name "<id>/<account>").
 */
export function hostedAccounts(wowPath: string): Account[] {
  const out: Account[] = listAccounts(wowPath).map((a) => ({ ...a, owner: null }));
  const root = path.join(wowPath, 'users');
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root)) {
    if (!/^\d+$/.test(id)) continue;
    for (const a of listAccounts(path.join(root, id))) out.push({ ...a, name: `${id}/${a.name}`, owner: Number(id) });
  }
  return out;
}

/** Folder that holds a pushed account's file, for a user or the shared token (owner null). */
function accountDir(wowPath: string, owner: number | null, account: string): string {
  const base = owner ? path.join(wowPath, 'users', String(owner)) : wowPath;
  return path.join(base, 'WTF', 'Account', account, 'SavedVariables');
}

/** Loads data, re-reading SavedVariables only when the game has written them. */
function dataSource(config: ServerConfig, demo: boolean): () => LocalData {
  if (demo) {
    const d = demoData();
    return () => d;
  }
  let key: string | null = null;
  let data: LocalData | null = null;
  return () => {
    const wowPath = resolveWowPath(config);
    const accounts = hostedAccounts(wowPath);
    const stamp = accounts.map((a) => { try { return `${a.name}@${fs.statSync(a.savedVariables).mtimeMs}`; } catch { return a.name; } }).join(',');
    if (stamp !== key || !data) {
      data = readLocal(wowPath, [], accounts);
      key = stamp;
    }
    return data;
  };
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The body, unzipped when it was sent with gzip. */
async function readMaybeGzip(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const body = await readBody(req, limit);
  if (!/gzip/i.test(req.headers['content-encoding'] || '')) return body;
  try {
    return zlib.gunzipSync(body, { maxOutputLength: limit });
  } catch {
    throw new HttpError(400, 'Body is not valid gzip, or too large once unzipped');
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** Saves an uploaded SavedVariables file for `account`, after checking it parses. */
async function receiveSavedVariables(
  req: http.IncomingMessage, res: http.ServerResponse, config: ServerConfig, account: string,
  token: string | null | undefined, store: PriceStore | null, auth: Auth | null,
): Promise<void> {
  if (!token && !auth) return send(res, 404, { error: 'Uploads are turned off on this server (AHTC_PUSH_TOKEN is not set)' });
  // a linked PC files under its user; the shared token files under no one (the owner's old setup)
  let owner: number | null = null;
  if (!(token && tokenOk(req.headers.authorization, token))) {
    const user = auth?.deviceUser(req.headers.authorization);
    if (!user) return send(res, 401, { error: 'Wrong or missing upload token. Link this PC again (ahtc link).' });
    owner = user.id;
  }
  if (!ACCOUNT_RE.test(account)) return send(res, 400, { error: 'Bad account name' });

  const body = await readMaybeGzip(req, MAX_UPLOAD);
  let db: RawDB | null;
  try {
    db = readDB(body);
  } catch (err) {
    return send(res, 400, { error: `Not a SavedVariables file: ${errorMessage(err)}` });
  }
  if (!db) return send(res, 400, { error: 'No AHTrackerDB in the upload' });

  const dir = accountDir(resolveWowPath(config), owner, account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ADDON}.lua`);
  // swap in whole so a read never sees half a file
  fs.writeFileSync(file + '.tmp', body);
  fs.renameSync(file + '.tmp', file);
  if (store) ingestSavedVariables(store, account, db, owner);
  return send(res, 200, { ok: true, account, realms: Object.keys(db.realms), bytes: body.length, owner });
}

/** One price vote per user; shared-token pushes and plain API keys vote on their own. */
export const userReporter = (userId: number): string => reporterId(`user:${userId}`);

/** Adds the recent scans in a pushed SavedVariables file to the price store: one uploader per user (or per account for the shared token). */
export function ingestSavedVariables(store: PriceStore, account: string, db: RawDB, owner: number | null = null): void {
  const reporter = owner ? userReporter(owner) : reporterId(`push:${account}`);
  const since = store.now() - MAX_AGE;
  for (const [realm, r] of Object.entries(db.realms || {})) {
    if (!validRealm(realm)) continue;
    const { items, names } = readItems(r.items);
    const scans = scansSince({ items }, since);
    if (scans.length) store.ingest(realm, reporter, scans, names, db.classNames);
  }
}

/** Loads every SavedVariables file already on the server into the store (first start after an update). */
export function ingestPushedFiles(config: ServerConfig, store: PriceStore, log: (msg: string) => void = () => {}): number {
  let n = 0;
  for (const acct of hostedAccounts(resolveWowPath(config))) {
    try {
      if (!fs.existsSync(acct.savedVariables)) continue;
      const db = readDB(fs.readFileSync(acct.savedVariables));
      if (db) { ingestSavedVariables(store, acct.name, db, acct.owner); n++; }
    } catch (err) {
      log(`Couldn't load ${acct.name} into the price store: ${errorMessage(err)}`);
    }
  }
  return n;
}

async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const body = await readMaybeGzip(req, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

/** The caller's address: Fly's header, the first X-Forwarded-For hop, or the socket. */
function clientIp(req: http.IncomingMessage): string {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly) return fly;
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || '?';
}

/** Anonymous scans allowed per IP address per hour, however many API keys it uses. */
export const ANON_SCANS_PER_IP = 240;

/**
 * POST /v1/scans. A linked PC's scans vote as its Battle.net user (one vote per user per
 * hour bucket, however many PCs). A plain API key's scans are anonymous: they only fill in
 * buckets no linked PC reported, and are refused with AHTC_ANON_UPLOADS=off.
 */
async function receiveScans(req: http.IncomingMessage, res: http.ServerResponse, store: PriceStore, limiter: RateLimit, ipLimiter: RateLimit, auth: Auth | null): Promise<void> {
  const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (key.length < 16 || key.length > 200) return send(res, 401, { error: 'Send your API key as "Authorization: Bearer <key>"' });
  const user = auth?.deviceUser(key);
  const reporter = user ? userReporter(user.id) : anonReporter(key);
  const body = (await readJson(req, MAX_SCAN_UPLOAD)) as { realm?: unknown; scans?: unknown; names?: unknown; classes?: unknown } | null;
  if (!body || !validRealm(body.realm) || !Array.isArray(body.scans)) return send(res, 400, { error: 'Expected { realm, scans: [...] }' });
  const n = Math.max(1, body.scans.length);
  // per user for linked PCs; per key and per address for anonymous ones, so new keys don't help
  if (!limiter.take(reporter, n) || (!user && !ipLimiter.take(clientIp(req), n))) {
    return send(res, 429, { error: 'Too many uploads; try again later' });
  }
  const r = store.ingest(body.realm, reporter, body.scans, body.names, body.classes);
  return send(res, 200, { ok: true, ...r, counted: user ? 'linked' : 'anonymous' });
}

/** Smaller bodies aren't worth compressing. */
const MIN_COMPRESS = 1024;
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

/** gzip if the client takes it (a full realm's prices are megabytes of very repetitive text). */
const wantsGzip = (req: http.IncomingMessage | undefined): boolean => /\bgzip\b/i.test(String(req?.headers['accept-encoding'] || ''));

/** A JSON answer kept for reuse, gzipped the first time a client asks for that. */
interface CachedAnswer { stamp: string; text: string; gz?: Buffer }

function sendCached(res: http.ServerResponse, answer: CachedAnswer): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (!wantsGzip(res.req) || Buffer.byteLength(answer.text) < MIN_COMPRESS) {
    res.writeHead(200, headers);
    res.end(answer.text);
    return;
  }
  const reply = (gz: Buffer) => { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); res.end(gz); };
  if (answer.gz) return reply(answer.gz);
  zlib.gzip(answer.text, { level: 6 }, (err, gz) => {
    if (err) { res.writeHead(200, headers); res.end(answer.text); return; }
    answer.gz = gz;
    reply(gz);
  });
}

/** Keep a realm's full answer this long at most, even if nothing changed (it trims by the clock). */
const ANSWER_TTL = 60;

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const headers: Record<string, string> = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  if (Buffer.byteLength(text) < MIN_COMPRESS || !wantsGzip(res.req)) {
    res.writeHead(status, headers);
    res.end(text);
    return;
  }
  // async, so compressing a big answer doesn't hold up other requests
  zlib.gzip(text, { level: 6 }, (err, zipped) => {
    if (err) {
      res.writeHead(status, headers);
      res.end(text);
      return;
    }
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip' });
    res.end(zipped);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, webDist: string): void {
  if (!fs.existsSync(webDist)) {
    return send(res, 404, 'Web app not built yet. Run "yarn build" in the web folder, or use "yarn dev" there.', 'text/plain');
  }
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = path.join(webDist, urlPath);
  // stay inside dist; anything unknown gets the app (client-side routing)
  if (!file.startsWith(webDist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webDist, 'index.html');
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  // Vite's hashed files under /assets never change; index.html must be checked so a new build shows up
  const hashed = path.relative(webDist, file).split(path.sep)[0] === 'assets';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    Vary: 'Accept-Encoding',
  };
  const stream = fs.createReadStream(file);
  if (COMPRESSIBLE.test(type) && wantsGzip(req)) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    stream.pipe(zlib.createGzip()).pipe(res);
  } else {
    res.writeHead(200, headers);
    stream.pipe(res);
  }
}

export const DEFAULT_PORT = 4417;

export interface ServerOptions {
  /** serve made-up data (demo.ts) and take no uploads */
  demo?: boolean;
  /** secret for the upload endpoint (default: AHTC_PUSH_TOKEN); unset = uploads off */
  pushToken?: string | null;
  /** a PriceStore, to be a price server */
  store?: PriceStore | null;
  /** Battle.net login */
  auth?: Auth | null;
  /** trades only for a logged-in admin (the hosted server; your own PC doesn't need it) */
  privateLedger?: boolean;
  /** folder with the built web app (default: web/dist in this repo) */
  webDist?: string;
  /** item details for GET /v1/items (none: the route is a 404) */
  items?: ItemCache | null;
}

export interface StartOptions extends ServerOptions {
  port?: number;
  host?: string;
  /** a busy port falls back to any free one */
  fallback?: boolean;
}

/**
 * Starts the server; used by both `ahtc serve` and the tray app so they serve the same thing.
 * With `fallback`, a busy port (say `ahtc serve` is already running) falls back to any free one.
 */
export function startServer(config: ServerConfig, { port = DEFAULT_PORT, host = '127.0.0.1', fallback = false, ...opts }: StartOptions = {}): Promise<{ server: http.Server; url: string }> {
  const server = createServer(config, opts);
  return new Promise((resolve, reject) => {
    const listen = (p: number) => server.listen(p, host);
    server.on('listening', () => {
      const shown = host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
      resolve({ server, url: `http://${shown}:${(server.address() as AddressInfo).port}` });
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (fallback && err.code === 'EADDRINUSE' && port !== 0) { port = 0; listen(0); } else reject(err);
    });
    listen(port);
  });
}

/** True once the web app has been built (`yarn build` in web/), or `webDist` holds a build. */
export const webBuilt = (webDist = WEB_DIST): boolean => fs.existsSync(path.join(webDist, 'index.html'));

/** Two sets of item names, `b` winning, except that a known quality isn't lost to an unknown one. */
export function mergeNames(a: Record<string, ItemName> | undefined, b: Record<string, ItemName> | undefined): Record<string, ItemName> {
  const out = { ...a, ...b };
  if (a && b) {
    for (const id of Object.keys(b)) {
      if (validQuality(b[id].q) === null && validQuality(a[id]?.q) !== null) out[id] = { ...b[id], q: a[id].q };
    }
  }
  return out;
}

type RealmListing = { realm: string; items: number; lastScan: number | null; updated?: number | null };

export function createServer(config: ServerConfig, { demo = false, pushToken = process.env.AHTC_PUSH_TOKEN, store = null, auth = null, privateLedger = false, webDist = WEB_DIST, items: itemCache = null }: ServerOptions = {}): http.Server {
  const loadData = dataSource(config, demo);
  // a new object whenever SavedVariables are re-read, so the generation says when data changed
  let lastData: LocalData | null = null;
  let dataGen = 0;
  const load = (): LocalData => {
    const d = loadData();
    if (d !== lastData) { lastData = d; dataGen++; }
    return d;
  };
  // Full price answers by realm and range: every browser reloads after a scan, and building
  // and zipping a big realm for each of them was the server's main cost.
  const answers = new Map<string, CachedAnswer>();
  const limiter = new RateLimit();
  const ipLimiter = new RateLimit(ANON_SCANS_PER_IP);
  const itemLimiter = new RateLimit(ITEM_LOOKUPS_PER_IP);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (auth) {
      try {
        if (await auth.handle(req, res, url)) return;
      } catch (err) {
        return send(res, statusOf(err), { error: errorMessage(err) });
      }
    } else if (url.pathname === '/v1/me') {
      return send(res, 200, { user: null, login: false });
    }
    const up = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/savedvariables$/);
    if (up) {
      if (req.method !== 'PUT') return send(res, 405, { error: 'Use PUT' });
      if (demo) return send(res, 403, { error: 'The demo server does not take uploads' });
      try {
        return await receiveSavedVariables(req, res, config, decodeURIComponent(up[1]), pushToken, store, auth);
      } catch (err) {
        return send(res, statusOf(err), { error: errorMessage(err) });
      }
    }
    if (url.pathname === '/v1/scans') {
      if (!store) return send(res, 404, { error: 'This server does not take scans (it is not a price server)' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      try {
        return await receiveScans(req, res, store, limiter, ipLimiter, auth);
      } catch (err) {
        return send(res, statusOf(err), { error: errorMessage(err) });
      }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Only GET is supported' });
    try {
      if (url.pathname === '/v1/items') {
        if (!itemCache) return send(res, 404, { error: 'This server has no item details' });
        const raw = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
        if (raw.length > MAX_ITEM_IDS || !raw.every((x) => /^\d{1,10}$/.test(x))) {
          return send(res, 400, { error: `ids must be up to ${MAX_ITEM_IDS} comma-separated item IDs` });
        }
        const ids = [...new Set(raw.map(Number))];
        // each new id costs lookups at Blizzard; known ones are free
        const fresh = itemCache.unknown(ids).filter((id) => !itemCache.pending.has(id)).length;
        const found = fresh && !itemLimiter.take(clientIp(req), fresh) ? itemCache.known(ids) : await itemCache.get(ids);
        // tooltips are most of the size: only when asked for
        const tooltips = url.searchParams.get('tooltips') === '1';
        const out: Record<string, Partial<ItemInfo>> = {};
        for (const [id, info] of Object.entries(found)) out[id] = tooltips ? info : { icon: info.icon, q: info.q };
        return send(res, 200, { items: out, missing: itemCache.misses(ids) });
      }
      if (url.pathname === '/v1/realms') {
        const { local, lastScan, ledgers, ladders } = load();
        const byRealm = new Map<string, RealmListing>(Object.keys(local).map((realm) => [realm, {
          realm, items: Object.keys(local[realm]).length, lastScan: lastScan[realm] || null,
        }]));
        for (const s of store ? store.summary() : []) {
          const r = byRealm.get(s.realm);
          if (!r) byRealm.set(s.realm, s);
          else Object.assign(r, { items: Math.max(r.items, s.items), lastScan: Math.max(r.lastScan || 0, s.lastScan || 0) || null, updated: s.updated });
        }
        // Logging in on a realm makes an entry for its ledger even if you never use the AH
        // there; leave those out until they hold prices, a scan or a trade.
        const used = (r: RealmListing) => r.items > 0 || r.lastScan || ledgers?.[r.realm]?.length || ladders?.[r.realm];
        return send(res, 200, { realms: [...byRealm.values()].filter(used), demo });
      }
      const m = url.pathname.match(/^\/v1\/realms\/([^/]+)\/prices$/);
      if (m) {
        const realm = canonicalRealm(decodeURIComponent(m[1]));
        const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 180);
        const since = Number(url.searchParams.get('since')) || 0;
        const { local, names, ladders, sales, classes } = load();
        const now = Math.floor(Date.now() / 1000);
        // a companion pulling what's new: only the store knows what changed when
        if (store && since > 0) {
          const h = store.packed(realm, { days, since });
          return send(res, 200, { realm, generated: now, full: false, cursor: h.cursor, items: h.items, names: h.names, classes: h.classes, updated: h.updated, lastScan: h.lastScan });
        }
        // ?item=ID: one item's history (the web app loads long chart ranges this way)
        const only = url.searchParams.get('item') ?? undefined;
        if (only !== undefined && !/^\d{1,10}$/.test(only)) return send(res, 400, { error: 'item must be an item ID' });
        const cacheKey = `${realm}|${days}`;
        const stamp = `${dataGen}|${store ? `${store.load(realm).seq}|${store.load(realm).updated}` : '-'}|${Math.floor(now / ANSWER_TTL)}`;
        if (!only) {
          const hit = answers.get(cacheKey);
          if (hit && hit.stamp === stamp) return sendCached(res, hit);
        }
        const pick = <T,>(all: Record<string, T> | undefined): Record<string, T> =>
          !all || only === undefined ? all || {} : only in all ? { [only]: all[only] } : {};
        const stored = store ? store.history(realm, { days, only }) : null;
        const remote = demo ? {} : { [realm]: stored ? stored.items : pick(readCachedRemote(realm) || {}) };
        const items = buildRealms({ [realm]: pick(local[realm]) }, remote, now, days)[realm] || {};
        if (!Object.keys(items).length && !local[realm]) return send(res, 404, { error: `No data for realm ${realm}` });
        const ladder = ladders?.[realm];
        const body = {
          realm, generated: now, full: !only, cursor: stored?.cursor ?? null, items, names: pick(mergeNames(stored?.names, names[realm])),
          ladders: pick(ladder?.items), ladderTime: ladder?.t || null, sales: pick(sales?.[realm]), updated: stored?.updated ?? null,
          classes: { ...stored?.classes, ...classes },
        };
        if (only) return send(res, 200, body);
        const answer: CachedAnswer = { stamp, text: JSON.stringify(body) };
        answers.set(cacheKey, answer);
        return sendCached(res, answer);
      }
      const lm = url.pathname.match(/^\/v1\/realms\/([^/]+)\/ledger$/);
      if (lm) {
        const realm = canonicalRealm(decodeURIComponent(lm[1]));
        const { ledgers, names, accounts } = load();
        if (privateLedger) {
          if (!auth) return send(res, 401, { error: "Login isn't set up on this server, so trades are hidden.", login: false });
          const user = auth.user(req);
          if (!user) return send(res, 401, { error: 'Log in with Battle.net to see your trades.', login: true });
          // your linked PCs' files, plus the shared-token files for the owner
          const admin = auth.isAdmin(user);
          const mine = accounts.filter((a) => a.owner === user.id || (admin && a.owner === null));
          const seen = new Set<string>();
          const records: string[] = [];
          for (const a of mine) {
            for (const rec of a.data.realms?.[realm]?.ledger || []) {
              if (!seen.has(rec)) { seen.add(rec); records.push(rec); } // the same trade from an old and a new push
            }
          }
          const time = (rec: string) => Number(rec.split(':')[1]) || 0;
          records.sort((x, y) => time(x) - time(y));
          return send(res, 200, { realm, records, names: names[realm] || {}, hosted: true, devices: auth.deviceCount(user.id), accounts: mine.length });
        }
        return send(res, 200, { realm, records: ledgers?.[realm] || [], names: names[realm] || {} });
      }
      if (url.pathname.startsWith('/v1/')) return send(res, 404, { error: 'Not found' });
      return serveStatic(req, res, webDist);
    } catch (err) {
      return send(res, 500, { error: errorMessage(err) });
    }
  });
}
