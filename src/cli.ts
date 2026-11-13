#!/usr/bin/env node
// Command line for the companion app. Run `ahtc help` for usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { loadConfig, saveConfig, configDir, coerce, isEditable, EDITABLE, SECRET, type Config, type EditableKey } from './config.ts';
import { push } from './push.ts';
import { sync, resolveWowPath, type SyncSummary } from './sync.ts';
import { Watcher } from './watcher.ts';
import { listAccounts, addonDir, appDataPath } from './wow.ts';
import { startServer, ingestPushedFiles, DEFAULT_PORT } from './serve.ts';
import { PriceStore } from './priceStore.ts';
import { linkPC } from './link.ts';
import { errorMessage } from './errors.ts';
import type { Recent } from './db.ts';

const HELP = `AH Tracker companion

Usage: ahtc <command>

  status                 Show the WoW folder, accounts and last sync
  sync                   Sync once: upload scans, download prices, write AppData.lua
  watch                  Keep running: sync when the game saves, and every intervalMinutes
                         (and push to your web server, if pushUrl is set)
  push [--force]         Send changed SavedVariables to your web server (pushUrl) now
  push-setup <url>       Point pushing at <url>, making a pushToken if there is none; prints the token
  link [url]             Link this PC to your Battle.net login on the site (default: serverUrl),
                         so the site shows you your own trades
  config                 Show settings
  config set <key> <v>   Change a setting (${EDITABLE.join(', ')})
  users                  How many people have signed up with Battle.net (reads AHTC_DB_PATH;
                         for the hosted server run scripts/deploy.sh --users)
  install-addon          Copy the addon from this repo into the WoW AddOns folder
  serve [--port N] [--host H] [--price-server]
                         Run the web app at http://localhost:4417 (add --demo for made-up data).
                         --price-server (or AHTC_PRICE_SERVER=1) also takes scans from other
                         companions and serves them back; the hosted copy runs this way
`;

const stamp = () => new Date().toLocaleTimeString();
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

function printSummary(s: SyncSummary): void {
  for (const e of s.errors) console.warn(`Warning: ${e}`);
}

function status(config: Config): void {
  const wowPath = resolveWowPath(config);
  console.log(`WoW folder:   ${wowPath}`);
  console.log(`Addon:        ${fs.existsSync(addonDir(wowPath)) ? 'installed' : 'NOT installed (run: ahtc install-addon)'}`);
  console.log(`Server:       ${config.serverUrl || 'none (sharing between your own accounts only)'}`);
  console.log(`Push to:      ${config.pushUrl && config.pushToken ? config.pushUrl : 'off (see: ahtc push-setup)'}`);
  console.log(`Config:       ${path.join(configDir(), 'config.json')}`);
  for (const acct of listAccounts(wowPath)) {
    const has = fs.existsSync(acct.savedVariables);
    console.log(`Account ${acct.name}: ${has ? 'has AH Tracker data' : 'no AH Tracker data yet'}`);
  }
  const app = appDataPath(wowPath);
  if (fs.existsSync(app)) console.log(`AppData.lua:  ${(fs.statSync(app).size / 1024).toFixed(0)} KB, written ${fs.statSync(app).mtime.toLocaleString()}`);
  console.log(`Last sync:    ${config.lastSync ? new Date(config.lastSync * 1000).toLocaleString() : 'never'}`);
}

function installAddon(config: Config): void {
  const wowPath = resolveWowPath(config);
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'AHTracker');
  if (!fs.existsSync(src)) throw new Error(`Addon source not found at ${src}`);
  const dest = addonDir(wowPath);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    // keep downloaded prices
    if (file === 'AppData.lua' && fs.existsSync(path.join(dest, file))) continue;
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  console.log(`Installed the addon to ${dest}. Restart WoW (or /reload if it was already installed).`);
}

/**
 * Battle.net login, when BNET_CLIENT_ID and BNET_CLIENT_SECRET are set. Loads SQLite only then,
 * so nothing else (the tray app included) needs it.
 */
async function loadAuth(port: number, log: (msg: string) => void) {
  const { BNET_CLIENT_ID: clientId, BNET_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) return null;
  const { openDb } = await import('./db.ts');
  const { Auth } = await import('./auth.ts');
  const file = process.env.AHTC_DB_PATH || path.join(configDir(), 'ahtc.db');
  const admins = (process.env.AHTC_ADMINS || '').split(',').filter(Boolean);
  const publicUrl = process.env.AHTC_PUBLIC_URL || `http://localhost:${port}`;
  if (!admins.length) log('No AHTC_ADMINS set: people can log in, but nobody can see trades.');
  log(`Battle.net login on (callback ${publicUrl}/auth/bnet/callback), database ${file}`);
  return new Auth(openDb(file), { clientId, clientSecret, publicUrl, admins, oauthBase: process.env.BNET_OAUTH_URL });
}

