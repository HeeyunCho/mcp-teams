---
status: accepted
date: 2026-11-06
---

# Where the hub lives: a native host started by the browser, with the TCP hub as fallback

Today the **hub** is whichever **session** first binds `127.0.0.1:47393` (`src/bridge.ts`). Its lifetime and its code version are that one AI session's. We decided to move the hub into a **native host** that Chrome or Edge starts for the extension (native messaging). We keep the in-session **TCP hub** as the fallback, and the native host moves itself to a new version without a session or browser restart. This ports mcp-newoutlook's ADR 0001 (option B), plus a version switch that Outlook doesn't have. It answers #96 option (c) and the hub item of #21. The maintainer accepted it in a grilling session on 2026-11-06.

## Why

The hub's tie to one session causes every recurring Teams outage we have seen:

- **A release leaves an old hub in charge** (#96, #111). Servers keep the code they started with. Claude Desktop and Claude Code start `npx -y mcp-teams@latest`, and all of them share one npx cache. The first new session after a release reinstalls that cache underneath the running servers. On 2026-11-06 the hub kept running 0.3.43 with 0.3.46 on disk (`restartNeeded: true`), the extension stayed disconnected, and only restarting Claude Desktop plus reloading the Teams tab brought Teams back. Adding `teams` to a second Claude config the same day reproduced this on its own.
- **The handover after an update fails the extension's reload.** The Desktop log showed `extension update needs a reload in the browser: The mcp-teams hub restarted`. #113 fixes the extension half: it reloads itself, and the server retries a reload that failed. The server half needs this ADR.
- **Closing a session fails other sessions' calls**, including an open send confirmation window. #112 takes the edge off this before the native host lands.
- **The extension trusts whoever binds the port first.** The pairing proof (`proof()` in `src/bridge.ts`) guards it, but the port can still be squatted.

A native host lives exactly as long as the browser has the extension running, which is the only time Teams can be reached anyway. Chrome starts it only for the extension ids in the host manifest's `allowed_origins`.

## Decision

1. **The hub is a native host** (`com.mcp_teams.hub`) that `setup` registers for Chrome and Edge on macOS, Windows (through the registry) and Linux. Teams has its own host and socket, separate from Outlook's: `~/.mcp-teams/hub.sock` (0600 in a 0700 folder), or the named pipe `\\.\pipe\mcp-teams-<user>` on Windows, where peers still send the pairing proof. Sessions' servers are **peers** of it over that socket.
2. **The first host to bind the socket is the serving host.** Another browser, or a reconnect while the old host lingers, starts a **relaying host**, which passes its extension's messages to the serving host. This works as in Outlook's `docs/native-messaging.md`.
3. **The TCP hub stays as the fallback.** The extension tries `connectNative` first and falls back to `ws://127.0.0.1:47393` when the port fails before a `welcome`. The config switch `"nativeHost": false` keeps everything on TCP, for profiles whose policy blocks native messaging and as a way back if the host misbehaves.
4. **The native host also listens on 127.0.0.1:47393, for peers only.** Servers from before the native host know only that port. If they found it free, they would become a TCP hub that no extension ever joins. The host refuses any extension on that port; peers prove the token there as today.
5. **A running host moves itself to a new version** (Outlook's never does). The host compares the build it runs with what its host entry would start now: first the build id in `dist/build.json` next to it (#96, #100), and once the launcher lands, the version `current` names (ADR 0002). It looks every 60 s and whenever a peer of a newer version joins. When the build is newer and the host is idle, with nothing in flight and no send confirmation window open, it hands over:
   - **Serving host, no relay:** it closes the hub socket and exits. The extension sees its native port close and calls `connectNative` at once, so the browser starts the new version, which becomes the serving host. Peers reconnect to the socket. A call that arrives during the gap of a second or two fails with the existing "try again" message (`LOST_CALL.hubRestarted`).
   - **Serving host with a newer relaying host:** a serving host that sees a relaying host of a newer version, for example after the extension reloaded itself (#113), hands over to it the same way. Otherwise a relaying host counts as a connected extension, and the old serving host would never exit.
6. **The capabilities handshake (#21) comes first.** `hello` and `welcome` declare `native`, `maxMessageBytes` and `hostSwitch`, and each side uses a feature only when the other declares it. `get_version` shows both sides and the transport (`native` or `websocket`).
7. **The code is copied and adapted from mcp-newoutlook, not shared.** The Teams bridge has drifted too far: fair-queue turns, the throttle's gate-wait and gate-open, and the send-window rules. Every ported file names its Outlook source file and commit, so fixes can be carried across by hand. Teams has no binary path, so Outlook's streamed downloads and upload chunking are left out. Splitting host-to-extension messages over Chrome's 1 MB limit stays.

## Delivery

Each step is its own PR, with a failing test first (`docs/testing.md`):

1. **#112:** the hub drains on session end (the cheap half of Outlook's option A). 0.3.x.
2. **The capabilities handshake (#21).** 0.3.x.
3. **The native host:** host entry `dist/hub.js`, a transport interface in `bridge.ts`, the relaying host, the peer-only TCP listener, the version switch on the build id, `setup` registration on each OS, and the extension's native-first connect. **0.4.0.**
4. **The launcher (ADR 0002, written before its code):** a versioned **store** (`~/.mcp-teams/versions/<v>`), a `current` pointer, a background npm check, a selftest before switching, rollback, bad-version marks, and pruning. The version switch then follows `current`. **0.5.0.**

`setup` alone moves the AI apps' entries from `npx -y mcp-teams@latest` to the **launcher**; servers never edit AI app configs on their own. `get_version` says "run setup" when a server was started through npx.

## Considered options

- **A. Keep the hub in the session and drain on exit.** It is a small change, but the AI client may kill the process within seconds. It fixes neither a hub stuck on old code nor the trust model. We are doing it anyway as step 1 (#112), as a stopgap.
- **C. A detached background hub with a lock file.** It is independent of both sessions and browser. But it brings stale locks, an old hub to restart on update, logs to place, and a process that outlives the user's sessions, and the extension would still trust whoever holds the port.
- **B as Outlook has it, without the version switch.** Rejected: a running Outlook host keeps its version until the browser restarts or the extension reloads (Outlook `docs/native-messaging.md`, *Host implementation notes*). That is the #111 failure again.
- **Launcher before host.** It would fix the npx overwrite sooner, but it puts the larger, riskier half first: in Outlook, about 1,250 lines of code plus 2,000 of tests, with clock-skew and Windows-path bugs after release. The version switch also has nothing to act on until a host exists.

## Consequences

- `setup` writes OS-specific files: host manifests per browser, a host launcher script, and registry keys on Windows. Outlook found that a Windows `.bat` must not contain non-ASCII paths (code page 949) and that moving node.exe (nvm, fnm) breaks the host until setup runs again. Teams inherits both, and its setup must report them.
- Messages from the host to the extension must stay under 1 MB per frame (Chrome's limit); larger ones are split.
- Tests add a fake native-messaging peer (Chrome's 4-byte length framing) for `dist/hub.js`, and system tests on each OS. A manual check per OS confirms that Chrome starts the host and that `get_version` shows `transport: "native"`.
- Until a session restarts, old peers keep working through the peer-only TCP listener. Old servers can't use the native host's features.
