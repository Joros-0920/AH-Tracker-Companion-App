// Battle.net login and sessions for the hosted server.
//
//   GET  /auth/bnet/login?return=/path   -> redirect to Battle.net
//   GET  /auth/bnet/callback             -> Battle.net sends the user back here; we make a session
//   POST /auth/logout                    -> ends the session
//   GET  /v1/me                          -> { user: { id, battletag, admin } | null, login: true }
//
// Linking a PC (like signing in on a TV): the companion starts a link and polls; the person
// opens the link while logged in and approves it; the companion then gets its own device token.
//   POST /v1/link/start { name }         -> { code, poll, url, interval, expiresIn }
//   POST /v1/link/poll { poll }          -> 202 { status: "pending" } | 200 { token, battletag } | 410
//   GET  /v1/link/:code                  -> { name, expires } (logged in)
//   POST /v1/link/:code/approve          -> { ok } (logged in)
//   GET  /v1/me/devices                  -> { devices: [{ id, name, created, lastSeen }] }
//   DELETE /v1/me/devices/:id            -> { ok }
//
// Uses the OAuth authorization-code flow with the "openid" scope, which gives the account
// id and BattleTag and nothing else. Sessions are a random token in an HttpOnly cookie; the
// database keeps only its sha256. Sessions last 30 days and renew while in use.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { HttpError, statusOf, errorMessage } from './errors.ts';

export const COOKIE = 'aht_session';
const SESSION_DAYS = 30;
const DAY = 86400;
const STATE_TTL = 10 * 60;
const LINK_TTL = 10 * 60;
const POLL_INTERVAL = 3;
// no 0/O, 1/I/L: easy to read out and type
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface User { id: number; battletag: string }

// rows as the queries below return them
interface SessionRow { user_id: number; expires: number; last_seen: number; battletag: string }
interface StateRow { created: number; return_to: string }
interface LinkRow { code: string; name: string; expires: number; user_id: number | null }
interface DeviceRow { id: number; user_id: number; last_seen: number | null; battletag: string }
interface DeviceListRow { id: number; name: string; created: number; last_seen: number | null }

