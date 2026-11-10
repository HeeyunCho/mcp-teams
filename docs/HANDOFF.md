# Handoff: mcp-teams after 0.3.55 (updated 2026-11-10 on the Windows PC)

Repo: GitHub `HeeyunCho/mcp-teams`. Branch `main`: **0.3.55** is the latest release (`525aadd chore(release): v0.3.55`). Two work branches are in progress (#122 and #123 PR 2, see below).

## Merged on 2026-11-09/10

Each had a fresh-subagent review with no blockers and passed CI on Linux and Windows (test, test-windows, gitleaks).

| PR | Change | Release |
|---|---|---|
| #121 | The failed-call note's status read waits 3 s, not 60 s; tests for its `connected`/`signal` branches; `failedCallNote`/`isMissingSession` unit-tested (Part of #103) | 0.3.53 |
| #125 | **Unsure account** (#77): any capture of the previous account within 30 s of a switch marks the account unsure, and sends are refused. Reads carry `accountNote`, `get_version` shows `accountUnsure`, and `tokenIssuedAt` reads the same token as `tokenOid` | 0.3.54 |
| #127 | PR 1 of #123: a transport interface in `src/bridge.ts` (`BridgeSocket`, `BridgeTransport`, `webSocketTransport`), a refactor with no change in behaviour | 0.3.55 |

## In progress

- **#122 item 1:**
  - **The first hypothesis was wrong** (tested 2026-11-10). The worker's own requests move `services.substrate` and `lastSignedInCall` together, so they can't cause the gap.
  - **What reproduces it:** `captureSession` (`extension/background.js` ~:33) doesn't check where a request came from, unlike `recordRequest` (`isTeamsOrigin`). So a `substrate.office.com` request from outside the Teams page (most likely an Outlook web tab) moves `services.substrate`. With a different token, it even replaces Teams' substrate capture.
  - **The revised fix:** `captureSession` requires a Teams origin. It is in progress on branch `fix/122-capture-teams-origin`, with tests for the three rows in the [#122 comment](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6765067953).
  - **Out of scope:** whether the worker's own requests should count as Teams' sends.
- **#123 PR 2** (the native host) is in progress on branch `feat/123-native-host`.

## Open issues and decisions (2026-11-09/10)

- **#123, the native-messaging host (0.4.0, ADR 0001 step 3):**
  - Grilled with the user; it has 13 decisions, five PRs in order, and acceptance checkboxes, including manual checks on Windows and the Mac.
  - PR 1 is merged (#127).
  - **Next is PR 2:** `dist/hub.js`, the 4-byte framing with the 1 MB split, the relaying host, the peer-only TCP listener, and a test against the real `mcp-teams@0.3.52` stepping down.
  - What PR 2 must add to the transport interface is posted on #123: several listeners, a label for where a connection came from, `join()` taking a transport, and a synthetic `pong` for a native port.
  - PR 5 (default on, `feat!:` → 0.4.0) waits for both manual checks.
  - Outlook's pipe-name collision for non-ASCII usernames is filed as mcp-newoutlook#178.
- **#77:** the switch-back decision is implemented (#125). The leftovers are posted on #77:
  - test 2b uses the real clock;
  - no test checks `accountUnsure: null` after A → B → C;
  - the unsure guard is copied at four send paths;
  - the hand-kept `READS` list;
  - fixed delays in tests 7/7c.
- **#103:** #121 is merged. Still open:
  - "the extension's own recovery" wording (follow-up comment of 2026-11-09);
  - the `api_traffic({ clear: true })` wording in docs/testing.md;
  - `{ timeout: 2000 }` in `traffic.test.ts`.
- **#122** (`ready-for-agent`, with #103/#104):
  - item 1, revised to `captureSession` requiring a Teams origin, is in progress (above);
  - "the extension lists no features" is by design (`CAPABILITIES.features` is `[]` until #123).
- **#124** (`needs-info`, with #111/#96): the extension stayed disconnected about half an hour while a hub was listening, right after a rebuild.
  - Next time, before reloading anything, capture the service worker's state and console in `chrome://extensions`, and run `Get-NetTCPConnection -LocalPort 47393`.
- **#111/#96** (`bug`, `ready-for-human`): close with the native host and launcher (#123, ADR 0002). #111 was triaged on 2026-11-09.

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
  - On 2026-11-10 it was rebuilt on **0.3.55** (build id `12cf2b1c15b6`), after #127 merged. The extension copy in `~/.mcp-teams/extension` is on 0.3.55.
  - **Chrome loads the extension from `~/.mcp-teams/extension`,** a copy that a *starting* server syncs from the checkout (`src/index.ts:41`, `syncExtension`). A rebuild alone doesn't update it.
    - `node dist/index.js reload-extension` syncs it, but on this PC it answers "hub restarted" every time. The extension then reloads itself and reconnects within about 5 s.
    - The `reload_extension` tool only reloads from that copy.
  - **The hub** is Claude Desktop's server (0.3.53).
  - **Running servers keep their old code** (0.3.46–0.3.54) until each session reconnects with `/mcp`. Run the process check under "Useful checks" or ask the agent for the list.
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
   - **PR 1 (the transport interface) is PR #127.**
     - Branch `refactor/123-transport-interface`, worktree `.claude/worktrees/agent-af25389b385ab3f06`.
     - It has had a fresh review with no blockers. CI is the full run.
     - What PR 2 must add is posted on #123.
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
