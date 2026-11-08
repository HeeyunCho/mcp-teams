---
status: accepted
date: 2026-11-06
---

# A versioned launcher: installed versions side by side, switched by a pointer, updated in the background

The AI apps and the native host (ADR 0001) will start a **launcher**, `node ~/.mcp-teams/launch.cjs`, instead of `npx -y mcp-teams@latest`. The launcher runs the version that the **store** (`~/.mcp-teams/versions/<v>`) names as current. A background check installs a new release next to the others, selftests it, and only then switches the pointer. A version that fails to start is set aside, and `rollback` goes back. This is mcp-newoutlook's launcher copied and adapted. It is step 4 of ADR 0001 (0.5.0), and the maintainer accepted it in a grilling session on 2026-11-06 (Q17–Q22).

## Why

- **npx overwrites code under running servers.** Every session and Claude Desktop start `npx -y mcp-teams@latest`, and all of them share one npx cache. The first new session after a release reinstalls that cache in place under the servers still running. This is #111: on 2026-11-06, a server running 0.3.43 had 0.3.46 on disk and the extension stayed disconnected. The same day, adding `teams` to a second Claude config reproduced it here. A store never changes a version's folder once it is installed.
- **A bad release would break every session at once.** Without a selftest before the switch and a way back, auto-update turns one broken publish into an outage everywhere. Outlook already found and fixed what goes wrong when this is built: clock skew (#124, #128, #130), Windows antivirus holding the new folder, and stale locks.
- **The native host needs a stable entry point.** Chrome starts whatever the host manifest names. `launch.cjs hub` follows `current`, so an update never rewrites the host registration.

## Decision

1. **Copy, don't share** (as ADR 0001 decided). Teams copies and adapts `src/launch.cts`, `src/updater.ts`, `src/autoupdate.ts` and the store parts of `src/setup.ts` from Outlook's latest main, together with every later fix. Env names become `TEAMS_MCP_*` and the home becomes `~/.mcp-teams`. Each file names its Outlook source commit.
2. **The store and its pointer.**
   - Versions live in `~/.mcp-teams/versions/<v>/node_modules/mcp-teams`. A version counts only when it is x.y.z and has its `dist/index.js`.
   - `current` holds `{format, version, previous}` and is written by temp file plus rename.
   - Also under the home: `update/state.json` and `update/lock` (stale when dated more than 10 min in the past or the future), and health markers (`starting`, `running`, `ok`, `bad`).
3. **Each start.** `launch.cjs` takes `current`, or else the newest version installed. It skips **bad versions**: a version with 3 failed starts is set aside unless it is the last good one, and the newest runs when every version is bad. It runs the chosen version in the same process with `import()`, not a child process, because Windows doesn't end children cleanly. It sets `TEAMS_MCP_LAUNCHED=<v>`. The server records a good start once it has answered `initialize`.
4. **Updates are on by default.**
   - Timing: 5 s after `initialize` and then every hour, a server started by the launcher asks npm for the latest release, at most every 12 h and backing off to 96 h after failures.
   - Install: a newer release goes into `versions/<v>.tmp` with `npm install --ignore-scripts --omit=dev`, running `node npm-cli.js`, never `npm.cmd`.
   - Selftest: the new version is started with `selftest` in an isolated temp home on a free port. It must answer `initialize` and `tools/list` within 20 s. A selftest never starts the bridge and never touches the extension folder.
   - Switch: the folder is renamed into place, retried for about 10 s for antivirus, and `current` is switched. Old versions are pruned, keeping current, previous, the running version and any version a live process started from.
   - Off with `TEAMS_MCP_NO_UPDATE=1` or `"autoUpdate": false`. Also off, with the reason shown in `get_version`, when npm isn't found or the server wasn't started by the launcher.
5. **Rollback.** `npx mcp-teams rollback [v]` (or `launch.cjs rollback [v]`) takes the update lock, marks the current version bad and switches to the version given, else `previous`, else the newest good one below.
6. **"Restart needed" means what the entry would start now.** A launcher-started server reports `restartNeeded` with `nextStart: <v>` when `current` names a version other than the one it runs. A clone or an npx start keeps today's `build.json` comparison (`src/buildInfo.ts`). One function answers "what would my entry start now?", and it drives three things: `get_version`, the tool-error hint, and the native host's version switch (ADR 0001 decision 5). Without this, a store install never reports a restart, because its own `dist/` never changes.
7. **Only a running version updates the extension folder.** A server or native host that starts on a version updates `~/.mcp-teams/extension` from its own package, never downgrading, as today (`src/index.ts`). The background updater never touches the folder. The extension then reloads itself (#113), and by then the host that updated the folder is already running, so the extension is never ahead of every server.
8. **Only `setup` moves the AI apps** (ADR 0001). For an installed copy, setup prepares the store, seeding it from the running copy or through npm. It then writes `node <home>/launch.cjs` into Claude Desktop and Claude Code, and `launch.cjs hub` into the host manifest. It never moves an app back to npx once the store is ready. Setup also finds a Microsoft Store (MSIX) Claude Desktop under `Packages\Claude_*\LocalCache\Roaming\Claude` (Outlook #158); Teams' setup looks only in `%APPDATA%\Claude` today. A server started through npx fills the store in the background for a later setup, but never edits app configs. `get_version` tells such a server to run setup.
9. **Clones skip the launcher.** A git clone (no `node_modules` in its path) registers its own `dist/index.js` and `dist/hub.js` with the AI apps and the host. It never uses the store or auto-update, so a developer runs what they built.

## Considered options

- **Store and pointer only, filled by npx-started servers, no npm calls of its own.** Rejected: once setup points the apps at `launch.cjs`, nothing runs npx any more, so updates would stop.
- **No launcher: point the host and apps at the npx cache.** Rejected: that keeps the in-place overwrite that caused #111.
- **Auto-update off by default.** Rejected: users would stay on old versions, which is the failure the launcher exists to end. The selftest and rollback make it safe to have it on.
- **The updater syncs the extension folder when it switches.** Rejected: the extension could then run ahead of every server, before any of them restarted.

## Consequences

- One `restartNeeded` source with two answers (the pointer, or the build id) replaces today's build-id-only check, and get_version shows `nextStart` and `updates` (on, or why off).
- `PACKAGED_EXTENSION_DIR` and `BUILD_DIR` stay relative to the running `dist/`: each version carries its own extension and build info, which is what decision 7 relies on.
- Tests copy Outlook's layers: unit tests (launch, updater, autoupdate), integration (updater), and system tests (launcher, updater, a non-ASCII home). Every OS path runs on temp homes. Outlook's launcher-cost test was flaky under load (#159); budget its timings as Outlook later did.
- Moving node.exe (nvm, fnm) still breaks `launch.cjs` entries until `setup` runs again. As in Outlook, setup and the README say so.