function linkCode(): string {
  const bytes = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

async function readJsonBody(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Only same-site paths, so the login can't be used to bounce people to another site. */
export function safeReturn(value: string | null | undefined): string {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && v.length < 500 ? v : '/';
}

export interface AuthOptions {
  /** Battle.net OAuth client (develop.battle.net) */
  clientId: string;
  clientSecret: string;
  /** where this server is reached, e.g. https://forever-auctions.fly.dev */
  publicUrl: string;
  /** BattleTags that may see the server owner's data (case-insensitive) */
  admins?: string[];
  /** Battle.net OAuth host (tests point this at a fake) */
  oauthBase?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Prepared statements, run with typed results. */
class Query<Row> {
  stmt: StatementSync;
  constructor(stmt: StatementSync) { this.stmt = stmt; }
  get(...args: (string | number | null)[]): Row | undefined { return this.stmt.get(...args) as Row | undefined; }
  all(...args: (string | number | null)[]): Row[] { return this.stmt.all(...args) as Row[]; }
  run(...args: (string | number | null)[]) { return this.stmt.run(...args); }
}

function queries(db: DatabaseSync) {
  const q = <Row = never>(sql: string) => new Query<Row>(db.prepare(sql));
  return {
    addState: q('INSERT INTO oauth_states (state, created, return_to) VALUES (?, ?, ?)'),
    takeState: q<StateRow>('DELETE FROM oauth_states WHERE state = ? RETURNING created, return_to'),
    oldStates: q('DELETE FROM oauth_states WHERE created < ?'),
    upsertUser: q<User>(`INSERT INTO users (bnet_id, battletag, created, last_login) VALUES (?, ?, ?, ?)
      ON CONFLICT(bnet_id) DO UPDATE SET battletag = excluded.battletag, last_login = excluded.last_login
      RETURNING id, battletag`),
    addSession: q('INSERT INTO sessions (token_hash, user_id, created, expires, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
    session: q<SessionRow>(`SELECT s.user_id, s.expires, s.last_seen, u.battletag FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    touch: q('UPDATE sessions SET last_seen = ?, expires = ? WHERE token_hash = ?'),
    endSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    oldSessions: q('DELETE FROM sessions WHERE expires < ?'),
    addLink: q('INSERT INTO device_links (code, poll_hash, name, created, expires) VALUES (?, ?, ?, ?, ?)'),
    oldLinks: q('DELETE FROM device_links WHERE expires < ?'),
    link: q<LinkRow>('SELECT code, name, expires, user_id FROM device_links WHERE code = ?'),
    linkByPoll: q<LinkRow>('SELECT code, name, expires, user_id FROM device_links WHERE poll_hash = ?'),
    approveLink: q('UPDATE device_links SET user_id = ? WHERE code = ? AND user_id IS NULL AND expires >= ?'),
    dropLink: q('DELETE FROM device_links WHERE code = ?'),
    addDevice: q('INSERT INTO devices (user_id, token_hash, name, created, last_seen) VALUES (?, ?, ?, ?, NULL)'),
    device: q<DeviceRow>(`SELECT d.id, d.user_id, d.last_seen, u.battletag FROM devices d
      JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`),
    touchDevice: q('UPDATE devices SET last_seen = ? WHERE id = ?'),
    devices: q<DeviceListRow>('SELECT id, name, created, last_seen FROM devices WHERE user_id = ? ORDER BY created'),
    dropDevice: q('DELETE FROM devices WHERE id = ? AND user_id = ?'),
    battletag: q<{ battletag: string }>('SELECT battletag FROM users WHERE id = ?'),
  };
}

export class Auth {
  db: DatabaseSync;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  redirectUri: string;
  secure: boolean;
  admins: Set<string>;
  oauthBase: string;
  now: () => number;
  fetch: typeof fetch;
  q: ReturnType<typeof queries>;

  /** db: from openDb() */
  constructor(db: DatabaseSync, { clientId, clientSecret, publicUrl, admins = [], oauthBase = 'https://oauth.battle.net', now, fetch: fetchFn }: AuthOptions) {
    if (!clientId || !clientSecret) throw new Error('Battle.net login needs BNET_CLIENT_ID and BNET_CLIENT_SECRET');
    if (!publicUrl) throw new Error('Battle.net login needs the public URL (AHTC_PUBLIC_URL)');
    this.db = db;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.redirectUri = `${this.publicUrl}/auth/bnet/callback`;
    this.secure = this.publicUrl.startsWith('https://');
    this.admins = new Set(admins.map((a) => a.trim().toLowerCase()).filter(Boolean));
    this.oauthBase = oauthBase.replace(/\/+$/, '');
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this.fetch = fetchFn || fetch;
    this.q = queries(db);
  }

  isAdmin(user: User | null | undefined): boolean {
    return !!user && this.admins.has(user.battletag.toLowerCase());
  }

  /** The logged-in user for a request ({ id, battletag }), or null. Renews the session once a day. */
  user(req: IncomingMessage): User | null {
    const value = cookies(req)[COOKIE];
    if (!value) return null;
    const hash = sha256(value);
    const row = this.q.session.get(hash);
    const now = this.now();
    if (!row || row.expires < now) return null;
    if (now - row.last_seen > DAY) this.q.touch.run(now, now + SESSION_DAYS * DAY, hash);
    return { id: row.user_id, battletag: row.battletag };
  }

  /**
   * The user a linked PC belongs to, from its device token ("Bearer <token>" or the token itself),
   * or null. Notes when the PC was last seen, at most once a minute.
   */
  deviceUser(bearer: string | null | undefined): (User & { deviceId: number }) | null {
    const value = String(bearer || '').replace(/^Bearer\s+/i, '');
    if (value.length < 20) return null;
    const row = this.q.device.get(sha256(value));
    if (!row) return null;
    const now = this.now();
    if (!row.last_seen || now - row.last_seen > 60) this.q.touchDevice.run(now, row.id);
    return { id: row.user_id, battletag: row.battletag, deviceId: row.id };
  }

  /** Battle.net-logged-in user, or answers 401 and returns null. */
  needUser(req: IncomingMessage, res: ServerResponse): User | null {
    const user = this.user(req);
    if (!user) json(res, 401, { error: 'Log in with Battle.net first.', login: true });
    return user;
  }

  /** The /v1/link and /v1/me/devices routes. Returns false for anything else. */
  async handleLinks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const now = this.now();
    if (p === '/v1/link/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      // oxlint-disable-next-line no-control-regex -- strip control characters from the PC name
      const name = String(body.name || 'PC').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60) || 'PC';
      this.q.oldLinks.run(now);
      const poll = token();
      let code: string | null = null;
      for (let i = 0; i < 5; i++) {
        code = linkCode();
        try { this.q.addLink.run(code, sha256(poll), name, now, now + LINK_TTL); break; } catch { code = null; }
      }
      if (!code) return json(res, 503, { error: 'Try again' });
      return json(res, 200, {
        code, poll, url: `${this.publicUrl}/#link=${code}`, interval: POLL_INTERVAL, expiresIn: LINK_TTL,
      });
    }
    if (p === '/v1/link/poll' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const link = body.poll ? this.q.linkByPoll.get(sha256(String(body.poll))) : null;
      if (!link || link.expires < now) {
        if (link) this.q.dropLink.run(link.code);
        return json(res, 410, { error: 'This link has expired. Start again.' });
      }
      if (!link.user_id) return json(res, 202, { status: 'pending' });
      // approved: make the device and hand its token over, once
      const deviceToken = token();
      this.q.addDevice.run(link.user_id, sha256(deviceToken), link.name, now);
      this.q.dropLink.run(link.code);
      return json(res, 200, { token: deviceToken, battletag: this.q.battletag.get(link.user_id)?.battletag ?? null });
    }
    const lm = p.match(/^\/v1\/link\/([A-Z0-9-]{4,12})(\/approve)?$/);
    if (lm) {
      const user = this.needUser(req, res);
      if (!user) return true;
      const link = this.q.link.get(lm[1]);
      if (!link || link.expires < now) return json(res, 404, { error: 'That link code has expired or was never made. Start again on the PC.' });
      if (link.user_id && link.user_id !== user.id) return json(res, 409, { error: 'Someone else already approved this link.' });
      if (!lm[2] && req.method === 'GET') return json(res, 200, { code: link.code, name: link.name, expires: link.expires, approved: !!link.user_id });
      if (lm[2] && req.method === 'POST') {
        this.q.approveLink.run(user.id, link.code, now);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (p === '/v1/me/devices' && req.method === 'GET') {
      const user = this.needUser(req, res);
      if (!user) return true;
      const devices = this.q.devices.all(user.id).map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.last_seen }));
      return json(res, 200, { devices });
    }
    const dm = p.match(/^\/v1\/me\/devices\/(\d+)$/);
    if (dm && req.method === 'DELETE') {
      const user = this.needUser(req, res);
      if (!user) return true;
      const r = this.q.dropDevice.run(Number(dm[1]), user.id);
      return json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'No such PC' });
    }
    return false;
  }

  /** Number of PCs a user has linked. */
  deviceCount(userId: number): number {
    return this.q.devices.all(userId).length;
  }

  cookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }

  /** Handles the /auth routes and /v1/me. Returns false for anything else. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname.startsWith('/v1/link/') || url.pathname.startsWith('/v1/me/')) {
      if (await this.handleLinks(req, res, url)) return true;
    }
    if (url.pathname === '/v1/me' && req.method === 'GET') {
      const user = this.user(req);
      json(res, 200, { user: user ? { ...user, admin: this.isAdmin(user) } : null, login: true });
      return true;
    }
    if (url.pathname === '/auth/bnet/login' && req.method === 'GET') {
      const now = this.now();
      this.q.oldStates.run(now - STATE_TTL);
      const state = token();
      this.q.addState.run(state, now, safeReturn(url.searchParams.get('return')));
      const to = new URL(`${this.oauthBase}/authorize`);
      to.search = new URLSearchParams({
        client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: 'openid', state,
      }).toString();
      redirect(res, to.toString());
      return true;
    }
    if (url.pathname === '/auth/bnet/callback' && req.method === 'GET') {
      try {
        const back = await this.callback(req, url);
        redirect(res, back.to, back.cookie);
      } catch (err) {
        page(res, err instanceof HttpError ? statusOf(err) : 400, 'Login failed', errorMessage(err));
      }
      return true;
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const value = cookies(req)[COOKIE];
      if (value) this.q.endSession.run(sha256(value));
      res.writeHead(204, { 'Set-Cookie': this.cookie('', 0), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    return false;
  }

  async callback(req: IncomingMessage, url: URL): Promise<{ to: string; cookie: string }> {
    if (url.searchParams.get('error')) {
      throw new HttpError(400, `Battle.net said: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw new Error('The login link is missing its code. Start again from the site.');
    const now = this.now();
    const st = this.q.takeState.get(state);
    if (!st || now - st.created > STATE_TTL) throw new Error('That login link has expired or was already used. Start again from the site.');

    const tok = await this.fetch(`${this.oauthBase}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tok.ok) throw new HttpError(502, `Battle.net didn't accept the login (${tok.status}).`);
    const { access_token: access } = (await tok.json()) as { access_token?: string };
    if (!access) throw new HttpError(502, 'Battle.net sent no access token.');

    const info = await this.fetch(`${this.oauthBase}/userinfo`, {
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!info.ok) throw new HttpError(502, `Couldn't read your Battle.net account (${info.status}).`);
    const me = (await info.json()) as { sub?: string | number; id?: string | number; battletag?: string };
    const bnetId = me.sub ?? me.id;
    if (bnetId === undefined || !me.battletag) throw new HttpError(502, 'Battle.net sent no account id or BattleTag.');

    const user = this.q.upsertUser.get(String(bnetId), String(me.battletag), now, now);
    if (!user) throw new Error("Couldn't save your login.");
    this.q.oldSessions.run(now);
    const value = token();
    this.q.addSession.run(sha256(value), user.id, now, now + SESSION_DAYS * DAY, now,
      String(req.headers['user-agent'] || '').slice(0, 200));
    return { to: st.return_to, cookie: this.cookie(value, SESSION_DAYS * DAY) };
  }
}

/** Sends a JSON answer. Returns true, so route handlers can `return json(...)`. */
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function redirect(res: ServerResponse, to: string, cookie?: string): void {
  const headers: Record<string, string> = { Location: to, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}

const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><body style="font:15px system-ui;padding:2em;color-scheme:light dark">
<h2>${escape(title)}</h2><p>${escape(message)}</p><p><a href="/">Back to AH Tracker</a></p>`);
}
