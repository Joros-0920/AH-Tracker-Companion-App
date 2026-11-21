import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ItemCache, blizzardItems, blizzardTooltip, cleanInfo, remoteItems, GREEN, YELLOW, type ItemInfo, type ItemLookup } from '../src/items.ts';
import { createServer } from '../src/serve.ts';
import { listen, json } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-items-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(tmp, `items-${n++}.json`);

const staff: ItemInfo = {
  icon: 'inv_staff_13', q: 4,
  tooltip: { name: 'Staff of Jordan', lines: [{ text: 'Binds when picked up' }, { text: 'Two-Hand', right: 'Staff' }], sell: 12345 },
};

/** A lookup that knows `known` and records what it was asked. */
function fake(known: Record<number, ItemInfo>) {
  const calls: number[][] = [];
  const lookup: ItemLookup = async (ids) => {
    calls.push(ids);
    return Object.fromEntries(ids.map((id) => [id, known[id] ?? null]));
  };
  return { lookup, calls };
}

test('looks up each item once and keeps misses', async () => {
  const { lookup, calls } = fake({ 873: staff });
  const cache = new ItemCache(file(), lookup);
  assert.deepEqual(await cache.get([873, 999]), { 873: staff });
  assert.deepEqual(await cache.get([873, 999]), { 873: staff });
  assert.deepEqual(calls, [[873, 999]]);
  assert.deepEqual(cache.misses([873, 999]), [999]);
});

test('retries a miss after a week', async () => {
  const { lookup, calls } = fake({});
  let now = 1_000_000;
  const cache = new ItemCache(file(), lookup, { now: () => now });
  await cache.get([5]);
  now += 3600;
  await cache.get([5]);
  assert.equal(calls.length, 1);
  now += 8 * 24 * 3600;
  await cache.get([5]);
  assert.equal(calls.length, 2);
});

test('items the source left out are asked again, not stored as misses', async () => {
  const calls: number[][] = [];
  const cache = new ItemCache(file(), async (ids) => { calls.push(ids); return {}; });
  await cache.get([7]);
  assert.deepEqual(cache.misses([7]), []);
  await cache.get([7]);
  assert.equal(calls.length, 2);
});

test('a failing source stores nothing', async () => {
  const cache = new ItemCache(file(), async () => { throw new Error('down'); });
  assert.deepEqual(await cache.get([1]), {});
  assert.deepEqual(cache.unknown([1]), [1]);
});

test('cleanInfo drops bad icons, qualities, colors and oversized tooltips', () => {
  assert.equal(cleanInfo({ icon: '../../evil', q: -1, tooltip: null }), null);
  const lines = Array.from({ length: 60 }, (_, i) => ({ text: `line ${i}`, color: i ? 'red' : '#1EFF00' }));
  const info = cleanInfo({ icon: 'INV_OK', q: 9, tooltip: { name: 'X', lines: [...lines, { text: '' }], sell: -5 } });
  assert.equal(info?.icon, 'inv_ok');
  assert.equal(info?.q, null);
  assert.equal(info?.tooltip?.lines.length, 40);
  assert.deepEqual(info?.tooltip?.lines.slice(0, 2), [{ text: 'line 0', color: '#1eff00' }, { text: 'line 1' }]);
  assert.equal(info?.tooltip?.sell, undefined);
});

test('saves to and loads from its file', async () => {
  const f = file();
  const a = new ItemCache(f, fake({ 1: staff }).lookup);
  await a.get([1, 2]);
  a.save();
  const { lookup, calls } = fake({});
  const b = new ItemCache(f, lookup);
  assert.deepEqual(await b.get([1, 2]), { 1: staff });
  assert.equal(calls.length, 0);
});

test('stops waiting after waitMs and finishes in the background', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const cache = new ItemCache(file(), async (ids) => { await gate; return Object.fromEntries(ids.map((id) => [id, staff])); });
  assert.deepEqual(await cache.get([1], 10), {});
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(cache.known([1]), { 1: staff });
});

// a trimmed real answer from /data/wow/item/873?namespace=static-classic1x-us&locale=en_US
const blizzardStaff = {
  id: 873, name: 'Staff of Jordan', quality: { type: 'EPIC', name: 'Epic' }, sell_price: 12345,
  preview_item: {
    binding: { type: 'ON_ACQUIRE', name: 'Binds when picked up' },
    inventory_type: { type: 'TWOHWEAPON', name: 'Two-Hand' },
    item_subclass: { name: 'Staff' },
    weapon: {
      damage: { display_string: '78 - 118 Damage' },
      attack_speed: { display_string: 'Speed 3.20' },
      dps: { display_string: '(30.6 damage per second)' },
    },
    stats: [
      { type: { type: 'STAMINA' }, value: 10, display: { display_string: '+10 Stamina', color: { r: 255, g: 255, b: 255, a: 1 } } },
      { type: { type: 'INTELLECT' }, value: 8, is_negated: true, display: { display_string: '-8 Intellect' } },
    ],
    durability: { display_string: 'Durability 100 / 100' },
    requirements: { level: { display_string: 'Requires Level 42' } },
    spells: [{ description: 'Equip: Increases damage done by magical spells by up to 30.' }],
    description: 'The staff of the archmage.',
  },
};

