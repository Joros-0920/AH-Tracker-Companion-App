import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/serve.ts';
import { decode } from '../src/history.ts';
import { listen, json } from './helpers.ts';

const server = createServer({}, { demo: true });
const base = await listen(server);
after(() => server.close());

test('lists realms', async () => {
  const res = await json(fetch(`${base}/v1/realms`));
  assert.equal(res.demo, true);
  assert.equal(res.realms[0].realm, 'Demo-Horde');
  assert.equal(res.realms[0].items, 30);
});

test('returns packed prices and names for a realm', async () => {
  const res = await json(fetch(`${base}/v1/realms/Demo-Horde/prices?days=30`));
  assert.equal(res.names['2589'].n, 'Linen Cloth');
  const points = decode(res.items['2589']);
  assert.ok(points.length > 10);
  assert.ok(points.every((p) => p.length === 4));
  assert.match(res.ladders['2589'], /^\d+:\d+(,\d+:\d+)*$/);
  assert.ok(res.ladderTime > 0);
});

test('returns the ledger for a realm', async () => {
  const res = await json(fetch(`${base}/v1/realms/Demo-Horde/ledger`));
  assert.ok(res.records.length > 10);
  assert.match(res.records[0], /^[bsdx]:\d+:\d+:\d+:\d+:\d+:\d+:[^:]*:.+$/);
});

test('unknown realm is a 404 with an error message', async () => {
  const res = await fetch(`${base}/v1/realms/Nope-Horde/prices`);
  assert.equal(res.status, 404);
  assert.match((await json(res)).error, /No data/);
});

test('static files cannot escape the web folder', async () => {
  const res = await fetch(`${base}/..%2F..%2Fcompanion%2Fpackage.json`);
  assert.ok(!(await res.text()).includes('ah-tracker-companion'));
});
