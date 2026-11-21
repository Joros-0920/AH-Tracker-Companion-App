# Changelog

All notable changes to the AH Tracker companion app are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.1] - 2026-11-21

### Added

- `GET /v1/recipes`: the recipes your addon recorded in profession windows, and what vendors charge for reagents, for the web app's Writs view. Private like trades: the hosted server needs you to log in, and only gives you your linked PCs' recipes.
- Demo data has three Craftsman's Writs and two recipes.

## [1.1.0] - 2026-11-21

### Added

- Item details for the web app: each item's icon, quality and in-game tooltip. `GET /v1/items?ids=…` answers with icon and quality, plus the tooltip with `tooltips=1`. The hosted server looks items up in Blizzard's Game Data API with its Battle.net login (Classic Era data first, then retail; `BLIZZARD_NAMESPACES` changes that) and keeps them in `items.json`, since they never change. The app asks the price server at `serverUrl` instead. New lookups are limited per IP address.
- Realms are keyed by ruleset and faction (`PvP-Alliance`, `Normal-Horde`, `RP-PvP-Neutral`), to match addon 1.0.6. Old keys such as `CAMWOWUS2Realm8PvP-Alliance` are mapped to their ruleset wherever they come in: uploads, pushed SavedVariables and requests. So older addons and companions keep working. On startup, the price server merges realm files saved under old keys into their ruleset's file.
- `/v1/realms/:realm/prices?item=ID` answers with one item's history. The web app loads the list with 30 days of history, and fetches an item's full history only when you pick a chart range longer than that.
- Watchlist alerts: the app reads the addon's watchlist (`/aht watch`) and shows a desktop notification when a price pulled from the server is at or under your price. It skips your own scans and alerts once per new scan. Turn it off with `alerts false`.
- `/v1/realms/:realm/prices` now includes `sales` (the addon's sell-rate estimate per item) and each item's vendor price in `names[id].v`. The price server keeps vendor prices from uploads.
- Demo data has sell rates, a few vendor flips and item categories.
- Item categories: the app passes each item's category (`names[id].c`) and the game's category names (`classes`) to the web app and the price server.
- Price server: protection against fake uploads. Scans from unlinked PCs are anonymous and only fill in hours no linked PC reported (`AHTC_ANON_UPLOADS=fallback`; `off` refuses them). A report 3× off what other uploaders reported over the day before is dropped unless someone agrees. Anonymous uploads are limited per IP address too, and can't set vendor prices or rename items.
- `ahtc reports <realm> <itemID>` shows who reported what and whether it counted; `ahtc ban`, `unban` and `bans` manage bans. Bans take effect on a running server within 10 seconds and remove the banned uploader's reports.

### Changed

- The server gzips JSON answers and web app files for clients that accept it. A realm's prices are megabytes of very repetitive text, so they come down several times smaller.
- Vite's hashed files under `/assets` are cached by the browser for good (`immutable`); `index.html` is checked on every load, so a new build still shows up.
- A full prices answer is built once and reused until the realm's data changes (or for 60 seconds at most), instead of being rebuilt and zipped for every browser that reloads after a scan.
- The price server (`ahtc serve --price-server`) writes realm files at most every 5 seconds, batching the uploads that arrive in between, instead of rewriting a realm's whole file on every upload. Pending writes are saved on Ctrl+C and SIGTERM.

### Fixed

- Item quality -1, which the addon saved for items the game hadn't loaded during a full scan, counts as unknown instead of Common. An unknown quality no longer replaces a known one, either from an upload or when your own data is merged with the server's.
- Uploads for realm keys with no realm name (`-Alliance`, `Unknown-Horde`), which old addons saved after WoW Forever's 2026-11-20 client update, are refused. They no longer show up as a realm called just "Alliance".
- A sync no longer warns when the server has no prices yet for one of your realms, for example a new character's.

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

[1.1.1]: https://github.com/Joros-0920/AH-Tracker-Companion-App/releases/tag/v1.1.1
[1.1.0]: https://github.com/Joros-0920/AH-Tracker-Companion-App/releases/tag/v1.1.0
[0.1.0]: https://github.com/Joros-0920/AH-Tracker-Companion-App/releases/tag/v0.1.0
