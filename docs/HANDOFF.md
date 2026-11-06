# Handoff: mcp-teams after 0.3.48 (2026-11-06)

Repo: `the repo root` (GitHub `HeeyunCho/mcp-teams`). Branch `main`, clean, level with origin at `cbf798c chore(release): v0.3.48`.

## Where things stand

- **#111** (stale server or extension after a release): partly fixed.
  - The extension half shipped in PR #113 (0.3.47). The extension reloads itself when its folder on disk holds a newer version, and the server retries its reload request during a hub handover.
  - The stale-server half waits on the hub work in ADR 0001/0002. #111 stays open on purpose ("Part of #111"); don't close it.
- **#115** (capabilities handshake) is done: PR #116, released as 0.3.48, issue closed.
- **ADRs on main:** `docs/adr/0001-where-the-hub-lives.md` (native-messaging host plus TCP fallback) and `docs/adr/0002-versioned-launcher.md`, with the terms in `GLOSSARY.md`. Read them before any hub or launcher work. The delivery order is in ADR 0001: #112 drain → #115 handshake (done) → native host (0.4.0) → launcher (0.5.0).
- **This Mac, checked at about 16:21:**
  - The hub (PID 63628) runs 0.3.47 and the Chrome extension runs 0.3.47.
  - The bridge is connected, the Teams session is captured and `restartNeeded` is false.
  - 0.3.48 is on npm `latest` but isn't installed locally yet; the next `npx mcp-teams@latest` session pulls it in.
- **Releases are automatic.** `.github/workflows/version.yml` runs on every push to `main` except Markdown-only pushes:
  - it bumps the version from the commit messages (`scripts/bump-version.mjs`), tags it and publishes to npm with trusted publishing (OIDC);
  - npm can take about a minute to show the new version.

## Next up

1. **#112: the hub drains on session end** (`ready-for-agent`). It is the next step of ADR 0001; build it test-first in a worktree on a `fix/112-...` branch.
2. Then the **native-messaging host** (0.4.0, ADR 0001) and the **versioned launcher** (0.5.0, ADR 0002). Neither has an issue yet, so open them from the ADRs first.
3. Other `ready-for-agent` issues: #103, #77, #76. An older worktree `.claude/worktrees/agent-a204de3bca349d97f` on `fix/77-non-json-post-sent` predates this work; check its state before touching #77.

Run `gh issue list` for the full backlog. #21 and #96 are the umbrella issues that PRs reference as "Part of".

## How the user wants work done

- **Routing:**
  - do short mechanical work directly;
  - send reviews and research to subagents;
  - give a subagent that changes files its own worktree (`isolation: "worktree"`);
  - use Orca only for long parallel work.
- **Report** which way each task ran and what is left to review or merge.
- **Branch flow:** branch from `main`, then `npm test` plus a Node 20 run, then push. Never force-push.
- **PRs:**
  - open a PR with "Part of #21 and #96" (or whichever umbrella issue applies);
  - wait for CI (test, test-windows, gitleaks);
  - merge with a merge commit;
  - delete the remote and local branches;
  - remove a worktree only after its merge succeeded;
  - pull `main`.
- Use git, not scn, until 2026-11-17 (see `~/.claude/CLAUDE.md`). Never print or use scn tokens or the admin token.
- **Attribution:**
  - commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Useful checks

- **Hub owner:** `lsof -nP -iTCP:47393`. The listener is the hub; the `Google` process connected to it is the extension.
- **Live state without the `teams` tools:**
  - pipe `initialize`, then `notifications/initialized`, then a `tools/call get_version` into `node ~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/dist/index.js`;
  - it joins the bridge as a peer and reports the server, extension and hub versions, the bridge state and the Teams session.
- **Claude Desktop's log:** `~/Library/Logs/Claude/mcp-server-teams.log`.
- **Versions on disk:** `~/.mcp-teams/extension/manifest.json` (extension folder) and `~/.npm/_npx/6995c9b5f6c70e20/node_modules/mcp-teams/package.json` (shared npx cache).

## Suggested skills

- `tdd`: for #112 and later implementation issues.
- `grill-with-docs` (calls `grilling` and `domain-modeling`): before opening issues for the native host or launcher, or wherever the ADRs leave a decision open.
- `code-review`: review each branch in a fresh subagent before its PR.
- `diagnosing-bugs`: if Teams or the bridge breaks again after a release.
- `orca-cli`: only for long parallel work.
