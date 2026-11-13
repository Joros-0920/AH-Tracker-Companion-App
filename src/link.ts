// Links this PC to your Battle.net login on the hosted site, like signing in on a TV:
// the server gives a code, you approve it on the site, and this PC gets its own token.
// After that, pushes and uploads count as you, and the site shows you your own trades.
import os from 'node:os';
import { saveConfig, type Config } from './config.ts';

const USER_AGENT = 'AHTrackerCompanion/0.1';

/** What /v1/link/start and /v1/link/poll answer (see auth.ts). */
interface LinkReply {
  error?: string;
  code?: string;
  poll?: string;
  url?: string;
  interval?: number;
  expiresIn?: number;
  token?: string;
  battletag?: string | null;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; reply: LinkReply }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await res.json().catch(() => ({}))) as LinkReply;
  return { status: res.status, reply };
}

export type LinkConfig = Pick<Config, 'serverUrl' | 'pushUrl' | 'pushToken' | 'pushed'>;

/** The server to link to: the given URL, else serverUrl, else pushUrl. */
export function linkTarget(config: LinkConfig, url?: string | null): string {
  const base = (url || config.serverUrl || config.pushUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Which server? Run: ahtc link https://your-app.fly.dev');
  return base;
}

export interface LinkOptions {
  /** called with the code to approve and the page to approve it on */
  onCode?: (link: { code: string; url: string }) => void | Promise<void>;
  /** what the site calls this PC (default: the host name) */
  name?: string;
  /** for tests */
  sleep?: (ms: number) => Promise<void>;
  /** stop waiting */
  signal?: AbortSignal;
}

/**
 * Runs a whole link: starts it, calls onCode({ code, url }) so the person can approve it,
 * then waits for the approval. Saves the token as pushToken (and the server as pushUrl,
 * plus serverUrl if unset). Resolves to { battletag }.
 */
export async function linkPC(
  config: LinkConfig,
  url: string | null | undefined,
  { onCode, name = os.hostname(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal }: LinkOptions = {},
): Promise<{ battletag: string | null | undefined }> {
  const base = linkTarget(config, url);
  const start = await post(base, '/v1/link/start', { name });
  if (start.status === 404) throw new Error(`${base} doesn't support linking yet (or has no Battle.net login). Deploy the latest version.`);
  if (start.status !== 200) throw new Error(start.reply.error || `Couldn't start linking (HTTP ${start.status})`);
  const { code = '', poll, interval = 3, expiresIn = 600 } = start.reply;
  await onCode?.({ code, url: start.reply.url ?? '' });

  const until = Date.now() + expiresIn * 1000;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error('Linking cancelled.');
    await sleep(interval * 1000);
    const r = await post(base, '/v1/link/poll', { poll });
    if (r.status === 202) continue;
    if (r.status === 200 && r.reply.token) {
      config.pushUrl = base;
      config.pushToken = r.reply.token;
      config.serverUrl ||= base;
      config.pushed = {}; // push everything once under the new owner
      saveConfig(config);
      return { battletag: r.reply.battletag };
    }
    throw new Error(r.reply.error || `Linking failed (HTTP ${r.status})`);
  }
  throw new Error('The link code expired before it was approved. Start again.');
}
