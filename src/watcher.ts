// Runs a sync when WoW writes the addon's SavedVariables (logout or /reload),
// and on a timer to pull fresh server prices. With pushUrl set, each sync also
// pushes changed SavedVariables to your hosted web server.
//
// Uses polling (stat every few seconds) rather than fs.watch: file events
// don't reach WSL for files on Windows drives, and polling is just as cheap here.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { listAccounts } from './wow.ts';
import { sync, resolveWowPath, type SyncSummary } from './sync.ts';
import { push, pushEnabled, type PushResult } from './push.ts';
import type { Config } from './config.ts';

const POLL_MS = 5000;
const SETTLE_MS = 3000; // wait for WoW to finish writing

interface WatcherEvents {
  log: [msg: string];
  state: [state: 'syncing' | 'idle'];
  sync: [summary: SyncSummary];
  push: [result: PushResult];
  error: [err: Error];
}

export class Watcher extends EventEmitter<WatcherEvents> {
  config: Config;
  mtimes = new Map<string, number>();
  running = false;
  pending = false;
  timers: ReturnType<typeof setInterval>[] = [];

  constructor(config: Config) {
    super();
    this.config = config;
  }

  log(msg: string): void { this.emit('log', msg); }

  snapshot(): string[] {
    const changed: string[] = [];
    const wowPath = resolveWowPath(this.config);
    for (const acct of listAccounts(wowPath)) {
      let mtime = 0;
      try { mtime = fs.statSync(acct.savedVariables).mtimeMs; } catch { /* not written yet */ }
      const prev = this.mtimes.get(acct.savedVariables);
      if (prev !== undefined && prev !== mtime) changed.push(acct.name);
      this.mtimes.set(acct.savedVariables, mtime);
    }
    return changed;
  }

  async syncNow(reason = 'manual'): Promise<SyncSummary | null> {
    if (this.running) { this.pending = true; return null; }
    this.running = true;
    this.emit('state', 'syncing');
    try {
      this.log(`Syncing (${reason})...`);
      const summary = await sync(this.config, { log: (m) => this.log(m) });
      for (const e of summary.errors) this.log(`Warning: ${e}`);
      this.emit('sync', summary);
      // then send the saved data to the hosted web server; unchanged files are skipped
      if (pushEnabled(this.config)) {
        const pushed = await push(this.config, { log: (m) => this.log(m) });
        for (const e of pushed.errors) this.log(`Warning: ${e}`);
        this.emit('push', pushed);
      }
      return summary;
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return null;
    } finally {
      this.running = false;
      this.emit('state', 'idle');
      if (this.pending) {
        this.pending = false;
        setTimeout(() => this.syncNow('queued'), 0);
      }
    }
  }

  start(): this {
    this.snapshot();
    void this.syncNow('startup');

    let settle: ReturnType<typeof setTimeout> | undefined;
    this.timers.push(setInterval(() => {
      let changed: string[];
      try { changed = this.snapshot(); } catch (err) { this.emit('error', err instanceof Error ? err : new Error(String(err))); return; }
      if (!changed.length) return;
      this.log(`Saved data changed for ${changed.join(', ')}.`);
      clearTimeout(settle);
      settle = setTimeout(() => this.syncNow('game saved data'), SETTLE_MS);
    }, POLL_MS));

    if (this.config.serverUrl) {
      this.timers.push(setInterval(() => this.syncNow('timer'), this.config.intervalMinutes * 60_000));
    }
    return this;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
