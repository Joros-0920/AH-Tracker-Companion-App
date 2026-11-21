// Fake uploads: anonymous keys can't outvote linked users, outliers are dropped, bans stick.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { listen, json } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-trust-'));
process.env.AHTC_CONFIG_DIR = path.join(tmp, 'config');
const { PriceStore, anonReporter, writeBans, readBans } = await import('../src/priceStore.ts');
const { createServer, ANON_SCANS_PER_IP } = await import('../src/serve.ts');
const { banTarget, banCommand } = await import('../src/moderation.ts');
const { HOUR } = await import('../src/history.ts');

const NOW = 1762400000;
const REALM = 'Testrealm-Horde';
const T = NOW - 2 * HOUR + 60;
let n = 0;
const store = (anon: 'fallback' | 'off' = 'fallback') => new PriceStore(path.join(tmp, `s${n++}`), { now: () => NOW, anon });
const scan = (min: number, mkt: number, t = T) => [{ t, items: [[5, min, mkt, 10]] }];
const point = (s: InstanceType<typeof PriceStore>) => s.history(REALM).items[5]?.at(-1);

test('fifty anonymous keys cannot outvote one linked user', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110));
  for (let i = 0; i < 50; i++) s.ingest(REALM, anonReporter(`fake-key-${i}-xxxxxxxx`), scan(10, 20, T + i));
  assert.deepEqual(point(s)?.slice(1, 3), [100, 110]);
});

test('anonymous reports fill buckets no linked user has, unless turned off', () => {
  const s = store();
  s.ingest(REALM, anonReporter('only-anon-key-xxxxxxxx'), scan(100, 110));
  assert.deepEqual(point(s)?.slice(1, 3), [100, 110]);

  const off = store('off');
  assert.throws(() => off.ingest(REALM, anonReporter('only-anon-key-xxxxxxxx'), scan(100, 110)), /linked to a Battle.net login/);
  off.ingest(REALM, 'user-1', scan(100, 110));
  assert.deepEqual(point(off)?.slice(1, 3), [100, 110]);
});

test('one user far off the others is dropped; a crash two users see is kept', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110));
  s.ingest(REALM, 'user-2', scan(102, 112));
  s.ingest(REALM, 'user-3', scan(5, 6, T + 60)); // a fake dump to trigger Buy signals
  assert.deepEqual(point(s)?.slice(1, 3), [101, 111]);

  // the next hour the market really crashes, and two users see it
  const t2 = T + HOUR;
  s.ingest(REALM, 'user-1', scan(20, 25, t2));
  s.ingest(REALM, 'user-2', scan(21, 26, t2));
  assert.deepEqual(point(s)?.slice(1, 3), [21, 26]);
});

test('a lone uploader is never dropped, even on a big move', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110));
  s.ingest(REALM, 'user-1', scan(10, 11, T + HOUR));
  assert.deepEqual(point(s)?.slice(1, 3), [10, 11]);
});

test('two users who disagree: the one matching the history wins', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110, T - 2 * 24 * HOUR));
  const t = T;
  s.ingest(REALM, 'user-1', scan(98, 108, t));
  s.ingest(REALM, 'user-2', scan(900, 1000, t + 60));
  assert.deepEqual(point(s)?.slice(1, 3), [98, 108]);
});

test('anonymous uploads cannot rename items or set vendor prices', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110), { 5: { n: 'Linen Cloth', q: 1, v: 13 } });
  s.ingest(REALM, anonReporter('vandal-key-xxxxxxxxxx'), scan(100, 110), { 5: { n: 'Rude Name', q: 1, v: 9999 }, 6: { n: 'Wool', q: 1, v: 50 } });
  const { names } = s.history(REALM);
  assert.deepEqual(names[5], { n: 'Linen Cloth', q: 1, v: 13 });
  assert.deepEqual(names[6], { n: 'Wool', q: 1 }, 'an unnamed item can be named, without a vendor price');
});

