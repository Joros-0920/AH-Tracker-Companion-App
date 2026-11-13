// Price server: the store (medians, timestamps, compaction), the upload and pull
// endpoints, and a companion pulling only what changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { listen, json } from './helpers.ts';
import type { PriceStore as Store } from '../src/priceStore.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-price-'));
process.env.AHTC_CONFIG_DIR = path.join(tmp, 'config');
const { PriceStore, reporterId } = await import('../src/priceStore.ts');
const { createServer } = await import('../src/serve.ts');
const { ApiClient } = await import('../src/api.ts');
const { pullRealm } = await import('../src/sync.ts');
const { decode, DAY, HOUR } = await import('../src/history.ts');

const NOW = 1762400000;
const REALM = 'Testrealm-Horde';
let clock = NOW;
const store = (name: string) => new PriceStore(path.join(tmp, name), { now: () => clock });

test('a bucket takes the median of its uploaders and the newest scan time', () => {
  clock = NOW;
  const s = store('median');
  const t = NOW - 2 * HOUR + 60;
  s.ingest(REALM, 'a', [{ t, items: [[5, 90, 100, 10]] }]);
  s.ingest(REALM, 'b', [{ t: t + 600, items: [[5, 95, 110, 20]] }]);
  s.ingest(REALM, 'c', [{ t: t + 300, items: [[5, 10, 9999, 30]] }]); // way off, outvoted
  const [p] = s.history(REALM).items[5];
  assert.deepEqual(p, [t + 600, 90, 110, 20]);
});

test('a later scan from the same uploader in the same hour replaces its earlier one', () => {
  const s = store('replace');
  const t = NOW - 3 * HOUR;
  s.ingest(REALM, 'a', [{ t, items: [[5, 100, 100, 1]] }]);
  s.ingest(REALM, 'a', [{ t: t + 900, items: [[5, 200, 200, 2]] }]);
  s.ingest(REALM, 'a', [{ t: t + 60, items: [[5, 1, 1, 1]] }]); // older than what's there: ignored
  assert.deepEqual(s.history(REALM).items[5], [[t + 900, 200, 200, 2]]);
});

test('bad and out-of-range points are skipped', () => {
  const s = store('bad');
  const r = s.ingest(REALM, 'a', [
    { t: NOW - 20 * DAY, items: [[5, 1, 1, 1]] },      // too old
    { t: NOW + DAY, items: [[5, 1, 1, 1]] },           // future
    { t: NOW - HOUR, items: [[0, 1, 1, 1], [6, -1, 5, 1], [7, 1, 0, 1], 'x', [8, 50, 60, 3]] },
  ]);
  assert.equal(r.points, 1);
  assert.deepEqual(Object.keys(s.history(REALM).items), ['8']);
  assert.throws(() => s.ingest('bad/realm', 'a', []), /realm/);
});

test('since a cursor returns only items changed after it, and repeats are not changes', () => {
  clock = NOW;
  const s = store('since');
  s.ingest(REALM, 'a', [{ t: NOW - HOUR, items: [[5, 100, 100, 1], [6, 50, 50, 1]] }]);
  const first = s.history(REALM).cursor;
  assert.equal(Object.keys(s.history(REALM, { since: first - 1 }).items).length, 2);
  clock += 60;
  s.ingest(REALM, 'a', [{ t: NOW - HOUR, items: [[5, 100, 100, 1], [6, 50, 50, 1]] }]); // same again
  assert.deepEqual(Object.keys(s.history(REALM, { since: first }).items), []);
  s.ingest(REALM, 'b', [{ t: NOW - 60, items: [[6, 40, 45, 2]] }]);
  assert.deepEqual(Object.keys(s.history(REALM, { since: first }).items), ['6']);
  assert.equal(s.history(REALM).updated, clock);
});

test('old hours merge into days, very old points are dropped, and it survives a reload', () => {
  clock = NOW;
  const s = store('compact');
  const day = Math.floor((NOW - 13 * DAY) / DAY) * DAY;
  s.ingest(REALM, 'a', [
    { t: day + 2 * HOUR, items: [[5, 100, 100, 10]] },
    { t: day + 8 * HOUR, items: [[5, 80, 120, 20]] },
  ]);
  clock = NOW + 3 * DAY; // those hours are now past 14 days
  s.ingest(REALM, 'a', [{ t: clock - HOUR, items: [[5, 90, 90, 5]] }]);
  const pts = new PriceStore(path.join(tmp, 'compact'), { now: () => clock }).history(REALM, { days: 30 }).items[5];
  assert.deepEqual(pts[0], [day + 8 * HOUR, 80, 110, 15]);
  assert.equal(pts.length, 2);
  clock = NOW + 200 * DAY;
  s.ingest(REALM, 'a', [{ t: clock - HOUR, items: [[9, 1, 1, 1]] }]);
  assert.equal(s.history(REALM, { days: 365 }).items[5], undefined, 'dropped after 180 days');
});

