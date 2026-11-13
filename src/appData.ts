// Writes Interface/AddOns/AHTracker/AppData.lua, which the addon loads at login.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { luaString, luaKey } from './lua.ts';

// Lua 5.1 allows about 262k constants per function. Each item uses two
// (key and value), so items go in chunks, each inside its own function.
const CHUNK = 20000;

/**
 * Build the file. realms: { realmKey: { itemID: "packed history" } }
 * Returns the Lua source as a string.
 */
export function buildAppData(realms: Record<string, Record<string, string>>, generated: number): string {
  const lines = [
    '-- Written by the AH Tracker companion app. Do not edit: it is replaced on every sync.',
    `AHTracker_AppData = { version = 1, generated = ${generated}, realms = {} }`,
  ];
  for (const [realm, items] of Object.entries(realms)) {
    const entries = Object.entries(items);
    if (!entries.length) continue;
    lines.push(`AHTracker_AppData.realms[${luaString(realm)}] = {}`);
    for (let i = 0; i < entries.length; i += CHUNK) {
      lines.push(';(function(R)');
      for (const [id, packed] of entries.slice(i, i + CHUNK)) lines.push(`R${luaKey(id)}=${luaString(packed)}`);
      lines.push(`end)(AHTracker_AppData.realms[${luaString(realm)}])`);
    }
  }
  return lines.join('\n') + '\n';
}

const bodyHash = (src: string) => crypto.createHash('sha1').update(src.replace(/generated = \d+/, '')).digest('hex');

/**
 * Write the file atomically. Skips the write if only the timestamp would change.
 * Returns true when the file was written.
 */
export function writeAppData(file: string, source: string): boolean {
  try {
    if (bodyHash(fs.readFileSync(file, 'utf8')) === bodyHash(source)) return false;
  } catch { /* no file yet */ }
  fs.writeFileSync(file + '.tmp', source);
  fs.renameSync(file + '.tmp', file);
  return true;
}
