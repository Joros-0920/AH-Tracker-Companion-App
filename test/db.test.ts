// Sign-up numbers for `ahtc users`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, openDbReadOnly, userStats, getRow } from '../src/db.ts';

const DAY = 86400;
const NOW = 1794400000;

function seed(db: DatabaseSync): void {
  const add = db.prepare('INSERT INTO users (bnet_id, battletag, created, last_login) VALUES (?, ?, ?, ?)');
  add.run('1', 'Old#1', NOW - 60 * DAY, NOW - 2 * 3600); // joined long ago, here today
  add.run('2', 'Week#2', NOW - 3 * DAY, NOW - 3 * DAY);
  add.run('3', 'Today#3', NOW - 3600, NOW - 3600);
  db.prepare('INSERT INTO devices (user_id, token_hash, name, created) VALUES (?, ?, ?, ?)').run(1, 'h1', 'PC', NOW);
  db.prepare('INSERT INTO devices (user_id, token_hash, name, created) VALUES (?, ?, ?, ?)').run(1, 'h2', 'Laptop', NOW);
}

test('counts sign-ups, recent logins and linked PCs', () => {
  const db = openDb(':memory:');
  seed(db);
  const s = userStats(db, NOW);
  assert.equal(s.total, 3);
  assert.deepEqual(s.joined, { 1: 1, 7: 2, 30: 2 });
  assert.deepEqual(s.active, { 1: 2, 7: 3, 30: 3 });
  assert.equal(s.withPC, 1, 'two PCs, one person');
  assert.equal(s.first, NOW - 60 * DAY);
  assert.equal(s.latest, NOW - 3600);
});

test('an empty database reports zero', () => {
  const s = userStats(openDb(':memory:'), NOW);
  assert.equal(s.total, 0);
  assert.equal(s.first, null);
});

test('ahtc users reads the database without creating one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtc-db-'));
  const file = path.join(dir, 'ahtc.db');
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const run = () => execFileSync(process.execPath, [cli, 'users'], {
    env: { ...process.env, AHTC_DB_PATH: file, AHTC_CONFIG_DIR: dir }, encoding: 'utf8', stdio: 'pipe',
  });
  assert.throws(run, /No database/);
  assert.equal(fs.existsSync(file), false);
  const db = openDb(file);
  seed(db);
  db.close();
  assert.equal(getRow<{ n: number }>(openDbReadOnly(file), 'SELECT COUNT(*) AS n FROM users').n, 3);
  assert.match(run(), /Signed up:\s+3/);
});
