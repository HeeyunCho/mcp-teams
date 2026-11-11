# Handoff: mcp-teams after #154 (updated 2026-11-11 on the Windows PC)

Repo: GitHub `HeeyunCho/mcp-teams`. PRs 1–4 of #123 (the native-messaging host) are on `main`, all **off by default** (`nativeHost` off). Next is PR 5, which turns it on. The last release is 0.3.66 (`367f198`, #154); 0.3.65 (`6504879`) has #150.

## Now (2026-11-11)

| PR | Change | State |
|---|---|---|
| #150 | Fixes #145: the relay-deadline test in `test/system/nativeHost.test.ts` runs the real 20 s heartbeat. The 200 ms test heartbeat (`TEAMS_MCP_HUB_KEEPALIVE_MS=200`) had cut connections that a loaded machine kept busy; under 20 busy loops on Node 20 it went from 5 failures in 30 runs to 0 in 30. Test only | Merged as `89cc4ad`, released in 0.3.65 (`6504879`) |
| #151 | The previous handoff (docs only) | Merged as `7fb6edb`, no release. Its Linux `test` job first failed on #152, passed on re-run |
| #154 | Fixes #153: the status read's log in `server.log` (below). Review: no blockers; 2 should-fix items fixed | Merged as `6f29a09`, released in 0.3.66 (`367f198`). Merged without waiting for more CI: its own CI had passed; locally unit/serverLog (28) and integration/diagnose (9) passed, and system/serverLog failed once on the #152 rotation race (not touched by #154), then passed 3 of 3 |

### #154, the status read log

- An unreadable read logs its kind and duration: `status=unreadable kind=<timeout|closed|not-connected|not-hub|aborted|error> ms=<n> failures=<n>`.
  - `bridge.ts` exports `NOT_READ`; the kinds come from the bridge's own message constants (`LOST_CALL.timedOut`, `NOT_READ`). The message texts are unchanged and never written.
- **Failures are counted:** logged on the 1st, every 10th, and when the kind changes. The first failure after an `extension-connected` or a `role` change is logged at once. The first read that works again logs `after=<n>`.
- Every `teams` line carries `ms`. A read slower than 2.5 s logs `slow=yes` even when nothing changed (the 1st and every 10th in a row). That covers `get_version`'s status read too, which waits up to 60 s.
- **The background read's timeout is 15 s, not 5 s.** It runs once a minute and holds no turn.
- **Account:** none → A is `first`, not a false `changed`; A → B is `changed`; a sign-out is its own `account=none` line.
- **Follow-ups (not blocking):**
  - a role-none server whose port is taken logs `kind=error`;
  - fast reads that change nothing leave no `ms`.

### #153, what the diagnosis found

- Every `unreadable` was the 5 s timeout, about 5.1 s after a tick of the 60 s timer. It was intermittent; a peer's `get_version` through the same hub seconds later read fine.
- Inferred cause (not proven): slow answers from the real Chrome worker, near the `extension-closed code=1001` closes that come every few minutes.
- The `account=changed` came from an earlier successful read with no account.

### Open bugs from today

- **#148** (`needs-triage`): the extension sends `hello` on a socket the hub closed during the pairing proof (`background.js:2138` in 0.3.60, `:2278` on main). Chrome logs "WebSocket is already in CLOSING or CLOSED state". The challenge handler checks `readyState` before awaiting the pairing token and proof. The user saw it again on the Errors page; those entries may be stale (old line numbers) until "Clear all".
- **#149** (follow-up from #145's review): keep-alive drops write no `hub.log` line. Other system tests on `FAST.keepAliveMs` (200 ms; linger, takeover, `extensionNative`) to audit one by one.
- **#152** (`bug`, `tests`): `server.log` rotation lost 3 of 3,000 lines on Linux CI with ten processes (`test/system/serverLog.test.ts`). It is the double-rotation window in `rotate()` (`src/hubLog.ts`): a process claims a small file, appends it back, and unlinks the claim after a late line landed in it. The issue lists three possible fixes.
- **#142** (`needs-triage`): an hourly Hub health report on 2026-11-10 17:44Z, `restartNeeded` with server 0.3.57 running and 0.3.58 on disk. That is the known stale-server case (#111/#96).

