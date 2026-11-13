// Battle.net login against a fake Battle.net: login redirect, callback, session cookie,
// /v1/me, logout, and the private ledger on the hosted server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { listen, json, header } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-auth-'));
process.env.AHTC_CONFIG_DIR = path.join(tmp, 'config');
const { openDb, getRow, SCHEMA_VERSION } = await import('../src/db.ts');
const { Auth, safeReturn } = await import('../src/auth.ts');
const { createServer } = await import('../src/serve.ts');

// fake Battle.net: any code works; "code-<tag>" logs in as that BattleTag
let bnet: http.Server, bnetUrl: string;
const tokenCalls: { auth: string | undefined; body: URLSearchParams }[] = [];
// fake WoW folder with one pushed account that has a trade
const wow = path.join(tmp, 'wow');
const sv = path.join(wow, 'WTF', 'Account', 'WOW1', 'SavedVariables');
let server: http.Server, base: string, db: DatabaseSync;

before(async () => {
  bnet = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/token') {
        tokenCalls.push({ auth: req.headers.authorization, body: new URLSearchParams(body) });
        const code = new URLSearchParams(body).get('code');
        if (code === 'bad') { res.writeHead(400); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: `at-${code}` }));
      }
      if (req.url === '/userinfo') {
        const tag = String(req.headers.authorization).replace('Bearer at-code-', '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sub: `id-${tag}`, id: 1, battletag: tag.replace('_', '#') }));
      }
      res.writeHead(404); res.end();
    });
  });
  bnetUrl = await listen(bnet);

  fs.mkdirSync(sv, { recursive: true });
  fs.mkdirSync(path.join(wow, 'Interface'), { recursive: true });
  fs.writeFileSync(path.join(sv, 'AHTracker.lua'),
    'AHTrackerDB = { ["realms"] = { ["Testrealm-Horde"] = { ["lastScan"] = 1, ["items"] = {}, ["ledger"] = { "b:100:5:1:1000:0:0:Joros:" } } } }');

  db = openDb(':memory:');
  const auth = new Auth(db, {
    clientId: 'cid', clientSecret: 'secret', publicUrl: 'https://aht.example', admins: ['Owner#1234'], oauthBase: bnetUrl,
  });
  server = createServer({ wowPath: wow }, { auth, privateLedger: true, pushToken: null });
  base = await listen(server);
});
after(() => { server.close(); bnet.close(); });

const get = (p: string, cookie?: string) => fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const count = (sql: string, ...args: string[]) => getRow<{ n: number }>(db, sql, ...args).n;
const userVersion = (d: DatabaseSync) => getRow<{ user_version: number }>(d, 'PRAGMA user_version').user_version;

