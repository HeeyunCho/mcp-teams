# Handoff: mcp-teams after #130, the native host (updated 2026-11-10 on the Windows PC)

Repo: GitHub `HeeyunCho/mcp-teams`. Branch `main`: **#130** (PR 2 of #123, the native host) is merged as `05e027b`, on top of 0.3.57 (#132, `.gitattributes` with LF). The release workflow cuts the next version from that merge. No code PRs are open.

## Merged on 2026-11-09/10

Each had a fresh-subagent review with no blockers and passed CI on Linux and Windows (test, test-windows, gitleaks).

| PR | Change | Release |
|---|---|---|
| #121 | The failed-call note's status read waits 3 s, not 60 s; tests for its `connected`/`signal` branches; `failedCallNote`/`isMissingSession` unit-tested (Part of #103) | 0.3.53 |
| #125 | **Unsure account** (#77): any capture of the previous account within 30 s of a switch marks the account unsure, and sends are refused. Reads carry `accountNote`, `get_version` shows `accountUnsure`, and `tokenIssuedAt` reads the same token as `tokenOid` | 0.3.54 |
| #127 | PR 1 of #123: a transport interface in `src/bridge.ts` (`BridgeSocket`, `BridgeTransport`, `webSocketTransport`), a refactor with no change in behaviour | 0.3.55 |
| #129 | #122 item 1: `captureSession` stores or refreshes a session only from the Teams page (`isTeamsOrigin`), so an Outlook tab's `substrate.office.com` requests no longer move `services.substrate` or replace Teams' capture | 0.3.56 |

**After #129, check once in real Chrome:**
1. Run `api_traffic` with `record: true` and use Teams search.
2. Confirm that `substrate` and `chatsvc` are still captured.

If Teams ever sent a captured-service request from another origin, it would no longer be captured.

## Merged: PR #130, the native host (#123 PR 2)

- **Merged** on 2026-11-10 as `05e027b` (merge commit, head `c862dab`), after CI passed (test, test-windows, gitleaks). The branch `feat/123-native-host` and its worktree are deleted.
- **What:**
  - `dist/hub.js`, with Chrome's 4-byte framing and the 1 MB split;
  - the serving and relaying host, with the 30 s linger and `~/.mcp-teams/hub.log` (metadata only);
  - the peer-only TCP listener on 47393, which refuses extensions with 4403;
  - the Windows pipe `\\.\pipe\mcp-teams-<ASCII>-<sha256 8 hex>`;
  - the interface additions.