### csa/mt captures (in progress, no issue yet)

*Still waiting on the user's DevTools check as of 2026-11-11 15:00; no issue filed yet.*

- After sign-in only `chatsvc` was captured. `substrate` was captured from the Teams page at 12:49:54Z, so #129's `isTeamsOrigin` passes Teams' page requests. `csa` and `mt` stayed null.
- A read-only `list_teams` opened the helper tab. It made no signed-in call (only config, telemetry, `/manifest.json`) and failed after 82 s with "team list session is not available". The user's tab made no `chatsvc` call since 11:56:57Z.
- **Hypotheses:**
  - (a) the startup helper tab closes once `chatsvc` is captured, before `csa`/`mt` are called, and the user's tab predates the 0.3.65 extension update and never calls them again;
  - (b) Teams no longer calls `csa`/`mt` on every load.
- `api_traffic` uses the same `isTeamsOrigin` filter, so it can't tell "not called" from "rejected".
- **Waiting on** the user's Chrome DevTools Network check on the Teams tab: F5, filter `api/csa`, look at the Initiator.

### CI

- **GitHub Actions minutes** for the account are used up until 2026-12-01. CI may not run on new PRs (#154's did run and pass); merges before then may be without CI. Run the full local checks (typecheck, `npm test`, the Node 20 run) before merging.

## Merged earlier on 2026-11-11

| PR | Change | State |
|---|---|---|
| #144 | Fixes #138: on Windows, a printed command whose first word is quoted starts with `& `. cmd.exe rejects a leading `&`, so the hint adds "(PowerShell; in cmd.exe, leave out the leading &)". Review: no blockers, two test nits fixed (`c409dfb`) | Merged as `3bbd5ad`, released in 0.3.63 (`87ef6b8`) |
| #146 | #123 PR 4: setup registration, `batPath`, moved node / gone `hub.js` / missing HKCU key reporting, the `nativeMessaging` permission. Off by default | Merged as `347ec95`, released in 0.3.63 (`87ef6b8`) |
| #147 | Fixes #143: every server writes `~/.mcp-teams/server.log` | Merged as `aa2c1fa`, released in 0.3.64 (`bb24f47`). gitleaks first failed on the redaction test's made-up JWT (`test/unit/serverLog.test.ts:140`); it is in `.gitleaksignore` (`3689810`). Main was merged in for conflicts with #146 in `src/tools.ts` and `docs/testing.md` (`e8bdafe`) |

### The outage of 2026-11-11, 01:04–07:17 (CET)

- The user saw Teams not working from about 01:04 until the PC was restarted at 07:17. **Nothing recorded the cause:**
  - Claude Desktop's `%LOCALAPPDATA%\Claude\Logs\mcp-server-teams.log` had no tool calls and no errors between 23:19Z and 06:17Z, only a server restart at 02:30Z.
  - No Claude Code session called Teams.
  - Windows logs had nothing at 01:04. The Teams Meeting Add-in MSI repairs (00:55, 04:55) and the Claude VM service restart (03:30) aren't linked.
  - `~/.mcp-teams/hub.log` doesn't exist while `nativeHost` is off.
  - After the restart, `get_version` was healthy (session captured 06:19Z).
- Filed as **#143**; **#147** adds `~/.mcp-teams/server.log`.
- **Next outage: copy `~/.mcp-teams/server.log` (and `server.log.1`) BEFORE restarting or reconnecting anything.** Also Claude Desktop's teams log, and for #124 the service worker's state in `chrome://extensions` and `Get-NetTCPConnection -LocalPort 47393`.

### #147, `server.log`

- **Events:** `start`/`exit`, `role`, `handover`, `extension-connected` (with `ext=`), `extension-closed`, `extension-dropped reason=no-pong`, `handshake-closed` (4401/4403/4409/4426), `hub-closed`, `teams` on change (with `stale=`), `restart-needed`, failed tools and tools over 20 s.
- The hub reads the Teams state in the background every 60 s, so a night with no tool calls still shows the Teams state.
- Metadata only: fixed fields, each checked against a pattern; no message text, names, tokens or ids.
- **Rotation** (`src/hubLog.ts`, shared with `hub.log`): each process claims the file before moving it to `.1`. A real race lost lines before (967 of 3,000 kept). A claim that can't replace `.1` (for example antivirus holding it) stays aside as `<file>.<pid>-<random>.rotating`.
- **Follow-ups (not blocking):**
  - clean up old `.rotating` files;
  - a repeated refusal logs once, so "still failing" and "stopped trying" look the same;
  - 4401 is shared by a bad token and an auth timeout;
  - the native host (`dist/hub.js`) doesn't pass the new events;
  - `teams` lines repeat across pids, since each server's own `get_version` writes one.

### #146, #123 PR 4

- `nativeMessaging` in `extension/manifest.json` (without it `connectNative` is undefined in real Chrome, so PR 3 never ran natively).
- New `src/nativehost.ts`: a host manifest per browser, a launcher (`mcp-teams-hub.bat` on Windows) and HKCU keys for Chrome and Edge via `%SystemRoot%\System32\reg.exe`. `batPath` names paths through `%USERPROFILE%`/`%LOCALAPPDATA%`/`%APPDATA%`; a path still non-ASCII registers nothing.
- `get_version` gets a `nativeHost` field (`registered`, `nodeMissing`, `hubMissing`, `keyMissing`, `hint`) only with the switch on.
- The HKCU key is read with `reg export` (UTF-16LE file), because `reg query`'s output under code page 949 garbled a Hangul home path.
- **Follow-ups:**
  - **PR 5 must register by default together with the switch;**
  - switching off leaves an earlier registration in place;
  - with the switch on, `get_version` runs `reg.exe` twice synchronously (about 0.1 s each);
  - `refreshNativeHosts` (for `npm run update`) isn't ported;
  - the README doesn't cover the moved-node or non-ASCII path behaviour;
  - manual check: Chrome may warn about the new permission;
  - still open from the PR 3 review: 4403 reporting in `get_version`, and `transport: null` with no extension connected.

## Open issues and decisions

- **#123** (native host, `ready-for-agent`): PRs 1–4 merged (#127, #130, #140, #146). Not blocking, posted on #123:
  - from the PR 3 review: decision 9's `get_version` report of a 4403 isn't done (only the popup's `lastError`); `transport` is `null` with no extension; `skipNative` is one-shot; no deadline for the native welcome (main has the same gap for TCP); a native welcome failing its proof has its `lastError` overwritten by the TCP attempt; `Reassembler` has no unit tests and no limit on sets; style nits (`nativeFirst()` clears `skipNative`, `OPEN`/`CLOSED`, the hello parsed twice, a third `getVersion` test helper);
  - from the #130 reviews: the relay is a signing oracle for `client:socket` (not exploitable as far as seen); `sameText` duplicates `sameProof`; the handshake exists three times; during takeover a waiting response over 1 MB can trip the cap; commit messages `f32d2f3`, `eedcd82`, `6b66869` cite some wrong Outlook commits.
- **#77** (`ready-for-agent`): the test leftovers are done (#141). Still open: the unsure guard copied at four send paths, the hand-kept `READS` list, `sendTo`'s 12 parameters, and `OLD_TOKEN_WINDOW_MS` also setting how long the unsure state lasts. Nits from #141: 7/7c still race a real 1 s Retry-After if the process stalls over 1 s; the 2b `setTimeout` spy matches exactly 1000 ms; `requestWithTurn` has no `deadline`.
- **#103** (`ready-for-agent`): the three leftovers are done (#139). Still open: refactor notes from the #107 review (the `getVersion` test setup duplicated, `{at, host}` spelled out in four places, the "signed in" rule copied, `teamsCalls` naming three things) and behaviour notes (the 5-minute gap in the stuck rule, background-tab calls counting as Teams-tab calls).
- **#122** (`ready-for-human`): only the manual Chrome check after #129 is left:
  1. run `api_traffic` with `record: true`, use Teams search for a minute, call `api_traffic` again;
  2. confirm `substrate` and `chatsvc` are still captured. Close #122 once it passes.
  - Today both were seen captured from the Teams page (`chatsvc`, and `substrate` at 12:49:54Z), but not as this check; `csa`/`mt` were not (see "csa/mt captures" in Now).
- **#124** (`needs-info`): the extension stayed disconnected while a hub listened. The 2026-11-10 16:45 episode is in Earlier. `server.log` (#147) will show the `handshake-closed` and `extension-*` lines next time.
- **#111/#96** (`ready-for-human`): close with the native host and launcher (#123, ADR 0002). #142 is another instance.
- **#148, #149, #152:** see "Open bugs from today" in Now.
- **Closed:** #76 (#137), #134 (#136), #138 (#144), #143 (#147), #145 (#150), #153 (#154).
- **Outlook:** the pipe-name collision for non-ASCII usernames is mcp-newoutlook#178.

## Next up

1. **The csa/mt capture issue:** read the user's DevTools Network result, then file the issue (hypothesis a or b in Now) and fix it.
2. **Fixes for #148, #149 and #152.**
3. **#123 PR 5:** turn `nativeHost` on by default, with setup registering by default; `feat!:` → 0.4.0. It waits for the manual checks on Windows and the Mac (including Chrome's permission warning from #146). Read the #123 comments first.
4. **Versioned launcher (0.5.0, ADR 0002).** Open the issue from the ADR first.
5. The manual Chrome check on #122; `ready-for-agent` leftovers on #77 and #103 (above).

Run `gh issue list` for the full backlog. #21 and #96 are the umbrella issues that PRs reference as "Part of".

## This Windows PC (checked 2026-11-11)

- **Live install:** `C:\Orca_Project\mcp-teams` is the live install. Every session's `teams` server runs its `dist/index.js`, and Chrome's Teams extension loads a copy of its `extension/` folder.
  - Rebuilt on 2026-11-11 at 12:41 on 0.3.65 (`5ef6c32bb59a`). The user then reconnected every session (`C:\PM_HUB_DB` last), restarted Claude Desktop, reloaded the extension and signed in. All 12 servers ran 0.3.65 by 13:05; the hub moved to the NAVERWORKS session (pid 75600).
  - Rebuilt again after #154 at 14:54 on 0.3.66 (`367f198`, build `e06bb586f16f`). All 13 running servers predate it (Claude Code sessions in PM-HUB, Jev-Agentic-Loops, Downloads, system-manager, mcp-atlassian, local-plugins, mcp-teams, mcp-newoutlook, NAVERWORKS (the hub, pid 75600), C:PM_HUB_DB and one more started 14:38; Claude Desktop's two) and need `/mcp` → teams → Reconnect, the hub's session last.
  - **Watch out during hand-overs:** old servers kept taking port 47393 back. A new hub stepped down 0.3.58 hubs about 10 times in 3 s.
  - **Chrome loads the extension from `~/.mcp-teams/extension`,** which a *starting* server syncs from the checkout (`syncExtension` in `src/index.ts`). A rebuild alone doesn't update it. `node dist/index.js reload-extension` syncs it (on this PC it answers "hub restarted"; the extension reloads and reconnects within about 5 s). The `reload_extension` tool only reloads from the copy.
  - **Running servers keep their old code** until each session reconnects with `/mcp`. Reconnect the hub's session last; the hub moves between sessions. To list stale servers, compare each `node … mcp-teams/dist/index.js` process's start time with `dist/index.js`'s write time; `~/.claude/sessions/<parent pid>.json` gives a Claude Code session's folder.
  - After an extension reload no Teams session is captured until the Teams tab loads chats again.
- **Claude Desktop's teams log:** `%LOCALAPPDATA%\Claude\Logs\mcp-server-teams.log` (not `%APPDATA%`).
- **Memory:** often only about 2 GB of 27 GB free. Timing tests can then fail (`drain.test.ts` once on Node 20 during #147; #145 before #150); rerun the file alone.
- **Worktrees:** an Agent-tool worktree starts with an empty `node_modules`. Run `npm ci` in it before testing; otherwise vitest resolves from the main checkout.
- **Node versions:** default `node` is v26. `npx -y node@20` doesn't give Node 20 here (`npx -y node@20 -v` prints `v26.3.0`).
  - **For a real Node 20 run:** an unpacked v20.20.2 is at `C:\Users\조희연\AppData\Local\Temp\claude\4b73b95594a054db\17972b37-7e83-4ce8-8b9d-3b36d890ee62\scratchpad\node20\node-v20.20.2-win-x64\node.exe`. It's in a session scratchpad and may disappear; if so, get the official zip from nodejs.org, check it against `SHASUMS256.txt` and unpack it outside the repo.
  - Run `<node.exe> node_modules/vitest/vitest.mjs run --fileParallelism=false`, after checking that `node.exe -v` prints v20.
- System tests run the built `dist/hub.js`, so **run `npm run build` first**; a stale `dist/` fails the welcome test with the old `serverVersion`.

## Earlier

- **Merged on 2026-11-10,** each with a fresh-subagent review and CI: #133 (handoff, docs only), #135 (0.3.59, `msFromEnv()` takes only plain digits for `TEAMS_MCP_HUB_*_MS`, #123 nits), #136 (docs, fixes #134: the extension's `ERR_CONNECTION_REFUSED` lines are expected while no server listens), #137 (0.3.60, fixes #76: on Windows `quote()` double-quotes an argument with `'` or `;`), #139 (0.3.61, #103 leftovers), #141 (0.3.62, #77 test leftovers), #140 (0.3.62, #123 PR 3: the extension's `connectNative` first with TCP fallback, chunk joining in `extension/chunks.js`, `transport` in `get_version`).
- **#130, the native host (#123 PR 2),** merged 2026-11-10 as `05e027b` (0.3.58): `dist/hub.js` with Chrome's 4-byte framing and the 1 MB split; the serving and relaying host with the 30 s linger and `~/.mcp-teams/hub.log`; the peer-only TCP listener on 47393, which refuses extensions with 4403; the Windows pipe `\\.\pipe\mcp-teams-<ASCII>-<sha256 8 hex>`. Proofs are bound to their channel (`client`/`server`, `client:socket`/`server:socket`); a relaying host verifies the pipe's holder against its own nonce; the relay deadline is `569f39a`/`28ee536`, with tests in `c862dab`. The 0.3.52 test installs the real `mcp-teams@0.3.52` and checks the hand-over of 47393.
- **Merged on 2026-11-09/10:** #121 (0.3.53, the failed-call note's status read waits 3 s), #125 (0.3.54, the unsure account, #77), #127 (0.3.55, #123 PR 1, the transport interface), #129 (0.3.56, `captureSession` only from the Teams page, #122).
- **Merged on 2026-11-08:** #108 (0.3.49), #109 (0.3.50), #110 (0.3.51), #118 (0.3.52, the hub drains in-flight calls for up to 5 s, `TEAMS_MCP_DRAIN_MS`; closed #112). #112's leftovers: port citations name a PR, not a commit (ADR 0001 §7); a late queued send can flash its confirmation window; no test for a step-down during a drain; "drain" isn't in `GLOSSARY.md`; peers don't re-send refused calls through the next hub.
- **#124 episode, 2026-11-10 about 16:45:** Claude Desktop's teams server reported "Server teams unavailable", then ran 0.3.56 with the bridge "waiting for extension". Port 47393 had the hub (pid 30504, the mcp-atlassian session's server) and 8 connections, all mcp-teams servers, none from Chrome. About a minute later the extension was connected again; it isn't known whether by itself. `background.js:2104` in Chrome's console is the extension's `new WebSocket(...)`; an error there is most likely Chrome's connection-refused line while no hub listens (#134), so noise.
- **ADRs on main:** `docs/adr/0001-where-the-hub-lives.md` (native-messaging host plus TCP fallback) and `docs/adr/0002-versioned-launcher.md`, with their terms in `GLOSSARY.md`. Read them before any hub or launcher work. Delivery order: #112 drain (done) → #115 handshake (done) → native host (0.4.0) → launcher (0.5.0).
- **Releases are automatic.** `.github/workflows/version.yml` runs on every push to `main` except Markdown-only pushes: it bumps the version from the commit messages (`scripts/bump-version.mjs`), tags it, and publishes to npm with trusted publishing (OIDC). npm can take a minute or two to show it (`npm view mcp-teams version --prefer-online`).

## This Mac (checked 2026-11-08, about 08:10 local time)

- **Versions:** the hub on port 47393 and the extension both ran 0.3.52; the shared npx cache held 0.3.52. `get_version` reported `restartNeeded: false` and `versionsMatch: true`.
- **Teams session:** captured, all four services. After the extension reloaded its captures were empty, and its own recovery brought the session back within about 90 s.
- **Other sessions** (scion, MeetNotes, PM-HUB, local-plugins, mcp-newoutlook) ran old mcp-teams servers; they join as peers and pick up new code only when each reconnects.
- **Claude Desktop:** its teams log is `~/Library/Logs/Claude/mcp-server-teams.log`.

## How the user wants work done

- **Routing:**
  - do short mechanical work directly;
  - send reviews and research to subagents (the reviewer is never the author);
  - give a subagent that changes files its own worktree (`isolation: "worktree"`);
  - use Orca only for long parallel work.
- **Report** which way each task ran and what is left to review or merge.
- **Branch flow:**
  - branch from `main`;
  - if `main` moved, merge `main` into the branch (never rebase and force-push);
  - typecheck (`npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`), `npm test`, and the Node 20 run;
  - push.
- **PRs:**
  - open a PR with "Part of #21 and #96" (or whichever umbrella issue applies);
  - get a fresh-subagent review;
  - fix should-fix items that are small, and post the rest on the issue;
  - wait for CI (test, test-windows, gitleaks);
  - merge with a merge commit and `--match-head-commit <full 40-char SHA>`;
  - delete the remote and local branches;
  - remove a worktree only after its merge succeeded (`git worktree unlock` first for Agent-tool worktrees);
  - pull `main`.
- **Use git, not scn, until 2026-11-17** (see `~/.claude/CLAUDE.md`). Never print or use scn tokens or the admin token.
- **Attribution:**
  - commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Testing on this Mac

- **Check `uptime` first.** Other projects' test runs can push the load average to 500–850. A full local `npm test` then fails only timing tests (byteCache, heartbeat, meetings, sendWindow, watchdog), and each passes when its file runs alone.
- **When the load is high:**
  - typecheck;
  - run the touched test files on Node 22 and on Node 20 (`npx -y node@20 node_modules/vitest/vitest.mjs run --fileParallelism=false <files>`);
  - rerun a failure alone;
  - treat CI as the full run. Don't wait for the load to drop.
- **Gate a push on each command's own exit code** (`set -e`), never on a `| grep` of its output.

## Useful checks

- **Hub owner:** `lsof -nP -iTCP:47393` on the Mac, `Get-NetTCPConnection -LocalPort 47393` on Windows. The listener is the hub; Chrome's connection to it is the extension.
- **Live state:** the `teams` MCP tool `get_version` reports the server, extension and hub versions, the bridge state and `transport`, `restartNeeded`, the Teams session, and (with the switch on) `nativeHost`.
  - Without the tools, pipe `initialize`, then `notifications/initialized`, then a `tools/call get_version` into the server's `dist/index.js` (on the Mac, `node ~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/dist/index.js`). It joins the bridge as a peer.
- **Logs:** `~/.mcp-teams/server.log` (from 0.3.64; the `teams` line's `kind`/`ms`/`failures`/`after`/`slow` from #154); `~/.mcp-teams/hub.log` only with `nativeHost` on; Claude Desktop's teams log (paths above).
- **Versions on disk:**
  - `~/.mcp-teams/extension/manifest.json` (extension folder);
  - `~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/package.json` (the Mac's shared npx cache).

## Suggested skills

- `grill-with-docs` (calls `grilling` and `domain-modeling`): before opening the launcher issue.
- `tdd`: for each implementation issue.
- `code-review`: review each branch in a fresh subagent before merge.
- `diagnosing-bugs`: if Teams or the bridge breaks again; start from `server.log`.
- `orca-cli`: only for long parallel work.
