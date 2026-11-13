# AH Tracker companion

A desktop companion for the **AH Tracker** addon for WoW Forever. It runs in the background while you play and:

- reads the addon's saved scans from every WoW account on your PC,
- merges them, so each of your characters sees prices scanned by the others,
- writes `Interface/AddOns/AHTracker/AppData.lua`, which the addon loads at login or `/reload`,
- shows prices, charts, buy/sell signals and your profit in its own window.

Optionally, it can also share scans with a price server and download prices from it (see [Settings](#settings)).

## Install (Windows)

1. Download the latest release from the [Releases page](https://github.com/Joros-0920/AH-Tracker-Companion-App/releases):
   - `AH-Tracker-Setup-<version>.exe`: an installer, with a Start menu entry and an uninstaller, or
   - `AH-Tracker-<version>-portable.exe`: a single file that runs without installing.
2. Run it. The builds aren't code-signed, so Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.
3. The app finds your WoW Forever folder (`_forever_`) by itself. If it doesn't, set `wowPath` (see [Settings](#settings)).

The AH Tracker addon has to be installed in WoW too, in `World of Warcraft/_forever_/Interface/AddOns/AHTracker`.

### Using it

- Play as normal and scan the Auction House with the addon. When the game saves (on `/reload`, logout or exit), the app picks up the new scans and writes `AppData.lua`. Your other characters see the prices after their next login or `/reload`.
- Closing the window keeps it running in the tray. Click the tray icon to open it again.
- The tray menu has **Sync now**, **Start with Windows**, **Open settings file**, **Reload settings**, **Open log**, **Open WoW folder** and **Quit**.

## Run from source

Needs [Node.js](https://nodejs.org/) 22.18 or newer. The app is TypeScript that Node runs directly, so there's no build step for the command line.

```
git clone https://github.com/Joros-0920/AH-Tracker-Companion-App.git
cd AH-Tracker-Companion-App
```

### Command line

The command line has no runtime dependencies, so it works without `yarn install`:

```
node src/cli.ts status      # the WoW folder, accounts and last sync it found
node src/cli.ts sync        # sync once and write AppData.lua
node src/cli.ts watch       # keep syncing while you play (Ctrl+C to stop)
node src/cli.ts config      # show settings
node src/cli.ts config set wowPath "C:\Games\World of Warcraft\_forever_"
node src/cli.ts help        # every command
```

It also works from WSL. It finds WoW under `/mnt/c/...` and checks file timestamps, because file-change events from Windows don't reach WSL.

### Desktop app

Run this from a Windows terminal, in a copy of the repo on a Windows drive (Electron doesn't run reliably from a `\\wsl$` path):

```
yarn install
yarn tray
```

[Yarn](https://yarnpkg.com/) 4 is checked in under `.yarn/releases`, so any `yarn` (or Corepack) uses the right version.

The window shows the AH Tracker web app. That's a separate project, and its build (`web/dist`) isn't in this repo. Without it, the tray app still syncs, but the window says the web app isn't built. Use the installer from the Releases page if you want the window.

### Build the installer

From a Windows terminal, with the web app's build next to this folder at `../web/dist`:

```
yarn install
yarn dist
```

It writes `AH-Tracker-Setup-<version>.exe` and `AH-Tracker-<version>-portable.exe` to `release/`. `yarn dist:dir` makes an unpacked build in `release/win-unpacked` instead, which is quicker for testing. Bump `version` in `package.json` for each release, and add it to [CHANGELOG.md](CHANGELOG.md).

## Settings

The settings file is `%APPDATA%\AHTrackerCompanion\config.json` on Windows, or `~/.config/ah-tracker-companion/config.json` on Linux and WSL. Change settings with `node src/cli.ts config set <key> <value>`, or edit the file and choose **Reload settings** in the tray menu.

| Key | Default | Meaning |
|---|---|---|
| `wowPath` | found automatically | Path to the `_forever_` folder |
| `days` | 30 | Days of price history to put in `AppData.lua` |
| `intervalMinutes` | 30 | How often to sync while running, besides syncing whenever the game saves |
| `serverUrl` | none | A price server to share scans with. Each sync uploads your new scans and downloads the prices that changed since the last sync |
| `upload` | true | Send your scans to `serverUrl` (set to false to only download) |

Without `serverUrl`, nothing leaves your PC: the app only merges scans across your own accounts.

`apiKey` is created on first run. It identifies this install to a price server; your account names are never sent.

## Development

```
yarn install
yarn test        # node:test, straight from the .ts files
yarn typecheck   # tsc, type checking only
yarn lint        # oxlint; yarn lint:fix fixes what it can
yarn check       # all three
```

The TypeScript has to stay runnable by Node's type stripping: imports use `.ts` extensions, type-only imports use `import type`, and there are no enums, namespaces or parameter properties (`erasableSyntaxOnly` in `tsconfig.json` enforces this).

The tests cover the Lua parser, history merging, a full sync against a fake server, and the local server.

## License

MIT
