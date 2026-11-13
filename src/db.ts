// SQLite database for the hosted server: users, sessions and login state.
// Uses Node's built-in node:sqlite (Node 22.13+), so there's still nothing to install.
// Only the hosted server opens it; the CLI loads this file on demand, so the tray app
// (Electron's Node) never needs it.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorMessage } from './errors.ts';

// Each entry moves the schema one version up; PRAGMA user_version records how far a file got.
// Never edit an entry once it has shipped: add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    bnet_id     TEXT NOT NULL UNIQUE,   -- Battle.net account id ("sub")
    battletag   TEXT NOT NULL,
    created     INTEGER NOT NULL,
    last_login  INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,       -- sha256 of the cookie value; the value itself is never stored
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created     INTEGER NOT NULL,
    expires     INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE oauth_states (
    state       TEXT PRIMARY KEY,       -- one per login attempt, used once
    created     INTEGER NOT NULL,
    return_to   TEXT NOT NULL
  );
  `,
  // linked PCs: a companion gets its own token by being approved on the site
  `
  CREATE TABLE devices (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,   -- sha256 of the device token
    name        TEXT NOT NULL,
    created     INTEGER NOT NULL,
    last_seen   INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE TABLE device_links (
    code        TEXT PRIMARY KEY,       -- shown to the person, typed or opened as a link
    poll_hash   TEXT NOT NULL UNIQUE,   -- sha256 of the secret the companion polls with
    name        TEXT NOT NULL,
    created     INTEGER NOT NULL,
    expires     INTEGER NOT NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE  -- set when approved
  );
  `,
];

/** Runs a query that returns one row and gives it the expected shape (SQLite doesn't check it). */
export function getRow<T>(db: DatabaseSync, sql: string, ...args: (string | number | null)[]): T {
  return db.prepare(sql).get(...args) as T;
}

/** Opens (or creates) the database at `file` and brings its schema up to date. ':memory:' works for tests. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = getRow<{ user_version: number }>(db, 'PRAGMA user_version').user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${v + 1} failed: ${errorMessage(err)}`);
    }
  }
  return db;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Counts for the last 1, 7 and 30 days. */
export type Recent = Record<1 | 7 | 30, number>;

export interface UserStats {
  total: number;
  joined: Recent;
  active: Recent;
  withPC: number;
  first: number | null;
  latest: number | null;
}

/**
 * Sign-up numbers for `ahtc users`: everyone who has logged in with Battle.net, how many
 * joined or came back in the last day / week / month, and how many have a PC linked.
 */
export function userStats(db: DatabaseSync, now = Math.floor(Date.now() / 1000)): UserStats {
  const DAY = 86400;
  const count = (sql: string, ...args: number[]) => getRow<{ n: number }>(db, sql, ...args).n;
  const since = (days: number) => now - days * DAY;
  const recent = (sql: string): Recent => ({ 1: count(sql, since(1)), 7: count(sql, since(7)), 30: count(sql, since(30)) });
  return {
    total: count('SELECT COUNT(*) AS n FROM users'),
    joined: recent('SELECT COUNT(*) AS n FROM users WHERE created >= ?'),
    active: recent('SELECT COUNT(*) AS n FROM users WHERE last_login >= ?'),
    withPC: count('SELECT COUNT(DISTINCT user_id) AS n FROM devices'),
    first: getRow<{ t: number | null }>(db, 'SELECT MIN(created) AS t FROM users').t,
    latest: getRow<{ t: number | null }>(db, 'SELECT MAX(created) AS t FROM users').t,
  };
}

/** Opens an existing database without changing it (for reports while the server runs). */
export function openDbReadOnly(file: string): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`No database at ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}
