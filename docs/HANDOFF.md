# Handoff: mcp-teams after 0.3.52 (2026-11-08)

Repo: GitHub `HeeyunCho/mcp-teams`. Branch `main`, at `80620c9 Merge pull request #118` and its release commit `chore(release): v0.3.52`. No PRs are open, and no worktrees or work branches are left.

## Where things stand

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
- **#111** (stale server after a release) stays open on purpose. Its stale-server half waits for the native host and launcher below.
- **ADRs on main:** `docs/adr/0001-where-the-hub-lives.md` (native-messaging host plus TCP fallback) and `docs/adr/0002-versioned-launcher.md`, with their terms in `GLOSSARY.md`. Read them before any hub or launcher work.
  - Delivery order (ADR 0001): #112 drain (done) → #115 handshake (done) → native host (0.4.0) → launcher (0.5.0).
- **Releases are automatic.** `.github/workflows/version.yml` runs on every push to `main` except Markdown-only pushes:
  - it bumps the version from the commit messages (`scripts/bump-version.mjs`), tags it, and publishes to npm with trusted publishing (OIDC);
  - npm can take a minute or two to show the new version (`npm view mcp-teams version --prefer-online`).

## Next up

1. **Native-messaging host (0.4.0, ADR 0001).** No issue exists yet.
   - Open one from the ADR first.
   - Where the ADR leaves a decision open, grill it with the user before writing the issue.
2. **Versioned launcher (0.5.0, ADR 0002).** The same: open the issue from the ADR first.
3. **`ready-for-agent` issues:** #103 and #77 (their leftovers, see above), and #76 (Windows quoting in printed setup commands).

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
