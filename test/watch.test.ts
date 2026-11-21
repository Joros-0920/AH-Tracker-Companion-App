// Reading the addon's watchlist, sales estimates and vendor prices, and the watchlist alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAccount } from '../src/savedVars.ts';
import { formatMoney, readLocal, watchAlerts } from '../src/sync.ts';
import type { Point } from '../src/history.ts';

const NOW = 1762400000;
const REALM = 'Testrealm-Horde';

const sv = (watch: string, sales: string) => `AHTrackerDB = {
["classNames"] = { ["7"] = "Trade Goods", ["7:5"] = "Cloth", ["bad key"] = "x" },
["watch"] = {
${watch}
},
["realms"] = {
["${REALM}"] = {
["lastScan"] = ${NOW},
["items"] = {
[2589] = { ["n"] = "Linen Cloth", ["q"] = 1, ["v"] = 13, ["c"] = "7:5", ["h"] = "${NOW}:100:110:20" },
},
["sales"] = {
${sales}
},
},
},
}
`;

function account(dir: string, name: string, content: string) {
  const file = path.join(dir, 'WTF', 'Account', name, 'SavedVariables', 'AHTracker.lua');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('reads the watchlist, sales and vendor prices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-watch-'));
  const file = account(dir, 'A', sv('[2589] = 200,\n[2592] = "bad",', '[2589] = "12.50:86400",\n[2592] = "junk",'));
  const data = readAccount(file)!;
  assert.deepEqual(data.watch, { 2589: 200 });
  assert.deepEqual(data.realms[REALM].sales, { 2589: '12.50:86400' });
  assert.equal(data.realms[REALM].names[2589].v, 13);
  assert.equal(data.realms[REALM].names[2589].c, '7:5');
  assert.deepEqual(data.classNames, { 7: 'Trade Goods', '7:5': 'Cloth' }, 'bad keys dropped');
});

test('merging accounts keeps the longest-watched sales and the highest watch price', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-watch-'));
  account(dir, 'A', sv('[2589] = 200,', '[2589] = "5:3600",'));
  account(dir, 'B', sv('[2589] = 300,', '[2589] = "40:172800",'));
  const accounts = ['A', 'B'].map((name) => ({ name, savedVariables: path.join(dir, 'WTF', 'Account', name, 'SavedVariables', 'AHTracker.lua') }));
  const local = readLocal(dir, [], accounts as Parameters<typeof readLocal>[2]);
  assert.equal(local.sales[REALM][2589], '40:172800');
  assert.equal(local.watch[2589], 300);
});

test('watchlist alerts fire once per new cheap server point', () => {
  const remote: Record<string, Record<string, Point[]>> = { [REALM]: { 2589: [[NOW - 7200, 300, 320, 5], [NOW - 600, 150, 180, 9]], 2592: [[NOW - 600, 999, 999, 1]] } };
  const names = { [REALM]: { 2589: { n: 'Linen Cloth', q: 1 } } };
  const alerted: Record<string, number> = {};
  const watch = { 2589: 200, 2592: 500 };
  const first = watchAlerts(watch, remote, names, alerted, NOW);
  assert.deepEqual(first.map((a) => [a.id, a.name, a.min]), [['2589', 'Linen Cloth', 150]]);
  assert.equal(watchAlerts(watch, remote, names, alerted, NOW).length, 0, 'same point: no repeat');
  // a newer cheap point alerts again
  remote[REALM][2589].push([NOW - 60, 140, 170, 9]);
  assert.equal(watchAlerts(watch, remote, names, alerted, NOW).length, 1);
  // old points don't alert
  assert.equal(watchAlerts({ 2589: 200 }, { [REALM]: { 2589: [[NOW - 10 * 3600, 1, 1, 1]] } }, names, {}, NOW).length, 0);
  // your own scan: the addon already told you in game
  const local = { [REALM]: { 2589: [[[NOW - 60, 140, 170, 9] as Point]] } };
  assert.equal(watchAlerts({ 2589: 200 }, { [REALM]: { 2589: [[NOW - 60, 140, 170, 9]] } }, names, {}, NOW, local).length, 0);
});

test('money formatting matches the addon', () => {
  assert.equal(formatMoney(125000), '12g 50s');
  assert.equal(formatMoney(320), '3s 20c');
  assert.equal(formatMoney(7), '7c');
});
