// Settings and sync state, stored as JSON in the user's config folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { SyncSummary } from './sync.ts';

export function configDir(): string {
  if (process.env.AHTC_CONFIG_DIR) return process.env.AHTC_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'AHTrackerCompanion');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AHTrackerCompanion');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ah-tracker-companion');
}

export interface Config {
  /** auto-detected when null */
  wowPath: string | null;
  /** no server = share scans between your own accounts only */
  serverUrl: string | null;
  /** generated on first run, identifies this install to the server */
  apiKey: string;
  /** send your scans to the server */
  upload: boolean;
  /** how often to pull fresh prices while running */
  intervalMinutes: number;
  /** history to put in AppData.lua */
  days: number;
  /** your hosted web server (Fly.io); SavedVariables are pushed there when the game saves */
  pushUrl: string | null;
  /** secret matching the server's AHTC_PUSH_TOKEN */
  pushToken: string | null;
  /** account -> hash of the last pushed file */
  pushed: Record<string, string>;
  /** "account|realm" -> last uploaded scan time */
  cursors: Record<string, number>;
  lastSync: number | null;
  lastSummary?: SyncSummary;
}

const DEFAULTS: Omit<Config, 'apiKey'> & { apiKey: string | null } = {
  wowPath: null,
  serverUrl: null,
  apiKey: null,
  upload: true,
  intervalMinutes: 30,
  days: 30,
  pushUrl: null,
  pushToken: null,
  pushed: {},
  cursors: {},
  lastSync: null,
};

export const EDITABLE = ['wowPath', 'serverUrl', 'upload', 'intervalMinutes', 'days', 'pushUrl', 'pushToken'] as const;
export type EditableKey = (typeof EDITABLE)[number];
export const isEditable = (key: string | undefined): key is EditableKey => (EDITABLE as readonly (string | undefined)[]).includes(key);
/** settings `config` prints masked */
export const SECRET: readonly EditableKey[] = ['pushToken'];

export function loadConfig(): Config {
  const file = path.join(configDir(), 'config.json');
  let saved: Partial<Config> = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  // apiKey is null on the first run until it's made just below
  const config = { ...DEFAULTS, ...saved } as Config;
  // hosted server: the WoW-style data folder lives on a volume
  if (process.env.AHTC_WOW_PATH) config.wowPath = process.env.AHTC_WOW_PATH;
  if (!config.apiKey) {
    config.apiKey = crypto.randomUUID();
    saveConfig(config);
  }
  return config;
}

export function saveConfig(config: Partial<Config>): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/** Parse a CLI string into the type of the setting. */
export function coerce(key: EditableKey, raw: string): string | number | boolean | null {
  if (raw === 'null' || raw === '') return null;
  if (key === 'upload') return raw === 'true' || raw === '1' || raw === 'yes';
  if (key === 'intervalMinutes' || key === 'days') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
    return n;
  }
  if (key === 'serverUrl' || key === 'pushUrl') return raw.replace(/\/+$/, '');
  return raw;
}
