// Tray app: the companion's Watcher plus a window showing the web app.
// The window loads the same server and web/dist build as `ahtc serve` and the hosted
// copy, so the desktop app and the website are one UI. All the real work is in src/.
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, configDir, type Config } from '../src/config.ts';
import { Watcher } from '../src/watcher.ts';
import { resolveWowPath } from '../src/sync.ts';
import { startServer, webBuilt } from '../src/serve.ts';
import { linkPC } from '../src/link.ts';
import { errorMessage } from '../src/errors.ts';

if (!app.requestSingleInstanceLock()) app.quit();

let tray: Tray | null = null;
let watcher: Watcher | null = null;
// set by restart(), which runs before anything reads it
let config!: Config;
let server: Server | null = null;
let win: BrowserWindow | null = null;
let serverUrl: string | null = null;
let quitting = false;
let linking: AbortController | null = null; // while a link waits for approval
let state = 'Starting...';
let lastError: string | null = null;
const icon = nativeImage.createFromPath(path.join(import.meta.dirname, 'icon.png'));
// installed: the web app ships in resources/web (see "build" in package.json); from the repo: web/dist
const webDist = app.isPackaged ? path.join(process.resourcesPath, 'web') : undefined;
const logFile = () => path.join(configDir(), 'companion.log');

function log(msg: string): void {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  try { fs.appendFileSync(logFile(), line + '\n'); } catch { /* ignore */ }
}

function when(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : 'never';
}

const NOT_BUILT = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<body style="font:15px system-ui;padding:2em;color-scheme:light dark">
<h2>The web app isn't built yet</h2>
<p>In the repo's <code>web</code> folder run <code>yarn install</code> and <code>yarn build</code>
(or <code>yarn build:web</code> in <code>companion</code>), then pick <b>Reload settings</b> in the tray menu.</p>`)}`;

function loadPage(): void {
  if (!win || !serverUrl) return;
  // keep the realm/item the window was on
  const hash = win.webContents.getURL().split('#')[1];
  void win.loadURL(webBuilt(webDist) ? serverUrl + (hash ? '#' + hash : '') : NOT_BUILT);
}

function showWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: 'AH Tracker',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // links out of the app (Wowhead etc.) open in the real browser
  win = w;
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (serverUrl && !url.startsWith(serverUrl)) { e.preventDefault(); void shell.openExternal(url); }
  });
  // closing the window hides it; the app keeps syncing in the tray
  w.on('close', (e) => { if (!quitting) { e.preventDefault(); w.hide(); } });
  w.on('closed', () => { win = null; });
  loadPage();
}

function buildMenu(): Menu {
  const s = config.lastSummary;
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open AH Tracker', click: showWindow },
    { type: 'separator' },
    { label: `AH Tracker: ${state}`, enabled: false },
    { label: `Last sync: ${when(config.lastSync)}`, enabled: false },
  ];
  if (s) items.push({ label: `${s.items} items on ${s.realms} realm(s)`, enabled: false });
  if (lastError) items.push({ label: `Error: ${lastError.slice(0, 80)}`, enabled: false });
  items.push(
    { type: 'separator' },
    { label: 'Sync now', click: () => void watcher?.syncNow('manual') },
    { label: 'Open in browser', enabled: !!serverUrl, click: () => { if (serverUrl) void shell.openExternal(serverUrl); } },
    linking
      ? { label: 'Cancel linking', click: () => linking?.abort() }
      : {
        label: config.serverUrl || config.pushUrl ? 'Link to website...' : 'Link to website (set serverUrl first)',
        enabled: !!(config.serverUrl || config.pushUrl),
        click: () => void startLink(),
      },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Open settings file', click: () => void shell.openPath(path.join(configDir(), 'config.json')) },
    { label: 'Reload settings', click: () => void restart() },
    { label: 'Open log', click: () => void shell.openPath(logFile()) },
    {
      label: 'Open WoW folder',
      click: () => { try { void shell.openPath(resolveWowPath(config)); } catch (err) { lastError = errorMessage(err); refresh(); } },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

// Opens the site to approve this PC, then waits for it (see src/link.js).
async function startLink(): Promise<void> {
  linking = new AbortController();
  refresh();
  try {
    const { battletag } = await linkPC(config, null, {
      signal: linking.signal,
      onCode: ({ url }) => { log(`Linking: approve this PC at ${url}`); void shell.openExternal(url); },
    });
    log(`Linked to ${battletag}`);
    if (Notification.isSupported()) new Notification({ title: 'AH Tracker', body: `This PC is linked to ${battletag}. Your trades will show on the site after the next push.` }).show();
    linking = null;
    await restart();
    void watcher?.syncNow('linked');
  } catch (err) {
    log(`Linking failed: ${errorMessage(err)}`);
    lastError = `Linking: ${errorMessage(err)}`;
    linking = null;
    refresh();
  }
}

function refresh(): void {
  if (!tray) return;
  tray.setToolTip(`AH Tracker companion: ${state}`);
  tray.setContextMenu(buildMenu());
}

async function restartServer(): Promise<void> {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  serverUrl = null;
  try {
    // local only, no uploads; another free port if `ahtc serve` already has 4417
    ({ server, url: serverUrl } = await startServer(config, { fallback: true, pushToken: null, webDist }));
    log(`Web app at ${serverUrl}`);
  } catch (err) {
    log(`Web server failed: ${errorMessage(err)}`);
    lastError = `Web server: ${errorMessage(err)}`;
  }
  loadPage();
}

async function restart(): Promise<void> {
  watcher?.stop();
  config = loadConfig();
  lastError = null;
  watcher = new Watcher(config);
  watcher.on('log', log);
  watcher.on('state', (s) => { state = s === 'syncing' ? 'Syncing...' : 'Watching'; refresh(); });
  watcher.on('sync', (summary) => {
    lastError = summary.errors[0] || null;
    if (summary.wrote && Notification.isSupported()) {
      new Notification({ title: 'AH Tracker', body: `Prices updated for ${summary.items} items. Type /reload in game to load them.` }).show();
    }
    refresh();
  });
  watcher.on('error', (err) => {
    log(`Error: ${err.message}`);
    lastError = err.message;
    state = 'Needs attention';
    refresh();
  });
  watcher.start();
  await restartServer();
  refresh();
}

app.on('second-instance', showWindow);
app.on('activate', showWindow); // macOS dock click
app.on('before-quit', () => { quitting = true; });
// Keep running in the tray with no windows open: having a listener at all stops the default quit.
app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  await restart();
  // started with Windows: stay in the tray; started by hand: show the app
  if (!process.argv.includes('--hidden')) showWindow();
});
