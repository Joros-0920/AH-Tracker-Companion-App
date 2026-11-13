# Changelog

All notable changes to the AH Tracker companion app are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-13

First release. A desktop companion for the AH Tracker addon for WoW Forever (`_forever_` client).

### Downloads

- `AH-Tracker-Setup-0.1.0.exe`: Windows installer with a Start menu entry and an uninstaller.
- `AH-Tracker-0.1.0-portable.exe`: a single file that runs without installing.

The builds aren't code-signed, so the first run shows "Windows protected your PC". Click **More info**, then **Run anyway**.

### Added

**Sync**
- Finds the WoW Forever folder and reads the addon's SavedVariables from every WoW account on the PC.
- Merges scans across your accounts and writes `Interface/AddOns/AHTracker/AppData.lua`, which the addon loads at login or `/reload`, so every character sees prices without scanning.
- Uploads new scans to a price server (`serverUrl`, on by default with `upload`) and downloads realm prices back. Pulls are incremental: each realm keeps a change counter (`cursor`), so only items that changed since the last pull are sent.
- Watch mode syncs as soon as the game saves (on `/reload`, logout or exit) and every `intervalMinutes` (default 30).
- `days` (default 30) sets how much history goes into `AppData.lua`.

**Tray app (Windows)**
- An Electron window that shows the AH Tracker web app (prices, charts, buy/sell signals, market resets, neutral AH deals and the Profit page), served by a built-in local server on port 4417 (or any free port).
- Closing the window keeps syncing in the tray. Tray menu: Open AH Tracker, sync status and last sync, Sync now, Open in browser, Link to website, Start with Windows, Open settings file, Reload settings, Open log, Open WoW folder, Quit.
- Settings live in `%APPDATA%\AHTrackerCompanion\config.json`.

**Command line (`ahtc`, `node src/cli.ts`)**
- `status`, `sync`, `watch`, `config` / `config set`, `install-addon`.
- `serve [--port N] [--host H] [--price-server]` runs the web app and its API locally; `--demo` uses made-up prices.
- `push [--force]` and `push-setup <url>` send changed SavedVariables to your own hosted server (`pushUrl` / `pushToken`).
- `link [url]` links the PC to a Battle.net login on the hosted site.
- `users` shows sign-up counts from the server database.

**Server (same code as the hosted copy)**
- Price API (`/v1/scans`, `/v1/realms`, `/v1/me`). Price data is stored as one JSON file per realm (`AHTC_DATA_DIR`).
- Optional Battle.net login (`openid` scope only) with per-PC device tokens, so everyone sees only their own trades on the Profit page while prices stay public. Linked PCs can be unlinked from the Profit page.
- Users and sessions in SQLite (`node:sqlite`); only a hash of each session cookie is stored.
- Push endpoint for SavedVariables, guarded by an upload token; unchanged files aren't sent again.

### Known limitations

- This repository holds only the companion app. Building the exe (`yarn dist`) also needs the web app's build (`../web/dist`), and `install-addon` copies the addon from `../AHTracker`; both live in the main AH Tracker project.
- Windows builds only. Building on Linux or WSL needs Wine.
- Not code-signed.

[0.1.0]: https://github.com/Joros-0920/AH-Tracker-Companion-App/releases/tag/v0.1.0