async function users(): Promise<void> {
  const { openDbReadOnly, userStats } = await import('./db.ts');
  const file = process.env.AHTC_DB_PATH || path.join(configDir(), 'ahtc.db');
  const db = openDbReadOnly(file);
  const s = userStats(db);
  db.close();
  const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : 'never');
  const row = (label: string, o: Recent) => console.log(`${label.padEnd(14)}${o[1]} today, ${o[7]} this week, ${o[30]} this month`);
  console.log(`Signed up:    ${s.total}`);
  row('New:', s.joined);
  row('Logged in:', s.active);
  console.log(`Linked a PC:  ${s.withPC}`);
  console.log(`First / latest sign-up: ${when(s.first)} / ${when(s.latest)}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...args] = argv;
  const config = loadConfig();
  switch (cmd) {
    case 'status':
      return status(config);
    case 'sync':
      return printSummary(await sync(config, { log }));
    case 'watch': {
      const w = new Watcher(config);
      w.on('log', log);
      w.on('error', (err) => log(`Error: ${err.message}`));
      w.start();
      log('Watching for game saves. Press Ctrl+C to stop.');
      return new Promise(() => {});
    }
    case 'config': {
      if (args[0] === 'set') {
        const [, key, ...rest] = args;
        if (!isEditable(key)) throw new Error(`Unknown setting "${key}". Settings: ${EDITABLE.join(', ')}`);
        const settings = config as unknown as Record<EditableKey, unknown>;
        settings[key] = coerce(key, rest.join(' '));
        saveConfig(config);
        console.log(`${key} = ${JSON.stringify(settings[key])}`);
        return;
      }
      for (const key of EDITABLE) {
        const v = SECRET.includes(key) && config[key] ? '(set)' : JSON.stringify(config[key]);
        console.log(`${key} = ${v}`);
      }
      return;
    }
    case 'push': {
      const r = await push(config, { log, force: args.includes('--force') });
      for (const e of r.errors) console.warn(`Warning: ${e}`);
      if (!r.pushed.length && !r.errors.length) log(r.skipped ? 'Nothing changed since the last push.' : 'No AH Tracker data found to push.');
      if (r.errors.length) process.exitCode = 1;
      return;
    }
    case 'link': {
      const { battletag } = await linkPC(config, args[0], {
        onCode: ({ code, url }) => {
          console.log(`Open this link and approve "${os.hostname()}" (code ${code}):\n\n  ${url}\n`);
          console.log('Waiting for you to approve it on the site...');
        },
      });
      console.log(`Linked to ${battletag || 'your account'}. Pushes from this PC now go to your own trades.`);
      console.log('Run "ahtc push --force" (or let watch/the tray app push) to send your data.');
      return;
    }
    case 'push-setup': {
      if (!args[0]) throw new Error('Usage: ahtc push-setup <server url>');
      config.pushUrl = coerce('pushUrl', args[0]) as string | null;
      config.pushToken ||= crypto.randomBytes(32).toString('base64url');
      saveConfig(config);
      console.log(config.pushToken);
      return;
    }
    case 'serve': {
      const demo = args.includes('--demo');
      const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      const port = Number(opt('--port') || process.env.PORT) || DEFAULT_PORT;
      // 0.0.0.0 when hosted (Fly); local only by default
      const host = opt('--host') || process.env.HOST || '127.0.0.1';
      // price server: take scans from companions and serve them back (the hosted copy)
      const priceServer = !demo && (args.includes('--price-server') || /^(1|true|yes)$/i.test(process.env.AHTC_PRICE_SERVER || ''));
      const store = priceServer ? new PriceStore(process.env.AHTC_DATA_DIR || path.join(configDir(), 'prices')) : null;
      // trades stay private anywhere but a local-only server
      const privateLedger = priceServer || !['127.0.0.1', 'localhost', '::1'].includes(host);
      const auth = demo ? null : await loadAuth(port, log);
      if (privateLedger && !auth) log('Trades are hidden: set BNET_CLIENT_ID and BNET_CLIENT_SECRET to log in and see them.');
      if (store) {
        const n = ingestPushedFiles(config, store, log);
        if (n) log(`Loaded ${n} pushed account file(s) into the price store.`);
      }
      const { url } = await startServer(config, { demo, port, host, store, auth, privateLedger });
      log(`Web app at ${url}${demo ? ' (demo data)' : ''}${store ? `, price server on (data in ${store.dir})` : ''}. Press Ctrl+C to stop.`);
      return new Promise(() => {});
    }
    case 'users':
      return users();
    case 'install-addon':
      return installAddon(config);
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exit(1);
});