/** Runs a whole login as `tag` ("Name_1234") and returns the session cookie. */
async function login(tag: string, returnTo = '/#view=profit'): Promise<string> {
  const start = await get(`/auth/bnet/login?return=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302);
  const to = new URL(header(start, 'location'));
  assert.equal(to.origin + to.pathname, `${bnetUrl}/authorize`);
  assert.equal(to.searchParams.get('client_id'), 'cid');
  assert.equal(to.searchParams.get('scope'), 'openid');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://aht.example/auth/bnet/callback');
  const state = to.searchParams.get('state');
  const back = await get(`/auth/bnet/callback?code=code-${tag}&state=${state}`);
  assert.equal(back.status, 302, await back.clone().text());
  assert.equal(back.headers.get('location'), returnTo);
  const set = header(back, 'set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/);
  return set.split(';')[0];
}

/** The `state` of a fresh login redirect. */
const loginState = async () => new URL(header(await get('/auth/bnet/login'), 'location')).searchParams.get('state');

test('database schema is created and versioned', () => {
  assert.equal(userVersion(db), SCHEMA_VERSION);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(tables, ['device_links', 'devices', 'oauth_states', 'sessions', 'users']);
  // reopening a file doesn't rerun migrations
  const file = path.join(tmp, 'x.db');
  openDb(file).close();
  assert.equal(userVersion(openDb(file)), SCHEMA_VERSION);
});

test('log in, see yourself, log out', async () => {
  let me = await json(get('/v1/me'));
  assert.deepEqual(me, { user: null, login: true });

  const cookie = await login('Owner_1234');
  assert.equal(tokenCalls.at(-1)?.auth, `Basic ${Buffer.from('cid:secret').toString('base64')}`);
  assert.equal(tokenCalls.at(-1)?.body.get('grant_type'), 'authorization_code');

  me = await json(get('/v1/me', cookie));
  assert.equal(me.user.battletag, 'Owner#1234');
  assert.equal(me.user.admin, true);
  // the cookie value isn't stored, only its hash
  const value = cookie.split('=')[1];
  assert.equal(count('SELECT count(*) n FROM sessions WHERE token_hash = ?', value), 0);

  const out = await fetch(base + '/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 204);
  assert.match(header(out, 'set-cookie'), /Max-Age=0/);
  me = await json(get('/v1/me', cookie));
  assert.equal(me.user, null, 'session is gone');
});

test('logging in again keeps one user and updates the BattleTag', async () => {
  await login('Owner_1234');
  await login('Owner_1234');
  assert.equal(count("SELECT count(*) n FROM users WHERE bnet_id = 'id-Owner_1234'"), 1);
});

test('a login link works once and only with its state', async () => {
  const state = await loginState();
  assert.equal((await get(`/auth/bnet/callback?code=code-X_1&state=nope`)).status, 400);
  assert.equal((await get(`/auth/bnet/callback?code=code-X_1&state=${state}`)).status, 302);
  assert.equal((await get(`/auth/bnet/callback?code=code-X_1&state=${state}`)).status, 400, 'reused');
  const s2 = await loginState();
  assert.equal((await get(`/auth/bnet/callback?code=bad&state=${s2}`)).status, 502, 'Battle.net refused the code');
  assert.equal((await get('/auth/bnet/callback?error=access_denied')).status, 400);
});

test('return addresses stay on this site', () => {
  assert.equal(safeReturn('/#realm=x'), '/#realm=x');
  assert.equal(safeReturn('https://evil.example'), '/');
  assert.equal(safeReturn('//evil.example'), '/');
  assert.equal(safeReturn('/\\evil.example'), '/');
  assert.equal(safeReturn(undefined), '/');
});

const LEDGER = '/v1/realms/Testrealm-Horde/ledger';
const ledger = (cookie: string) => json(get(LEDGER, cookie));
const post = (p: string, body?: unknown, cookie?: string) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}),
});
const sv1 = (records: string[]) => `AHTrackerDB = { ["realms"] = { ["Testrealm-Horde"] = { ["lastScan"] = 1, ["items"] = {}, ["ledger"] = { ${records.map((r) => `"${r}"`).join(', ')} } } } }`;
const pushAs = (tokenValue: string, account: string, body: string) => fetch(`${base}/v1/accounts/${account}/savedvariables`, {
  method: 'PUT', headers: { Authorization: `Bearer ${tokenValue}` }, body,
});

/** Links a PC for the logged-in `cookie` and returns its device token. */
async function linkDevice(cookie: string, name = 'GAMING-PC'): Promise<string> {
  const start = await json(post('/v1/link/start', { name }));
  assert.match(start.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(start.url, `https://aht.example/#link=${start.code}`);
  assert.equal((await post('/v1/link/poll', { poll: start.poll })).status, 202, 'pending until approved');
  const info = await json(get(`/v1/link/${start.code}`, cookie));
  assert.equal(info.name, name);
  assert.equal((await post(`/v1/link/${start.code}/approve`, {}, cookie)).status, 200);
  const done = await post('/v1/link/poll', { poll: start.poll });
  assert.equal(done.status, 200);
  const { token: deviceToken } = await json(done);
  assert.equal((await post('/v1/link/poll', { poll: start.poll })).status, 410, 'the token is handed over once');
  return deviceToken;
}

test('logged out, trades are hidden', async () => {
  const anon = await get(LEDGER);
  assert.equal(anon.status, 401);
  assert.equal((await json(anon)).login, true);
});

test('each user sees the trades their linked PCs pushed', async () => {
  const alice = await login('Alice_1');
  const bob = await login('Bob_2');
  // nothing linked yet: empty, not someone else's
  let a = await ledger(alice);
  assert.deepEqual([a.records.length, a.devices], [0, 0]);

  const aliceToken = await linkDevice(alice);
  const bobToken = await linkDevice(bob, 'BOB-LAPTOP');
  // both use the account folder name WOW1; they don't clash
  assert.equal((await pushAs(aliceToken, 'WOW1', sv1(['b:200:5:1:500:0:0:Alice:']))).status, 200);
  assert.equal((await pushAs(bobToken, 'WOW1', sv1(['s:300:6:2:900:45:0:Bob:']))).status, 200);
  assert.equal((await pushAs('x'.repeat(43), 'WOW1', sv1([]))).status, 401, 'unknown token');

  a = await ledger(alice);
  assert.deepEqual(a.records, ['b:200:5:1:500:0:0:Alice:']);
  assert.equal(a.devices, 1);
  const b = await ledger(bob);
  assert.deepEqual(b.records, ['s:300:6:2:900:45:0:Bob:']);

  // the owner sees the shared-token file, and their own linked pushes, each trade once
  const owner = await login('Owner_1234');
  assert.deepEqual((await ledger(owner)).records, ['b:100:5:1:1000:0:0:Joros:']);
  const ownerToken = await linkDevice(owner);
  await pushAs(ownerToken, 'WOW1', sv1(['b:100:5:1:1000:0:0:Joros:', 'b:400:7:1:10:0:0:Joros:']));
  assert.deepEqual((await ledger(owner)).records, ['b:100:5:1:1000:0:0:Joros:', 'b:400:7:1:10:0:0:Joros:']);
});

test('linking needs a login, and a code works for one person', async () => {
  const start = await json(post('/v1/link/start', { name: 'X' }));
  assert.equal((await post(`/v1/link/${start.code}/approve`)).status, 401);
  const carol = await login('Carol_3');
  const dave = await login('Dave_4');
  await post(`/v1/link/${start.code}/approve`, {}, carol);
  assert.equal((await post(`/v1/link/${start.code}/approve`, {}, dave)).status, 409);
  assert.equal((await get('/v1/link/NOPE-NOPE', carol)).status, 404);
  assert.equal((await post('/v1/link/poll', { poll: 'wrong' })).status, 410);
});

test('your PCs can be listed and unlinked', async () => {
  const erin = await login('Erin_5');
  const t = await linkDevice(erin, 'ERIN-PC');
  const list = await json(get('/v1/me/devices', erin));
  assert.deepEqual(list.devices.map((d: { name: string }) => d.name), ['ERIN-PC']);
  const other = await login('Frank_6');
  assert.equal((await fetch(`${base}/v1/me/devices/${list.devices[0].id}`, { method: 'DELETE', headers: { cookie: other } })).status, 404, "not someone else's");
  assert.equal((await fetch(`${base}/v1/me/devices/${list.devices[0].id}`, { method: 'DELETE', headers: { cookie: erin } })).status, 200);
  assert.equal((await pushAs(t, 'WOW1', sv1([]))).status, 401, 'an unlinked PC can no longer push');
});

test('without login set up, the hosted ledger stays hidden and /v1/me says so', async () => {
  const plain = createServer({ wowPath: wow }, { privateLedger: true, pushToken: null });
  const b = await listen(plain);
  const led = await fetch(`${b}/v1/realms/Testrealm-Horde/ledger`);
  const me = await json(fetch(`${b}/v1/me`));
  const local = createServer({ wowPath: wow }, { pushToken: null }); // your own PC: no login needed
  const mine = await fetch(`${await listen(local)}/v1/realms/Testrealm-Horde/ledger`);
  plain.close(); local.close();
  assert.equal(led.status, 401);
  assert.deepEqual(me, { user: null, login: false });
  assert.equal(mine.status, 200);
});

test('the companion links itself and then uploads as you', async () => {
  const { linkPC } = await import('../src/link.ts');
  const { uploadKey } = await import('../src/sync.ts');
  const gina = await login('Gina_7');
  const config = { serverUrl: null, pushUrl: null, pushToken: null, apiKey: 'k'.repeat(36), pushed: { WOW1: 'old' } };
  const r = await linkPC(config, base, {
    name: 'GINA-PC',
    sleep: () => new Promise((res) => setTimeout(res, 5)),
    onCode: async ({ code }) => { await post(`/v1/link/${code}/approve`, {}, gina); },
  });
  assert.equal(r.battletag, 'Gina#7');
  assert.equal(config.pushUrl, base);
  assert.equal(config.serverUrl, base);
  assert.deepEqual(config.pushed, {}, 'pushes everything again under the new owner');
  assert.equal(uploadKey(config), config.pushToken, 'uploads to the linked server use the device token');
  assert.equal(uploadKey({ ...config, serverUrl: 'https://other.example' }), config.apiKey, 'other servers get the plain key');
  const devices = await json(get('/v1/me/devices', gina));
  assert.deepEqual(devices.devices.map((d: { name: string }) => d.name), ['GINA-PC']);
});