- **Off by default:** `nativeHost` is off, so with it off every server path runs as on `main` (the reviews' gate).
- **The 0.3.52 test:** it installs the real `mcp-teams@0.3.52` from npm. The old hub hands port 47393 over to the host and passes on both Node versions.
- **Reviews:** three, which found two security problems; both are fixed.
  1. Proofs are bound to their channel: TCP `client`/`server`, socket `client:socket`/`server:socket`.
  2. A relaying host verifies the pipe's holder: its own nonce, and nothing passes until a `server:socket` proof.
- **The relay deadline** (`569f39a`, reviewed, no blockers):
  - the holder gets the serving host's `authTimeoutMs` (5 s) for its challenge and again for a proven welcome;
  - at most 64 frames and 1 MB are held before the welcome;
  - `TEAMS_MCP_HUB_AUTH_TIMEOUT_MS` shortens it for tests.
- **Follow-ups, done before the merge:**
  - `28ee536`: the welcome deadline also starts at the challenge when the extension's hello hasn't come yet, and a later hello restarts it. A proven relay with a 600 ms deadline still passes a call 2 s later. `msFromEnv()` (src/native.ts) takes whole ms above 0 for the `TEAMS_MCP_HUB_*_MS` variables, clamped to 2^31−1.
  - `462f5f6`: `lostCall.test.ts` finds `describeSocketError`'s end with either line ending (the Windows CI checkout had CRLF).
  - A fresh review of both found no blockers. Its two should-fix test gaps are fixed in **`c862dab`**:
    - a test that a hello after the holder's challenge restarts the deadline from the hello. With the restart removed on purpose it failed (exit 1040 ms after the hello, 1250 needed);
    - a lower bound on the early-challenge test.
  - The review's four nits are posted on #123 (comment 6772138839):
    - `msFromEnv` also accepts `1e3`, `0x10` and ` 600 `;
    - `1e400` (Infinity) falls back to the default while `1e308` clamps;
    - a late hello can give the holder up to two deadlines, which a comment should say;
    - the `lostCall` end search needs a trailing newline.
- **Testing:** the full `npm test` on Node 26 was green (62 files, 768 passed) before the deadline commits; CI was the full run after them.
  - System tests run the built `dist/hub.js`, so **run `npm run build` first**. A stale `dist/` fails the welcome test with the old `serverVersion`.
  - Locally with about 1.3 GB free, "a relaying host whose hub socket holder never sends a challenge exits within the auth timeout" took 14.9 s against its limit. It passes alone.
- **Not blocking, posted on #123 and in the PR:**
  - the relay is a signing oracle for `client:socket` (not exploitable as far as the review saw);
  - the relay overwrites the extension's `nonce` (matters for PR 3);
  - `sameText` duplicates `sameProof`, and the `proofRole` strings are written out in `relay()`;
  - the handshake exists three times;
  - commit messages `f32d2f3`, `eedcd82` and `6b66869` cite some wrong Outlook commits (the code comments are right);
  - during takeover, a waiting response over 1 MB can trip the cap (the host exits; the extension reconnects).
- **Next PRs:**
  - **PR 3:** the extension's `connectNative` with the TCP fallback, retrying native after a 4403, chunk joining, `transport` in `get_version`, and the nonce point.
  - **PR 4:** setup registration, `batPath`, and moved-node reporting.
  - **PR 5:** the version switch, default on, `feat!:` → 0.4.0. It waits for the manual checks on Windows and the Mac.

## Open issues and decisions (2026-11-09/10)

- **#77:** implemented in #125. The leftovers are posted on #77:
  - test 2b uses the real clock;
  - no test checks `accountUnsure: null` after A → B → C;
  - the unsure guard is copied at four send paths;
  - the hand-kept `READS` list;
  - fixed delays in tests 7/7c.
- **#103:** #121 is merged. Still open:
  - "the extension's own recovery" wording;
  - the `api_traffic({ clear: true })` wording in docs/testing.md;
  - `{ timeout: 2000 }` in `traffic.test.ts`.
- **#122:** item 1 is merged (#129). Still open:
  - whether the worker's own requests should count as Teams' sends;
  - "the extension lists no features" is by design until #123 PR 3.
- **#124** (`needs-info`, with #111/#96): the extension stayed disconnected about half an hour while a hub was listening, right after a rebuild.
  - Next time, before reloading anything, capture the service worker's state and console in `chrome://extensions`, and run `Get-NetTCPConnection -LocalPort 47393`.
  - **Another episode, 2026-11-10 about 16:45 local time:**
    - Claude Desktop's teams server first reported "Server teams unavailable". After its 60 s retry it ran 0.3.56 with the bridge "waiting for extension" (`extension=null`, `teams=null`, `restartNeeded=false`).
    - Port 47393 then had the hub (pid 30504, the mcp-atlassian session's server, started 16:28:57) and 8 established connections, all `mcp-teams` servers, none from Chrome.
    - About a minute later `get_version` showed the extension connected again (0.3.56, websocket). It isn't known whether it came back by itself or because the extension was reloaded.
    - Teams itself had no session: `teamsTabs: 0`, all services null.
    - The test runs going on at the time use their own ports (`TEAMS_MCP_PORT` 0 or a test port), never 47393, and the hub predates them.
  - **`background.js:2104` in Chrome's console** is `new WebSocket(\`ws://127.0.0.1:${port || DEFAULT_PORT}\`)` in the extension's connect. An error there is most likely Chrome's "WebSocket connection … failed" while no hub is listening (for example while the hub moves between sessions). The extension retries, so it is noise, not the fault. The exact error text wasn't captured.
- **#111/#96** (`bug`, `ready-for-human`): close with the native host and launcher (#123, ADR 0002).
- **Outlook:** the pipe-name collision for non-ASCII usernames is filed as mcp-newoutlook#178.

## Earlier (2026-11-08)

- **Merged on 2026-11-08.** Each had a fresh-subagent review with no blockers and passed CI on Linux and Windows.

  | PR | Change | Release |
  |---|---|---|
  | #108 | The api_traffic log save goes to the storage it was recorded under | 0.3.49 |
  | #109 | A call that fails for a missing session gets the same note as `get_version` | 0.3.50 |
  | #110 | An old token of the previous account doesn't switch back, and the account check before a resend waits for captures still being stored | 0.3.51 |
  | #118 | The hub drains in-flight calls for up to 5 s when its session ends (`TEAMS_MCP_DRAIN_MS`; `0` means no drain), and tells peers `{type:"drained"}` when it answered everything | 0.3.52 |

- **#112** (drain) is closed by #118.
- **Review leftovers** (none blocking) are posted as comments on the issues; read those before working on them:
  - **#103:** the status read for a failed call's note uses the 60 s default; two branches of `failedCallNote` are untested; pure functions are tested in `test/integration/`; two small docs and timeout nits.
  - **#77:**
    - fixed delays in tests 7 and 7c;
    - the A → B → A switch within 30 s, where a send goes out as B while Teams shows A;
    - no test for `iat` equal to the switching token's;
    - `tokenIssuedAt` has no unit test and may read a different header than `tokenOid`.
  - **#112:**
    - port citations name a PR, not a commit (ADR 0001 §7);
    - a late queued send can flash its confirmation window;
    - no test for a step-down during a drain;
    - "drain" isn't in `GLOSSARY.md`;
    - peers don't re-send refused calls through the next hub.
- **#111** (stale server after a release) and **#96** stay open on purpose. Their stale-server half waits for the native host and launcher below.
- **ADRs on main:** `docs/adr/0001-where-the-hub-lives.md` (native-messaging host plus TCP fallback) and `docs/adr/0002-versioned-launcher.md`, with their terms in `GLOSSARY.md`. Read them before any hub or launcher work.
  - Delivery order (ADR 0001): #112 drain (done) → #115 handshake (done) → native host (0.4.0) → launcher (0.5.0).
- **Releases are automatic.** `.github/workflows/version.yml` runs on every push to `main` except Markdown-only pushes:
  - it bumps the version from the commit messages (`scripts/bump-version.mjs`), tags it, and publishes to npm with trusted publishing (OIDC);
  - npm can take a minute or two to show the new version (`npm view mcp-teams version --prefer-online`).

## This Windows PC (checked 2026-11-09)

- **Live install:** `C:\Orca_Project\mcp-teams` is the live install. Every session's `teams` server runs its `dist/index.js`, and Chrome's Teams extension loads its `extension/` folder.
  - On 2026-11-10 at 17:03 it was rebuilt on `05e027b` (#130 merged; `package.json` still 0.3.57 until the release commit is pulled) with `npm ci` and `npm run build`. The extension copy in `~/.mcp-teams/extension` was on 0.3.56; a starting server syncs it. Since 0.3.56, only the extension's manifest version has changed.
    - The checkout's uncommitted `package-lock.json` (dependency drift from an `npm install`) was saved as a patch in that session's scratchpad and restored before the pull.
    - Ten servers were older than that build. The hub was the mcp-atlassian session's server, pid 30504. The others: mcp-newoutlook, mcp-teams, PM-HUB, system-manager, pm-hub-sync, two Claude Desktop servers, and two Claude Code sessions with no recorded folder.
  - **Chrome loads the extension from `~/.mcp-teams/extension`,** a copy that a *starting* server syncs from the checkout (`src/index.ts:41`, `syncExtension`). A rebuild alone doesn't update it.
    - `node dist/index.js reload-extension` syncs it, but on this PC it answers "hub restarted" every time. The extension then reloads itself and reconnects within about 5 s.
    - The `reload_extension` tool only reloads from that copy.
  - **The hub** moves between sessions. On 2026-11-10 after the 0.3.56 rebuild it was the system-manager session's server; reconnect the hub's session last.
  - **Running servers keep their old code** until each session reconnects with `/mcp`. After the 0.3.56 rebuild, 12 were on older code: mcp-teams, mcp-newoutlook, PM-HUB, MD-Editor, mcp-atlassian, system-manager (hub), NAVERWORKS, MeetNotes, one Claude Code session with no recorded folder, two Claude Desktop servers, and one started by the NAVER WORKS app. To list them, compare each `node … mcp-teams/dist/index.js` process's start time with `dist/index.js`'s write time; `~/.claude/sessions/<parent pid>.json` gives a Claude Code session's folder.
- **Right after the reload:** no Teams session was captured (all four services null, `signedInAs: null`).
  - The Teams tab has to load chats again to capture one.
  - Sessions that use the Teams tools need `/mcp` → teams → Reconnect.
- **Memory:** only about 2 GB of 27 GB was free. A subagent's full test run was stopped once for low memory.
- **Worktrees:** an Agent-tool worktree starts with an empty `node_modules`. Run `npm ci` in it before testing; otherwise vitest resolves from the main checkout. One such run exited 1 with no output.
- **Node versions:**
  - default `node` is v26;
  - **`npx -y node@20` doesn't give Node 20 here.** The `node` package's binary never gets set up, so it falls through to v26: `npx -y node@20 -v` prints `v26.3.0`.
  - **For a real Node 20 run:**
    - use the official zip from nodejs.org, checked against `SHASUMS256.txt` and unpacked outside the repo;
    - run `<that folder>/node.exe node_modules/vitest/vitest.mjs run --fileParallelism=false`;
    - check that `node.exe -v` prints v20 first.

## This Mac (checked 2026-11-08, about 08:10 local time)

- **Versions:** the hub on port 47393 and the extension both run 0.3.52; the shared npx cache holds 0.3.52. `get_version` reports `restartNeeded: false` and `versionsMatch: true`.
  - The hub belongs to the Claude Code session in this repo; the user reconnected it with `/mcp` after the release.
- **Teams session:** captured, all four services signed in.
  - After the extension reloaded into 0.3.52 its captures were empty, as expected.
  - Its own recovery brought the session back within about 90 s, with no tab or extension reload.
- **Other sessions:** the older Claude Code sessions (scion, MeetNotes, PM-HUB, local-plugins, mcp-newoutlook) still run their old mcp-teams servers. They join as peers and pick up new code only when each one reconnects.
- **Claude Desktop:** not running. Its teams log ends with a clean shutdown at 04:47 UTC on 2026-11-08.

## Next up

1. **Native-messaging host (0.4.0, ADR 0001): issue #123**, grilled with the user on 2026-11-09/10.
   - It has 13 decisions, five PRs in order, and acceptance checkboxes, including manual checks on Windows and the Mac.
   - PR 5 (default on, `feat!:` → 0.4.0) waits for both manual checks.
   - PR 1 (#127, the transport interface) and PR 2 (#130, the native host) are merged.
   - **Next is PR 3:** the extension's `connectNative` with the TCP fallback, retrying native after a 4403, chunk joining, `transport` in `get_version`, and the nonce point (the relay overwrites the extension's `nonce`). Read the #123 comments first, including the nits from the #130 reviews.
2. **Versioned launcher (0.5.0, ADR 0002).** The same: open the issue from the ADR first.
3. **`ready-for-agent` issues:**
   - #103: finish the branch above.
   - #77: implement the switch-back decision once it's posted, plus the other leftovers.
   - #76: Windows quoting in printed setup commands.

Run `gh issue list` for the full backlog. #21 and #96 are the umbrella issues that PRs reference as "Part of".

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

- **Hub owner:** `lsof -nP -iTCP:47393`. The listener is the hub; the `Google` process connected to it is the extension.
- **Live state:** the `teams` MCP tool `get_version` reports the server, extension and hub versions, the bridge state, `restartNeeded` and the Teams session.
  - Without the tools, pipe `initialize`, then `notifications/initialized`, then a `tools/call get_version` into `node ~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/dist/index.js`. It joins the bridge as a peer.
- **Claude Desktop's log:** `~/Library/Logs/Claude/mcp-server-teams.log`.
- **Versions on disk:**
  - `~/.mcp-teams/extension/manifest.json` (extension folder);
  - `~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/package.json` (shared npx cache).

## Suggested skills

- `grill-with-docs` (calls `grilling` and `domain-modeling`): before opening the native-host and launcher issues.
- `tdd`: for each implementation issue.
- `code-review`: review each branch in a fresh subagent before merge.
- `diagnosing-bugs`: if Teams or the bridge breaks again after a release.
- `orca-cli`: only for long parallel work.
