// Realm keys by ruleset, and old keys mapped to them everywhere they come in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalRealm } from '../src/realm.ts';
import { PriceStore } from '../src/priceStore.ts';
import { mergeRealmData, type RealmData } from '../src/savedVars.ts';

test('old realm keys map to their ruleset', () => {
  assert.equal(canonicalRealm('CAMWOWUS2Realm8PvP-Alliance'), 'PvP-Alliance');
  assert.equal(canonicalRealm('CAMWOWUS2Realm1PvE-Horde'), 'Normal-Horde');
  assert.equal(canonicalRealm('CAMWOWUS1Realm10RP-Alliance'), 'RP-Alliance');
  assert.equal(canonicalRealm('CAMWOWUS1Realm3RP-PvP-Neutral'), 'RP-PvP-Neutral');
  assert.equal(canonicalRealm('PvP-Alliance'), 'PvP-Alliance');
  assert.equal(canonicalRealm('RP-PvP-Horde'), 'RP-PvP-Horde');
  assert.equal(canonicalRealm('CAMWOWUS2Realm4-Horde'), 'CAMWOWUS2Realm4-Horde', 'no ruleset in it');
  assert.equal(canonicalRealm('Testrealm-Horde'), 'Testrealm-Horde');
});

test('the store merges old realm files into their ruleset and answers old keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-realm-'));
  const now = 1762400000;
  const t = now - 3600;
  const s1 = new PriceStore(dir, { now: () => now });
  s1.ingest('CAMWOWUS2Realm8PvP-Alliance', 'a', [{ t, items: [[5, 100, 100, 1]] }]);
  // an older store wrote files under old keys; fake one
  fs.writeFileSync(path.join(dir, 'CAMWOWUS1Realm9PvP-Alliance.json'), JSON.stringify({
    items: { 6: { b: { [Math.floor(t / 3600) * 3600]: { b: [t, 7, 8, 9] } }, u: 1 } }, names: { 6: { n: 'Ore', q: 1 } }, lastScan: t, updated: t, seq: 1,
  }));
  const s2 = new PriceStore(dir, { now: () => now });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(), ['PvP-Alliance.json']);
  assert.deepEqual(s2.realmKeys(), ['PvP-Alliance']);
  const h = s2.history('CAMWOWUS2Realm8PvP-Alliance');
  assert.deepEqual(Object.keys(h.items).sort(), ['5', '6']);
  assert.equal(h.names[6].n, 'Ore');
});

test('two realms of one ruleset in a SavedVariables file read as one', () => {
  const a: RealmData = { lastScan: 10, items: { 1: [[5, 1, 1, 1], [10, 2, 2, 2]] }, names: { 1: { n: 'A', q: 1 } }, ladders: { 1: '1:1' }, ladderTime: 10, ledger: ['s:5:x'], sales: { 1: '1.00:100' } };
  const b: RealmData = { lastScan: 20, items: { 1: [[10, 2, 2, 2], [20, 3, 3, 3]], 2: [[20, 1, 1, 1]] }, names: {}, ladders: { 2: '2:2' }, ladderTime: 20, ledger: ['s:5:x', 'd:15:y'], sales: { 1: '2.00:50' } };
  const m = mergeRealmData(a, b);
  assert.deepEqual(m.items[1].map((p) => p[0]), [5, 10, 20]);
  assert.deepEqual(m.items[2], [[20, 1, 1, 1]]);
  assert.equal(m.lastScan, 20);
  assert.deepEqual(m.ladders, { 2: '2:2' });
  assert.deepEqual(m.ledger, ['s:5:x', 'd:15:y']);
  assert.equal(m.sales[1], '1.00:100');
});
