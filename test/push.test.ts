// Pushing SavedVariables to the hosted web server: the upload endpoint in serve.js
// and the client in push.js, end to end over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Server } from 'node:http';
import { listen, json } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-push-'));
process.env.AHTC_CONFIG_DIR = path.join(tmp, 'config');
const { createServer } = await import('../src/serve.ts');
const { push } = await import('../src/push.ts');

const TOKEN = 'test-token-123';
const SV = (lastScan: number) => `AHTrackerDB = {\n["realms"] = {\n["Testrealm-Neutral"] = {\n["lastScan"] = ${lastScan},\n["items"] = {\n[2589] = {\n["n"] = "Linen Cloth",\n["h"] = "${lastScan}:10:12:300",\n},\n},\n},\n},\n}\n`;

// the hosted server's data folder, and this PC's WoW folder
const remote = path.join(tmp, 'remote');
const local = path.join(tmp, 'local');
for (const dir of [remote, local]) {
  fs.mkdirSync(path.join(dir, 'WTF', 'Account'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Interface'), { recursive: true });
}
function writeLocal(account: string, content: string): void {
  const dir = path.join(local, 'WTF', 'Account', account, 'SavedVariables');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AHTracker.lua'), content);
}

let server: Server, base: string;
before(async () => {
  server = createServer({ wowPath: remote }, { pushToken: TOKEN });
  base = await listen(server);
});
after(() => server.close());

const put = (account: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/accounts/${encodeURIComponent(account)}/savedvariables`, { method: 'PUT', body, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } })

test('rejects a missing or wrong token', async () => {
  const none = await fetch(`${base}/v1/accounts/WOW1/savedvariables`, { method: 'PUT', body: SV(1) })
  assert.equal(none.status, 401)
  assert.equal((await put('WOW1', SV(1), { Authorization: 'Bearer nope' })).status, 401)
})

test('rejects bad account names and files that are not SavedVariables', async () => {
  assert.equal((await put('../etc', SV(1))).status, 400)
  const res = await put('WOW1', 'hello there')
  assert.equal(res.status, 400)
  assert.equal((await put('WOW1', 'Other = {}')).status, 400)
  assert.ok(!fs.existsSync(path.join(remote, 'WTF', 'Account', 'WOW1')), 'nothing written')
})

test('GET on the upload path is refused', async () => {
  assert.equal((await fetch(`${base}/v1/accounts/WOW1/savedvariables`)).status, 405)
})

test('a gzip upload is saved and served right away', async () => {
  const res = await put('123#1', zlib.gzipSync(SV(1762400000)), { 'Content-Encoding': 'gzip' })
  assert.equal(res.status, 200)
  const body = await json(res)
  assert.deepEqual(body.realms, ['Testrealm-Neutral'])
  assert.equal(fs.readFileSync(path.join(remote, 'WTF', 'Account', '123#1', 'SavedVariables', 'AHTracker.lua'), 'utf8'), SV(1762400000))
  const realms = await json(fetch(`${base}/v1/realms`))
  assert.deepEqual(realms.realms.map((r: { realm: string }) => r.realm), ['Testrealm-Neutral'])
})

test('uploads are off without a token', async () => {
  const off = createServer({ wowPath: remote }, { pushToken: '' })
  const res = await fetch(`${await listen(off)}/v1/accounts/WOW1/savedvariables`, { method: 'PUT', body: SV(1) })
  off.close()
  assert.equal(res.status, 404)
})

test('push sends changed files only', async () => {
  writeLocal('WOW2', SV(1762500000))
  writeLocal('WOW3', SV(1762600000))
  fs.mkdirSync(path.join(local, 'WTF', 'Account', 'EMPTY'), { recursive: true }) // no data: skipped quietly
  const config = { wowPath: local, pushUrl: base + '/', pushToken: TOKEN }

  const first = await push(config)
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.pushed.sort(), ['WOW2', 'WOW3'])
  const realms = await json(fetch(`${base}/v1/realms`))
  assert.equal(realms.realms[0].lastScan, 1762600000, 'server re-read the new files')

  const second = await push(config)
  assert.deepEqual(second.pushed, [])
  assert.equal(second.skipped, 2)

  writeLocal('WOW2', SV(1762700000))
  assert.deepEqual((await push(config)).pushed, ['WOW2'])
  assert.equal((await push(config, { force: true })).pushed.length, 2)
})

test('push reports a wrong token', async () => {
  const r = await push({ wowPath: local, pushUrl: base, pushToken: 'wrong', pushed: {} })
  assert.equal(r.pushed.length, 0)
  assert.match(r.errors[0], /token/)
})

test('push without settings explains what to set', async () => {
  await assert.rejects(push({ wowPath: local }), /pushUrl/)
})
