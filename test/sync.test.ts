// End-to-end: fake WoW folder + fake price server -> sync -> AppData.lua,
// then load that file into the real addon code with Lua 5.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { listen } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-'));
process.env.AHTC_CONFIG_DIR = path.join(tmp, 'config');
const { sync } = await import('../src/sync.ts');
const { loadConfig } = await import('../src/config.ts');

const NOW = 1762400000;
const REALM = 'Testrealm-Horde';
const wow = path.join(tmp, 'wow');
const addon = path.join(wow, 'Interface', 'AddOns', 'AHTracker');

function savedVariables(items: Record<string, string>, lastScan: number): string {
  const entries = Object.entries(items).map(([id, h]) => `[${id}] = {\n["n"] = "Item ${id}",\n["h"] = "${h}",\n},`).join('\n');
  return `AHTrackerDB = {\n["settings"] = {},\n["realms"] = {\n["${REALM}"] = {\n["lastScan"] = ${lastScan},\n["items"] = {\n${entries}\n},\n},\n},\n}\n`;
}

function writeAccount(name: string, content: string): void {
  const dir = path.join(wow, 'WTF', 'Account', name, 'SavedVariables');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AHTracker.lua'), content);
}

// fake server
const received: { realm: string }[] = [];
let server: http.Server, baseUrl: string;
before(async () => {
  fs.mkdirSync(addon, { recursive: true });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      assert.match(String(req.headers.authorization), /^Bearer .+/);
      if (req.method === 'POST' && req.url === '/v1/scans') {
        received.push(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString()));
        res.writeHead(204).end();
      } else if (req.method === 'GET' && req.url?.startsWith(`/v1/realms/${encodeURIComponent(REALM)}/prices`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ realm: REALM, generated: NOW, items: { 999: `${NOW - 7200}:500:600:10` } }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  baseUrl = await listen(server);
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('local-only sync merges accounts into AppData.lua', async () => {
  writeAccount('ACCOUNT1', savedVariables({ 2589: `${NOW - 3600}:100:110:50` }, NOW - 3600));
  writeAccount('ACCOUNT2', savedVariables({ 2589: `${NOW - 86400}:90:95:40`, 2592: `${NOW - 86400}:1000:1200:3` }, NOW - 86400));
  const config = { ...loadConfig(), wowPath: wow };
  const s = await sync(config, { now: NOW });
  assert.equal(s.realms, 1);
  assert.equal(s.items, 2);
  assert.equal(s.wrote, true);
  const src = fs.readFileSync(path.join(addon, 'AppData.lua'), 'utf8');
  assert.match(src, /R\[2589\]="1762313600:90:95:40,1762396400:100:110:50"/);

  // second sync with nothing new doesn't rewrite the file
  assert.equal((await sync(config, { now: NOW + 60 })).wrote, false);
});

test('server sync uploads new scans once and merges server prices', async () => {
  const config = { ...loadConfig(), wowPath: wow, serverUrl: baseUrl, cursors: {} };
  const s = await sync(config, { now: NOW });
  assert.equal(s.errors.length, 0, s.errors.join('; '));
  assert.equal(s.uploadedScans, 2); // one scan per account
  assert.equal(s.downloadedRealms, 1);
  assert.equal(received.length, 2);
  assert.equal(received[0].realm, REALM);
  assert.ok(!JSON.stringify(received).includes('ACCOUNT'), 'account names are not uploaded');
  assert.match(fs.readFileSync(path.join(addon, 'AppData.lua'), 'utf8'), /R\[999\]=/);

  // nothing new to upload the second time
  const again = await sync(config, { now: NOW + 60 });
  assert.equal(again.uploadedScans, 0);
  assert.equal(received.length, 2);
});

test('server errors are reported but local data is still written', async () => {
  const config = { ...loadConfig(), wowPath: wow, serverUrl: 'http://127.0.0.1:1', cursors: {} };
  const s = await sync(config, { now: NOW });
  assert.ok(s.errors.length >= 1);
  assert.match(s.errors[s.errors.length - 1], /using the last download/);
  assert.equal(s.items, 3, 'server item from the earlier download is kept');
});

const hasLua = (() => { try { execFileSync('lua5.1', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// the addon lives next to this folder in the main AH Tracker project; a plain clone of the
// companion repo doesn't have it, so the test is skipped there
const repoAddon = path.resolve(import.meta.dirname, '..', '..', 'AHTracker');
const hasAddon = fs.existsSync(path.join(repoAddon, 'Store.lua'));
test('the addon loads the generated AppData.lua', { skip: !hasLua ? 'needs lua5.1' : !hasAddon ? 'needs ../AHTracker' : false }, () => {
  const script = `
    local ns = {}
    assert(loadfile("${repoAddon}/Core.lua"))("AHTracker", ns)
    assert(loadfile("${repoAddon}/Store.lua"))("AHTracker", ns)
    assert(loadfile("${path.join(addon, 'AppData.lua')}"))()
    local S = ns.Store
    S.Init({ settings = { rawDays = 14, keepDays = 180 }, realms = {} }, "${REALM}")
    S.ImportAppData(AHTracker_AppData)
    io.write(#S.ItemIDs(), " ", #S.History(2589), " ", S.History(2589)[2][3])
  `;
  assert.equal(execFileSync('lua5.1', ['-e', script]).toString(), '3 2 110');
});

test('large AppData.lua stays loadable (constant limits)', { skip: !hasLua }, async () => {
  const { buildAppData } = await import('../src/appData.ts');
  const items: Record<string, string> = {};
  for (let i = 1; i <= 60000; i++) items[i] = `${NOW}:${i}:${i}:1`;
  const file = path.join(tmp, 'big.lua');
  fs.writeFileSync(file, buildAppData({ [REALM]: items, 'Other-Alliance': { 1: `${NOW}:1:1:1` } }, NOW));
  const n = execFileSync('lua5.1', ['-e', `dofile("${file}") local n=0 for _ in pairs(AHTracker_AppData.realms["${REALM}"]) do n=n+1 end io.write(n)`]);
  assert.equal(n.toString(), '60000');
});
