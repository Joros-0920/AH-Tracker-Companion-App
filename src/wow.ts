// Finding the WoW Forever install and the files the companion reads and writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ADDON = 'AHTracker';

export interface Account {
  /** the account folder name, e.g. "WOW1"; on the hosted server "<user id>/<folder>" for a user's files */
  name: string;
  /** path to the account's AHTracker.lua (may not exist yet) */
  savedVariables: string;
  /** hosted server: the user who pushed it, or null for the shared push token */
  owner?: number | null;
}

function candidates(): string[] {
  const flavor = '_forever_';
  const list: string[] = [];
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      list.push(`${drive}:\\Program Files (x86)\\World of Warcraft\\${flavor}`);
      list.push(`${drive}:\\Program Files\\World of Warcraft\\${flavor}`);
      list.push(`${drive}:\\World of Warcraft\\${flavor}`);
      list.push(`${drive}:\\Games\\World of Warcraft\\${flavor}`);
    }
  } else if (process.platform === 'darwin') {
    list.push(`/Applications/World of Warcraft/${flavor}`);
    list.push(path.join(os.homedir(), `Applications/World of Warcraft/${flavor}`));
  } else {
    // WSL: the Windows drives are under /mnt
    for (const drive of ['c', 'd', 'e', 'f']) {
      list.push(`/mnt/${drive}/Program Files (x86)/World of Warcraft/${flavor}`);
      list.push(`/mnt/${drive}/Program Files/World of Warcraft/${flavor}`);
      list.push(`/mnt/${drive}/World of Warcraft/${flavor}`);
      list.push(`/mnt/${drive}/Games/World of Warcraft/${flavor}`);
    }
  }
  return list;
}

export function isWowFolder(dir: string | null | undefined): dir is string {
  return !!dir && fs.existsSync(path.join(dir, 'WTF')) && fs.existsSync(path.join(dir, 'Interface'));
}

export function findWowPath(): string | null {
  return candidates().find(isWowFolder) || null;
}

/** Account folders under WTF/Account, each with the path to AHTracker's SavedVariables. */
export function listAccounts(wowPath: string): Account[] {
  const root = path.join(wowPath, 'WTF', 'Account');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'SavedVariables')
    .map((d) => ({
      name: d.name,
      savedVariables: path.join(root, d.name, 'SavedVariables', `${ADDON}.lua`),
    }));
}

export function addonDir(wowPath: string): string {
  return path.join(wowPath, 'Interface', 'AddOns', ADDON);
}

export function appDataPath(wowPath: string): string {
  return path.join(addonDir(wowPath), 'AppData.lua');
}
