// Realm keys. An Auction House is keyed by ruleset and faction: "PvP-Alliance",
// "Normal-Horde", "RP-PvP-Neutral". WoW Forever's rulesets: Normal, PvP, RP, RP-PvP
// and Hardcore. Before its 2026-11-20 client update the addon keyed AHs by the client's
// internal realm name ("CAMWOWUS2Realm8PvP-Alliance"). Since that update the client
// gives addons no realm name. Old keys are mapped to their ruleset wherever they come
// in (uploads, pushed SavedVariables, requests), so old and new addons share data.
// Same rules as ns.RulesetOf in the addon (AHTracker/Core.lua) and web/src/lib/realm.ts.

export const RULESETS = ['Normal', 'PvP', 'RP', 'RP-PvP', 'Hardcore'] as const;
export type Ruleset = (typeof RULESETS)[number];

const TYPES: Record<string, Ruleset> = { pve: 'Normal', normal: 'Normal', pvp: 'PvP', rp: 'RP', rppvp: 'RP-PvP' };
const OLD_RE = /^(?:CAMWOW)?[A-Z]{2}\d*Realm\d+[-_ ]?(RP[-_ ]?PvP|PvE|PvP|RP|Normal)$/i;
const FACTION_RE = /^(.*)-(Alliance|Horde|Neutral)$/;

/** "CAMWOWUS2Realm8PvP-Alliance" -> "PvP-Alliance". Other keys are returned as they are. */
export function canonicalRealm(key: string): string {
  const fm = FACTION_RE.exec(key);
  if (!fm) return key;
  const m = OLD_RE.exec(fm[1]);
  if (!m) return key;
  return `${TYPES[m[1].replace(/[-_ ]/g, '').toLowerCase()]}-${fm[2]}`;
}