test('blizzardTooltip puts the lines in game order with game colors', () => {
  assert.deepEqual(blizzardTooltip(blizzardStaff), {
    name: 'Staff of Jordan',
    sell: 12345,
    lines: [
      { text: 'Binds when picked up' },
      { text: 'Two-Hand', right: 'Staff' },
      { text: '78 - 118 Damage', right: 'Speed 3.20' },
      { text: '(30.6 damage per second)' },
      { text: '+10 Stamina' },
      { text: 'Durability 100 / 100' },
      { text: 'Requires Level 42' },
      { text: 'Equip: Increases damage done by magical spells by up to 30.', color: GREEN },
      { text: '"The staff of the archmage."', color: YELLOW },
    ],
  });
});

/** A fake Blizzard API: `items` by namespace. */
function fakeBlizzard(items: Record<string, Record<number, { item?: object; icon?: string; status?: number }>>) {
  let tokens = 0;
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/token') { tokens++; return Response.json({ access_token: 't', expires_in: 3600 }); }
    const ns = url.searchParams.get('namespace') ?? '';
    const m = url.pathname.match(/\/data\/wow\/(media\/)?item\/(\d+)$/);
    const entry = m && items[ns]?.[Number(m[2])];
    if (!entry) return new Response('not found', { status: 404 });
    if (entry.status) return new Response('busy', { status: entry.status });
    if (m[1]) return Response.json({ assets: [{ key: 'icon', value: `https://render.worldofwarcraft.com/classic1x-us/icons/56/${entry.icon}.jpg` }] });
    return Response.json(entry.item);
  }) as typeof fetch;
  return { fetchFn, tokens: () => tokens };
}

test('blizzardItems gets icon, quality and tooltip, trying Classic Era before retail', async () => {
  const api = fakeBlizzard({
    'static-classic1x-us': { 873: { item: blizzardStaff, icon: 'inv_staff_13' } },
    'static-us': { 2: { item: { name: 'Retail Only', quality: { type: 'RARE' } }, icon: 'inv_misc_herb_01' } },
  });
  const lookup = blizzardItems({ clientId: 'id', clientSecret: 'secret', apiBase: 'https://api.test', oauthBase: 'https://oauth.test', fetch: api.fetchFn });
  const out = await lookup([873, 2, 3]);
  assert.equal(out[873]?.icon, 'inv_staff_13');
  assert.equal(out[873]?.q, 4);
  assert.equal(out[873]?.tooltip?.lines[0].text, 'Binds when picked up');
  assert.deepEqual(out[2], { icon: 'inv_misc_herb_01', q: 3, tooltip: { name: 'Retail Only', lines: [] } });
  assert.equal(out[3], null);
  assert.equal(api.tokens(), 1);
});

test('blizzardItems leaves out items whose lookup failed', async () => {
  const api = fakeBlizzard({ 'static-classic1x-us': { 1: { item: { name: 'A' }, icon: 'inv_a' }, 2: { status: 429 } } });
  const lookup = blizzardItems({ clientId: 'id', clientSecret: 'secret', apiBase: 'https://api.test', oauthBase: 'https://oauth.test', fetch: api.fetchFn });
  const out = await lookup([1, 2]);
  assert.deepEqual(Object.keys(out), ['1']);
});

test('GET /v1/items answers from the cache, tooltips only when asked, and remoteItems reads it', async () => {
  const cache = new ItemCache(file(), fake({ 873: staff }).lookup);
  const server = createServer({}, { demo: true, items: cache });
  const base = await listen(server);
  after(() => server.close());

  const res = await json(fetch(`${base}/v1/items?ids=873,999,873`));
  assert.deepEqual(res, { items: { 873: { icon: 'inv_staff_13', q: 4 } }, missing: [999] });
  const full = await json(fetch(`${base}/v1/items?ids=873&tooltips=1`));
  assert.deepEqual(full.items[873], staff);
  assert.equal((await fetch(`${base}/v1/items?ids=abc`)).status, 400);
  assert.equal((await fetch(`${base}/v1/items?ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`)).status, 400);

  assert.deepEqual(await remoteItems(base)([873, 999]), { 873: staff, 999: null });
});

test('GET /v1/items is a 404 without an item source', async () => {
  const server = createServer({}, { demo: true });
  const base = await listen(server);
  after(() => server.close());
  assert.equal((await fetch(`${base}/v1/items?ids=1`)).status, 404);
});
