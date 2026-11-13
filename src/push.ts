// Sends this PC's AH Tracker SavedVariables to your hosted web server (the one
// `scripts/deploy.sh` puts on Fly.io), so its pages update without a redeploy.
// Uses PUT /v1/accounts/:account/savedvariables (see serve.ts). Only files that changed
// since the last push are sent; their hashes are kept in config.pushed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { listAccounts } from './wow.ts';
import { resolveWowPath } from './sync.ts';
import { saveConfig, type Config } from './config.ts';
import { errorMessage } from './errors.ts';

const TIMEOUT = 120_000;
const USER_AGENT = 'AHTrackerCompanion/0.1';

export type PushConfig = Partial<Pick<Config, 'wowPath' | 'pushUrl' | 'pushToken' | 'pushed'>>;
type ReadyPushConfig = PushConfig & { pushUrl: string; pushToken: string };

export const pushEnabled = (config: PushConfig): config is ReadyPushConfig => !!(config.pushUrl && config.pushToken);

export interface PushResult {
  /** account names that were sent */
  pushed: string[];
  /** files unchanged since the last push */
  skipped: number;
  errors: string[];
}

export interface PushOptions {
  log?: (msg: string) => void;
  /** send every file, changed or not */
  force?: boolean;
}

/** config needs pushUrl and pushToken; config.pushed is updated and saved. */
export async function push(config: PushConfig, { log = () => {}, force = false }: PushOptions = {}): Promise<PushResult> {
  if (!pushEnabled(config)) throw new Error('Pushing is off. Set pushUrl and pushToken (scripts/deploy.sh does this for you).');
  const base = config.pushUrl.replace(/\/+$/, '');
  const result: PushResult = { pushed: [], skipped: 0, errors: [] };
  const pushed = (config.pushed ??= {});

  for (const acct of listAccounts(resolveWowPath(config))) {
    let body: Buffer;
    try { body = fs.readFileSync(acct.savedVariables); } catch { continue; } // no data on this account yet
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (!force && pushed[acct.name] === hash) { result.skipped++; continue; }
    try {
      const res = await fetch(`${base}/v1/accounts/${encodeURIComponent(acct.name)}/savedvariables`, {
        method: 'PUT',
        headers: {
          'User-Agent': USER_AGENT,
          Authorization: `Bearer ${config.pushToken}`,
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Encoding': 'gzip',
        },
        body: zlib.gzipSync(body),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const reply = (await res.json().catch(() => ({}))) as { error?: string; realms?: string[] };
      if (!res.ok) throw new Error(reply.error || `HTTP ${res.status}`);
      pushed[acct.name] = hash;
      result.pushed.push(acct.name);
      log(`Pushed ${acct.name} to ${base} (${(body.length / 1024).toFixed(0)} KB, ${reply.realms?.length ?? 0} realm(s)).`);
    } catch (err) {
      result.errors.push(`Push of ${acct.name} failed: ${errorMessage(err)}`);
    }
  }
  if (result.pushed.length) saveConfig(config);
  return result;
}