test('categories: anyone can file a new item, only trusted uploaders name categories', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110), { 5: { n: 'Linen Cloth', q: 1, c: '7:5' } }, { 7: 'Trade Goods', '7:5': 'Cloth', 'x:y': 'bad' });
  s.ingest(REALM, anonReporter('vandal-key-xxxxxxxxxx'), scan(100, 110), { 5: { n: 'Linen Cloth', q: 1, c: '15:0' }, 6: { n: 'Wool', q: 1, c: '7:5' } }, { 7: 'Rude' });
  const h = s.history(REALM);
  assert.equal(h.names[5].c, '7:5', 'not moved by an anonymous upload');
  assert.equal(h.names[6].c, '7:5');
  assert.deepEqual(h.classes, { 7: 'Trade Goods', '7:5': 'Cloth' });
});

test('a ban removes the reports, moves the cursor and blocks uploads', () => {
  const s = store();
  const bad = anonReporter('banned-key-xxxxxxxxxx');
  s.ingest(REALM, bad, scan(5, 6));
  const before = s.history(REALM).cursor;
  writeBans(s.dir, { [bad]: { t: NOW, note: 'test' } });
  s.checkBans(true);
  assert.equal(s.history(REALM).items[5], undefined, 'reports gone');
  assert.ok(s.history(REALM).cursor > before, 'pulls see the change');
  assert.throws(() => s.ingest(REALM, bad, scan(5, 6)), /blocked/);
  // a fresh store reading the same folder keeps the ban
  assert.throws(() => new PriceStore(s.dir, { now: () => NOW }).ingest(REALM, bad, scan(5, 6)), /blocked/);
});

test('reports shows who counted', () => {
  const s = store();
  s.ingest(REALM, 'user-1', scan(100, 110));
  s.ingest(REALM, 'user-2', scan(101, 111));
  s.ingest(REALM, 'user-3', scan(5, 6, T + 60));
  s.ingest(REALM, anonReporter('anon-key-xxxxxxxxxxxx'), scan(100, 110, T + 120));
  const rows = Object.fromEntries(s.reports(REALM, '5', 24).map((r) => [r.reporter.startsWith('anon:') ? 'anon' : r.reporter, r.counted]));
  assert.deepEqual(rows, { 'user-1': true, 'user-2': true, 'user-3': false, anon: false });
});

test('ban targets and the ban commands', () => {
  const dir = path.join(tmp, 'bans');
  assert.equal(banTarget('anon:0123456789abcdef', path.join(tmp, 'no.db')).reporter, 'anon:0123456789abcdef');
  assert.equal(banTarget('42', path.join(tmp, 'no.db')).label, 'user 42');
  assert.throws(() => banTarget('Someone#1234', path.join(tmp, 'no.db')), /No user/);
  const log = console.log;
  console.log = () => {};
  try {
    banCommand('ban', dir, ['anon:0123456789abcdef', 'fake', 'dumps'], (w) => ({ reporter: w, label: w }));
    assert.equal(readBans(dir)['anon:0123456789abcdef'].note, 'fake dumps');
    banCommand('unban', dir, ['anon:0123456789abcdef'], (w) => ({ reporter: w, label: w }));
    assert.deepEqual(readBans(dir), {});
  } finally {
    console.log = log;
  }
});

let server: Server | null = null;
after(() => server?.close());

test('anonymous uploads from one address are limited however many keys it uses', async () => {
  const s = new PriceStore(path.join(tmp, 'http'));
  server = createServer({ wowPath: path.join(tmp, 'wow') }, { store: s, pushToken: null });
  const base = await listen(server);
  const t = Math.floor(Date.now() / 1000) - 60;
  const body = JSON.stringify({ realm: REALM, scans: Array.from({ length: 5 }, (_, i) => ({ t: t - i, items: [[5, 1, 1, 1]] })) });
  const post = (key: string) => fetch(`${base}/v1/scans`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
  const first = await json(post('key-number-0-xxxxxxxxxx'));
  assert.equal(first.counted, 'anonymous');
  let limited = false;
  for (let i = 1; i <= ANON_SCANS_PER_IP / 5 + 1 && !limited; i++) limited = (await post(`key-number-${i}-xxxxxxxxxx`)).status === 429;
  assert.ok(limited, 'new keys hit the per-address limit');
});
