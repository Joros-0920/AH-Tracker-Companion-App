import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSavedVariables, toLua, luaString } from '../src/lua.ts';
import type { Json } from './helpers.ts';

test('parses the shapes WoW writes', () => {
  const src = `
AHTrackerDB = {
["settings"] = {
["buyThreshold"] = 0.8,
["tooltip"] = true,
["neg"] = -12,
["big"] = 1e+20,
},
["realms"] = {
["Testrealm-Horde"] = {
["lastScan"] = 1762400000,
["items"] = {
[2589] = {
["n"] = "Linen Cloth",
["h"] = "1:2:3:4,5:6:7:8",
},
},
},
},
}
OtherVar = nil
ListVar = {
"a", -- [1]
"b", -- [2]
{
["x"] = 1,
}, -- [3]
}
`;
  const out = parseSavedVariables<Json>(src);
  assert.equal(out.AHTrackerDB.settings.buyThreshold, 0.8);
  assert.equal(out.AHTrackerDB.settings.tooltip, true);
  assert.equal(out.AHTrackerDB.settings.neg, -12);
  assert.equal(out.AHTrackerDB.settings.big, 1e20);
  assert.equal(out.AHTrackerDB.realms['Testrealm-Horde'].items['2589'].n, 'Linen Cloth');
  assert.equal(out.OtherVar, null);
  assert.deepEqual(out.ListVar, { 1: 'a', 2: 'b', 3: { x: 1 } });
});

test('string escapes and UTF-8', () => {
  const src = Buffer.from('X = "a\\"b\\\\c\\nd\\065 Zul\'jin é"', 'utf8');
  assert.equal(parseSavedVariables<Json>(src).X, 'a"b\\c\ndA Zul\'jin é');
});

test('toLua output parses back to the same value', () => {
  const value = { name: 'Quote " and \\ and\nnewline', 2589: 'packed', nested: { 1: true, 2: 3.5 } };
  const back = parseSavedVariables<Json>(`V = ${toLua(value)}`).V;
  assert.deepEqual(back, { name: value.name, 2589: 'packed', nested: { 1: true, 2: 3.5 } });
  assert.equal(luaString('é'), '"é"');
});

test('reports the line of a syntax error', () => {
  assert.throws(() => parseSavedVariables('A = {\n["x"] = ,\n}'), /line 2/);
});

// Parse the real SavedVariables on this machine if WoW is installed (read only).
const realDir = '/mnt/c/Program Files (x86)/World of Warcraft/_forever_/WTF/Account';
test('parses every real SavedVariables file on this machine', { skip: !fs.existsSync(realDir) }, () => {
  let count = 0;
  for (const acct of fs.readdirSync(realDir)) {
    const dir = path.join(realDir, acct, 'SavedVariables');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.lua')) continue;
      parseSavedVariables(fs.readFileSync(path.join(dir, f)));
      count++;
    }
  }
  assert.ok(count > 0);
});