// HTTP -------------------------------------------------------------------------

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);
let server: Server, base: string, priceStore: Store;
const now = () => Math.floor(Date.now() / 1000);

before(async () => {
  priceStore = new PriceStore(path.join(tmp, 'http'));
  const wow = path.join(tmp, 'wow');
  fs.mkdirSync(path.join(wow, 'WTF', 'Account'), { recursive: true });
  fs.mkdirSync(path.join(wow, 'Interface'), { recursive: true });
  server = createServer({ wowPath: wow }, { store: priceStore, pushToken: null });
  base = await listen(server);
});
after(() => server.close());

test('uploads need an API key and a realm', async () => {
  const api = new ApiClient(base, 'short');
  await assert.rejects(api.uploadScans(REALM, []), /401/);
  await assert.rejects(new ApiClient(base, KEY_A).uploadScans('', []), /400/);
});

test('upload, then pull everything, then pull only what changed', async () => {
  const a = new ApiClient(base, KEY_A);
  const t = now() - HOUR;
  const r = await a.uploadScans(REALM, [{ t, items: [[5, 100, 110, 3], [6, 50, 55, 1]] }], { 5: { n: 'Linen Cloth', q: 1 } });
  assert.equal(r?.points, 2);

  const first = await pullRealm(a, REALM, 30);
  assert.equal(first.full, true);
  assert.deepEqual(Object.keys(first.items).sort(), ['5', '6']);
  assert.deepEqual(decode(first.items[5]), [[t, 100, 110, 3]]);

  // another player's newer scan of one item
  await new ApiClient(base, KEY_B).uploadScans(REALM, [{ t: now() - 60, items: [[6, 40, 45, 2]] }]);
  const second = await pullRealm(a, REALM, 30);
  assert.equal(second.full, false);
  assert.equal(second.changed, 1, 'only item 6 came down');
  assert.deepEqual(Object.keys(second.items).sort(), ['5', '6'], 'merged into the cache');
  assert.equal(decode(second.items[6]).length, 2, 'both scans of item 6');

  const third = await pullRealm(a, REALM, 30);
  assert.equal(third.changed, 0, 'nothing new');

  const realms = await json(fetch(`${base}/v1/realms`));
  assert.ok(realms.realms.some((x: { realm: string; updated: number | null }) => x.realm === REALM && x.updated), 'realm listed with its update time');
  const full = await json(fetch(`${base}/v1/realms/${REALM}/prices`));
  assert.equal(full.names[5].n, 'Linen Cloth', 'names from uploads');
});

test('realms with no prices, scans or trades are left out of the list', async () => {
  const wow = path.join(tmp, 'wow-empty');
  const sv = path.join(wow, 'WTF', 'Account', 'WOW1', 'SavedVariables');
  fs.mkdirSync(sv, { recursive: true });
  fs.mkdirSync(path.join(wow, 'Interface'), { recursive: true });
  fs.writeFileSync(path.join(sv, 'AHTracker.lua'), 'AHTrackerDB = { ["realms"] = {'
    + ' ["Empty-Horde"] = { ["items"] = {}, ["ledger"] = {} },'
    + ' ["Trades-Horde"] = { ["items"] = {}, ["ledger"] = { "b:100:5:1:1000:0:0:Joros:" } } } }');
  const srv = createServer({ wowPath: wow }, { pushToken: null });
  const srvBase = await listen(srv);
  try {
    const { realms } = await json(fetch(`${srvBase}/v1/realms`));
    assert.deepEqual(realms.map((r: { realm: string }) => r.realm), ['Trades-Horde']);
  } finally {
    srv.close();
  }
});

test('servers without a store refuse scans', async () => {
  const plain = createServer({ wowPath: path.join(tmp, 'wow') }, { pushToken: null });
  const res = await fetch(`${await listen(plain)}/v1/scans`, { method: 'POST', body: '{}' });
  plain.close();
  assert.equal(res.status, 404);
});

test('reporter ids hide the key', () => {
  assert.equal(reporterId(KEY_A).length, 16);
  assert.notEqual(reporterId(KEY_A), reporterId(KEY_B));
  assert.ok(!reporterId(KEY_A).includes('aaaa'));
});
