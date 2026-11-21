// Price server moderation: see who reported what for an item, and ban uploaders.
// Bans live in banned.json in the price data folder. The running server checks that file
// every few seconds, then ignores the banned reporter and removes their reports, so these
// commands work while it runs (e.g. over `fly ssh console`).
import fs from 'node:fs';
import { PriceStore, isAnon, readBans, writeBans } from './priceStore.ts';
import { userReporter } from './serve.ts';
import { openDbReadOnly, getRow } from './db.ts';

/**
 * The reporter id for a ban: "anon:..." or a 16-hex id as shown by `ahtc reports`, a user
 * ID, or a BattleTag (looked up in the user database). Returns { reporter, label }.
 */
export function banTarget(who: string, dbFile: string): { reporter: string; label: string } {
  if (isAnon(who) || /^[0-9a-f]{16}$/.test(who)) return { reporter: who, label: who };
  let id: number | null = /^\d+$/.test(who) ? Number(who) : null;
  let label = who;
  if (fs.existsSync(dbFile)) {
    const db = openDbReadOnly(dbFile);
    try {
      const row = id !== null
        ? getRow<{ id: number; battletag: string } | undefined>(db, 'SELECT id, battletag FROM users WHERE id = ?', id)
        : getRow<{ id: number; battletag: string } | undefined>(db, 'SELECT id, battletag FROM users WHERE lower(battletag) = lower(?)', who);
      if (row) { id = row.id; label = `${row.battletag} (user ${row.id})`; }
    } finally {
      db.close();
    }
  }
  if (id === null) throw new Error(`No user "${who}". Use a BattleTag, a user ID, or a reporter id from "ahtc reports".`);
  return { reporter: userReporter(id), label: label === who ? `user ${id}` : label };
}

export function banCommand(cmd: string, dir: string, args: string[], resolve: (who: string) => { reporter: string; label: string }): void {
  const bans = readBans(dir);
  if (cmd === 'bans') {
    const list = Object.entries(bans);
    if (!list.length) return console.log('No bans.');
    for (const [reporter, b] of list) console.log(`${reporter}  ${new Date(b.t * 1000).toLocaleString()}${b.note ? `  ${b.note}` : ''}`);
    return;
  }
  const [who, ...note] = args;
  if (!who) throw new Error(`Usage: ahtc ${cmd} <BattleTag | user ID | reporter id>`);
  const { reporter, label } = resolve(who);
  if (cmd === 'unban') {
    if (!bans[reporter]) return console.log(`${label} isn't banned.`);
    delete bans[reporter];
    writeBans(dir, bans);
    return console.log(`Unbanned ${label}. Reports already removed stay removed.`);
  }
  bans[reporter] = { t: Math.floor(Date.now() / 1000), note: [label !== reporter ? label : '', ...note].filter(Boolean).join(' ') || undefined };
  writeBans(dir, bans);
  console.log(`Banned ${label} (${reporter}). The server drops their reports within a few seconds.`);
}

export function reportsCommand(dir: string, args: string[]): void {
  const [realm, id, hours] = args;
  if (!realm || !id) throw new Error('Usage: ahtc reports <realm> <itemID> [hours]');
  const store = new PriceStore(dir);
  const rows = store.reports(realm, id, Number(hours) || 24);
  if (!rows.length) return console.log(`No reports for item ${id} on ${realm} in that time.`);
  console.log('hour              reporter              min        market     qty    counted');
  for (const r of rows) {
    const [, min, mkt, qty] = r.point;
    console.log(`${new Date(r.bucket * 1000).toISOString().slice(0, 16)}  ${r.reporter.padEnd(21)} ${String(min).padStart(10)} ${String(mkt).padStart(10)} ${String(qty).padStart(7)}    ${r.counted ? 'yes' : 'no'}`);
  }
}
