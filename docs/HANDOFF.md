# Handoff: mcp-teams after #175, the 2026-11-17 triage, the closure audit and the rechecks of #22, #23, #35, #21, #111, #96, #122, #124, #142, #162 and #123, and a second pass on #77, #103 and #183 (updated 2026-11-17 on the Windows PC)

Repo: GitHub `HeeyunCho/mcp-teams`. PRs 1–4 of #123 (the native-messaging host) are on `main`, all **off by default** (`nativeHost` off). Next is PR 5, which turns it on. The last release is 0.3.72 (`71f49e2`, #174 and #175); 0.3.71 (`9bf7434`) has #165 and #166 (dependency bumps only), 0.3.70 (`d5cacdd`) has #163, 0.3.69 (`d35759e`) has #159, 0.3.68 (`60f005f`) has #158, 0.3.67 (`aa90cf4`) has #157, 0.3.66 (`367f198`) has #154.

## Resume here (session of 2026-11-17, updated after the PC reboot)

This day was **triage and bookkeeping only. No code changed:** release 0.3.72 is unchanged. Every change was to GitHub issues, or to this file through docs PRs #181, #184, #191, #194, #196, #197, #198, #199 and the #122 diagnosis PR. There are no open PRs, no extra worktrees, and no local branches apart from `main`.

**Where the state lives (read these, don't re-derive):**
- **Issue #25, the roadmap:** the sections "CPU/memory audit (2026-11-16) and its follow-ups" and "Older follow-ups rechecked against 0.3.72 (2026-11-17)". They list every open issue with what's left and a link to its latest checklist comment.
- **This file:** "Now (2026-11-17)", "Open issues and decisions" and "Next up", below.
- **`gh issue list`:** 34 open issues. 19 are `ready-for-agent`, 14 `ready-for-human` and 1 `needs-info` (#124).

### After the reboot (checked 2026-11-17, boot at 11:16:51Z)
1. **`get_version`:** server, extension and hub on 0.3.72, `restartNeeded: false`, versions match. **No 0.3.70 servers are left:** pids 4196 and 69468 are gone, every running server started after the boot, and `server.log` has no 0.3.70 line since then. #142 needs nothing more for this.
2. **`server.log` from the reboot on:**
   - **#124:** the first server started at 11:18:27Z. The hub that stayed (pid 28076, started 11:19:06Z) logged `extension-connected` **19 s after it started** (11:19:25Z). There was no long gap, so nothing new for #124.
   - **#162:** `tabs=1 captured=yes` (all four services) at the hub's **first status read**, 11:20:15Z, which was slow (ms=9093). Nothing new for #162.
   - **#173/#182:** two `status=unreadable kind=timeout` lines on the hub, **ms=15011** (11:22:21Z) and **ms=15008** (11:28:21Z), plus four slow reads at 2866–9093 ms. So the timeouts also show up on a process only minutes old. [Comment on #173](https://github.com/HeeyunCho/mcp-teams/issues/173#issuecomment-6946978869).
3. **#122: the manual Chrome check did not pass, so #122 stays open.** Recording was on and the user ran Teams search in the Chrome Teams tab, twice. Neither listing had a `substrate` call (the second had 7 entries on 5 other hosts). `substrate` and `chatsvc` stayed captured but weren't refreshed after about 11:18Z, and `server.log` says `stale=yes` from 11:30Z. The next step is in #122's [latest comment](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6946978380): record with `filter: "search"`, and look in the tab's own Network panel for the search request's host.
   - **Third try** (`record: true, clear: true`, a new query typed into the search box): **no request recorded at all** during the search minute, not even with `filter: "search"`. `substrate` was still not refreshed. `chatsvc` moved, but because the hourly health check posted its report to the notes chat (`48:notes`) at 11:41:49Z, not because of search. [Comment](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6947082168).
   - **Diagnosis** (read-only, [comment](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6947197521)):
     - `api_traffic` uses `chrome.webRequest` only, with the types `xmlhttprequest` (which covers `fetch`), `other` and `media` (`extension/background.js:239`), on a host list that includes `substrate.office.com` (`extension/teams.js:840-848`).
     - Both the recorder and the session capture drop any request whose initiator isn't the Teams origin (`background.js:242` and `:40`).
     - `lastTeamsCall` is set by the same handler after that gate (`:245`), and it **didn't move during the search minute**. So the extension saw no Teams-origin request of those types at all; the search wasn't merely filtered out by host.
     - Ranked causes: (1) search goes out as a `websocket` or `ping`, or from a frame or worker with another initiator; (2) Teams answers from a local index or cache; (3) the typing happened in a browser or profile that isn't connected (unlikely: `get_version` showed one browser).
     - The user's DevTools Network check (host, Type and Initiator of the search request) decides between them.
   - **#200** (`ready-for-agent`): `api_traffic` can't see `websocket` or `ping` requests, and the webRequest fake (`test/helpers/fakeChrome.ts:277`) ignores `types` and gives requests the Teams initiator by default.

### Suggested order for the `ready-for-agent` work
From the 2026-11-17 recheck of #185–#190 and #192. This isn't recorded on #25 yet; add it there. The four lanes can run in parallel; inside each lane, the order matters.
- **A, measure-memory:**
  1. #185's freed port and #190 items 1–3 in one PR;
  2. #185's load loop early, since #186, #187 and #149 use it; then the Node 20 `readMessagesCut` flake.
  3. Separately: #190's heap check first, then #178 together with #190's byte-count item, so `extension/background.js:1225` changes once.
- **B, bridge send path:**
  1. #172 together with #192's "(unknown)" item, which is the same recheck after `pickExtension`;
  2. then #188;
  3. then the rest of #192.
- **C, tests:** #187, then #186 (shared read-only `running` getter), or both in one PR. #149 runs alongside.
- **D, extension worker:** #189, then #183 item 3 once the user decides it. #77's test nits can run alongside.
- **Other pairs:**
  - #177 before #170: same `rotate()`/`hubLog()` and test file.
  - #180 and #195 one after the other: both change `nativeHostReport`/`get_version`.
  - #193 with or before #169.
  - Move the `getVersion` test helper once under #195, for all six copies; #103 notes it too.
- **`docs/testing.md`** is edited by #185, #189, #190 and #192, so whichever lands later rebases.

### Waiting on the user (don't do these unattended)
- #22's gap 2: fail a replaced connection's calls at once, or give them a grace period.
- #183's five items: each has a recommendation in its latest comment.
- #103's two rules.
- #23: which Node versions CI runs.
- #35: its kept decision items.
- #21: open the ADR 0002 launcher issue, and drop the idea of gating send safety on a declared feature or keep it.
- #123 PR 5: the manual Windows and macOS checks.

### Rules learned today
- **Closing keywords:** never write fix/fixes/close/closes/closed/resolve(s) right before `#NNN` in a PR description, commit message or comment unless that PR really fixes it. #176 closed #169 by accident, and a draft PR description of mine nearly did it again.
  - Before creating anything, run `grep -inE '\b(fix(e[sd])?|close[sd]?|resolve[sd]?):? +#[0-9]' <file>`.
  - Before merging, run `gh pr view N --json closingIssuesReferences`; it must be `[]` for docs PRs.
- **Editing issue bodies:** fetch the body, change it with a small script that asserts each anchor appears exactly once, diff, then `gh issue edit --body-file`.
  - Write the file with `newline=''`. Python on Windows otherwise writes CRLF, and the diff shows every line as changed.
  - Two subagents must never edit the same issue body at once. The main session makes all #25 edits.
- **Docs PRs follow one pattern:**
  1. `git worktree add -b docs/<name> <scratchpad>/wt-<name> origin/main`, edit, commit, push;
  2. open the PR with a keyword-free description and wait for CI (test, test-windows, gitleaks);
  3. `gh pr merge N --merge --match-head-commit <sha>`;
  4. remove the worktree, delete the branch on origin and locally, then pull.

  This checkout is the live install; a docs-only pull needs no rebuild.
- **jq on Windows Git Bash** rejects `\[` inside `test()` patterns. Pipe to `grep` instead.

### Suggested skills
- `tdd` (or `superpowers:test-driven-development`) for any `ready-for-agent` issue: a red test first, per #25's process rules.
- `code-review` from a fresh subagent before every merge. The reviewer is never the author.
- `superpowers:using-git-worktrees`, or the Agent tool with `isolation: "worktree"`, for code changes. Run `npm ci` in a new worktree first.
- `diagnosing-bugs` if the post-reboot log shows something new for #124, #162 or #173.
- `superpowers:finishing-a-development-branch` when a fix branch is ready to merge.
- `handoff` again at the end of the next session.

---

## Now (2026-11-17)

| PR | Change | State |
|---|---|---|
| #174 | Fixes #168: the native host's `FrameDecoder` (`src/native.ts`) allocates a frame once its 4-byte length is read and copies stdin chunks into it, instead of `Buffer.concat` per 64 KB chunk (a 20 MB frame copied about 3.4 GB, now 20 MB). `src/hub.ts` limits stdin frames to `MAX_FROM_EXTENSION_BYTES` (64 MiB, Chrome's cap for extension → host) instead of `MAX_MESSAGE_BYTES` (256 MB). Latent while `nativeHost` is off | Merged as `64186d7`. Its Version bump run failed by design (#175 merged meanwhile, atomic push refused); #175's run released both |
| #175 | Fixes #171: a server in role=none (can neither join nor listen) retries after `retryMs` (2 s) doubling to `retryMaxMs` (30 s), with ±50% jitter capped at `retryMaxMs`, reset by `setRole()` on becoming hub or peer. New options `retryMaxMs` and `random` (jitter source). `docs/testing.md` names its test as the one bridge test on a fake clock | Merged as `aa730db`, released in 0.3.72 (`71f49e2`, tag `v0.3.72`) by `version.yml` |

Both: written test-first by a subagent in an Agent worktree, reviewed by a separate subagent (`/code-review`, Standards and Spec; no blockers), checked on Node v26.3.0 and v20.20.2 (#174: 5 files, 82 passed, 2 skipped; #175: 7 files, 121 passed, 1 skipped), and CI passed (test, test-windows, gitleaks).

### #174, what the review changed

- The first version lost the rest of a chunk when `onFrame` threw (the host's `uncaughtException` handler only logs, so it would read on from the wrong offset), and a `push` from inside `onFrame` read its bytes before the outer chunk's rest. The unread rest is now kept until `onFrame` returns; a test for each. The copy test's bound is one copy per byte.
- **Nits left:** `MAX_FROM_EXTENSION_BYTES` is private to `hub.ts` while `MAX_TO_EXTENSION_BYTES` is exported from `native.ts`; a frame's buffer (up to 64 MiB) is allocated when its header arrives. The host's welcome still advertises `maxMessageBytes: MAX_MESSAGE_BYTES` (256 MB), which belongs to #169.

### #175, what the review changed

- The cap first applied before the jitter, so a wait at the cap reached about 45 s; it now applies after. The fake-timer test, against `docs/testing.md`'s real-timer rule, is now a documented exception (#171 asked for fake timers).
- **Trade-off accepted:** after the port holder goes, a role=none server can take up to 30 s to notice, and its calls keep the old `listenError` ("restart the other AI sessions…") until then. A call in role=none could start an attempt early (follow-up if wanted).
- **Nits left:** only the peer reset path is tested; the "no attempt before" check waits one `setImmediate`; `random` jitters only this retry, not `restartHub` or a peer's 0.1–0.5 s retry; `settle()` could move to `test/helpers/timing.ts`; "role=none" has no GLOSSARY entry.

### The CPU/memory audit (2026-11-16)

A read-only subagent audited `main` at 0.3.71: no unbounded growth in the hot paths and no tight loop on this PC today. Filed with `needs-triage`:

| Issue | Finding | State |
|---|---|---|
| #168 | Native `FrameDecoder` copied per chunk (quadratic), limit 256 MB | Fixed by #174 |
| #169 | `MAX_MESSAGE_BYTES` 256 MB (`bridge.ts`, extension) for a base64 attachment path Teams doesn't have; applies before the token is proved; about 32 MB suggested | Open |
| #170 | `hub.log`: `mkdirSync` + `statSync` + `appendFileSync` per line on the hub's thread; the native host logs every frame | Open |
| #171 | role=none retried every 2 s forever | Fixed by #175 |
| #172 | `send()` writes to a closed socket: with two browsers, an extension closing during `pickExtension` leaves a turn entry and the call waits out its timeout | Open |
| #173 | Tracking: leftover `.rotating` files, the transcript cache counting text not memory, `search_transcripts` up to about 1,000 Teams requests, `get_version`'s sync `reg.exe`; and from `server.log`, frequent 15 s status-read timeouts, a hub silent for about 60 s on 2026-11-12, a possible native-host restart loop | Open |

The audit found safe: pending-call and turn tables, timers and listeners, the peer send buffer and relay limits, the extension's 0.5–30 s backoff, the 60 s state watch (hub only), log volume, and the extension's caches.

### Triage round (2026-11-17, after 0.3.72)

Labels and comments only, no code. Each issue was checked against `main` at 0.3.72, and each got a triage comment. There's no `triage` skill here, so the triage followed `docs/agents/triage-labels.md`.

| Issue | Now | Why |
|---|---|---|
| #170 | `ready-for-agent`, `performance` | `hubLog()` still makes three blocking file calls per line. A fix must keep rotation correct under the #152/#163 lock (an in-memory size is only a hint; recheck under the lock) |
| #172 | `ready-for-agent`, `bug` | `send()` (`src/bridge.ts`, about line 1652) still writes without a `readyState` check, and `runCall` doesn't recheck the socket between `pickExtension` and `takeTurn` |
| #149 | `ready-for-agent` | #159 did the handshake part. Left: keep-alive drops (`startKeepAlive`, `startPeerBeat`) write no `hub.log` line, and the system tests on the 200 ms test heartbeat aren't checked one by one |
| #173 | `ready-for-human` | Tracking issue, all 7 items still apply. Its 4 low findings are split into #177–#180 (below). The 3 "cause unknown" items stay here and need the live `server.log` |
| #21 | `ready-for-human` | The "Part of" umbrella. What's left is in #123 and #111; close it when #123 ships |
| #142 | `ready-for-human` | Not stale: `restart-needed v=0.3.71 onDisk=0.3.72` at 06:59:39Z, and 0.3.70/0.3.71 servers still running at 07:25Z. Same cause as #111/#96; kept open so the hourly health check's reports land there. Close it with #111 |
| #162 | `ready-for-human` | Not stale: on 0.3.72, `tabs=0 captured=no` from `extension-connected` at 07:03:10Z to the first capture at 07:31:55Z (about 29 min, through four hub handovers). That's past #160's 15 min threshold. Needs the live browser and its logs |
| #124 | still `needs-info` | On 0.3.72 the extension closed once (`extension-closed code=1001` at 07:15:00Z on hub 42868) and rejoined at 07:16:03Z, about 63 s. That's too short to show either way. The comment of 2026-11-17 lists what's still needed: a long occurrence on 0.3.66 or later with its `server.log` lines, the extension's service-worker console at that moment, and whether it only follows a release |

- **Split out of #173, all `ready-for-agent` and checked against 0.3.72:** #177 (`bug`: leftover `.rotating` files never deleted, `src/hubLog.ts` `rotate()`), #178 (`performance`: the extension's transcript cache counts response text, not the parsed JSON it keeps), #179 (`performance`: one `search_transcripts` call can make about 1,000 Teams requests; its timeout is 300 s, not the 120 s #173 said), #180 (`performance`: `get_version` blocks on `execFileSync(reg.exe)` when `nativeHost` is on).
- **Closed issues tidied:** `needs-triage` removed from #168 and #171 (and from #169, since reopened).
- **#169 was closed by accident and is reopened** (`ready-for-agent`). Merging #176 closed it at 07:09:27Z, because #176's description said "fix #169" and GitHub reads that as a closing keyword. No commit changed the limit: `src/bridge.ts:136` is still 256 MB, and `get_version` on 0.3.72 reports `maxMessageBytes: 268435456`. **In PR descriptions and commit messages, don't write "fix/fixes/close/resolve #NNN" unless the PR really fixes it.**
- **#182** (`performance`, `ready-for-agent`, filed 2026-11-17): log event-loop delay and utilisation in `server.log`. It serves #173's three "cause unknown" items (the 15 s status-read timeouts, the hub silent for about 60 s, a possible native-host restart loop) by showing whether the server's own event loop was blocked.
- **#77 and #103 rechecked against 0.3.72** ([#77 checklist](https://github.com/HeeyunCho/mcp-teams/issues/77#issuecomment-6943292684), [#103 checklist](https://github.com/HeeyunCho/mcp-teams/issues/103#issuecomment-6943293165)). #77 stays `ready-for-agent`. What's left for an agent: a `read_messages` cursor carries no account (`extension/teams.js:218-243`); a switch before the first page isn't caught (`extension/background.js:1381` runs before the `:1308` snapshot); and three #141 test nits. Its four judgement items moved to **#183** (`ready-for-human`). **#103 is now `ready-for-human`:** five refactors with no behaviour change, and two rules to decide (the stuck rule's 5-minute gap, recovery-tab calls counting as Teams-tab calls).
- **#25** (the roadmap): a "CPU/memory audit" checklist section (#168 and #171 ticked; #169, #170, #172, #177–#180 and #182 open), plus a section listing #77 and #103 after their recheck. #76 and #88 are marked closed there.
- **Closure audit:** all 19 issues closed since 2026-11-03 (other than #169) were closed by their real fix or by hand with a comment, so none was reopened. Handoff PRs #155, #161 and #164 had also listed issues after a closing keyword (#145 and #153, #148 and #156, #152). That did nothing, because each issue's fix PR had closed it earlier the same day. See the rule under "How the user wants work done".
- **#22, #23 and #35 rechecked against 0.3.72** ([#22 checklist](https://github.com/HeeyunCho/mcp-teams/issues/22#issuecomment-6943657089), [#23 checklist](https://github.com/HeeyunCho/mcp-teams/issues/23#issuecomment-6943657591), [#35 checklist](https://github.com/HeeyunCho/mcp-teams/issues/35#issuecomment-6943658291)). All three stay `ready-for-human`.
  - **#22:** gap 1 is done (#42). **Gap 2 needs a decision:** when a browser connection is replaced, `src/bridge.ts:1018-1036` fails the old connection's calls at once, with no grace period, and #25 doesn't record option (a) or (b) yet. Also left: the `hubInfo` data clump, and concrete leftovers (two missing peer tests, the "(unknown)" wording at `:1572-1573`, the version regex written out three times, test smells).
  - **#23:** the harness's freePort race is done (#43). Its three concrete items moved to **#185** (`tests`, `ready-for-agent`): `scripts/measure-memory.mjs:244-252` still picks a port and frees it, no load loop is committed or documented, and the Node 20 `readMessagesCut` flake. Kept in #23: which Node versions CI runs, and live checks of chatsvc message ids and channel features.
  - **#35:** the main item (#41) and items A and E are done; #86 also did `waitForCapture`'s listeners after a cancel without saying so. Its concrete leftovers moved to five `ready-for-agent` issues: **#186** (tests: queued turns through a hub restart, peer drops and rejoins, a closed last Teams tab), **#187** (tests: deterministic heartbeat and fair-share tests, tidier send-window and worker tests), **#188** (`send-safety`: not-sent reporting and wording), **#189** (extension worker: name lookups, `waitForCapture`'s unhandled rejection, the 401 tab, `pageFetch`'s origin check) and **#190** (measure-memory leftovers, a worker-cache heap check, `docs/testing.md` gaps). Kept in #35, needing a decision: items C and D, positional parameters (the `sendTo` part is #183), the `tooLarge` cast, the duplicated 2 s floor, the `lostCall` source-scan blind spots, a dropped peer's slots freed early, `hubTurn`'s single `resume`, item F, and three concrete items whose right change isn't clear.
  - **#25** lists #22, #23, #35, #183 and #185–#190 under "Older follow-ups rechecked against 0.3.72".
- **#22's concrete items are now #192** (`send-safety`, `tests`, `ready-for-agent`):
  - two missing peer tests;
  - the "(unknown)" refusal at `src/bridge.ts:1572-1573`, which must stay a "nothing was sent" refusal;
  - one version parser instead of the `x.y.z` regex written out three times;
  - the refusal naming the browser;
  - test tidying (the tests should import the existing `MIN_SEND_EXTENSION`).

  Gap 2 and the `hubInfo` question stay in #22.
- **#21, #111, #96 and #122 rechecked against 0.3.72** ([#21](https://github.com/HeeyunCho/mcp-teams/issues/21#issuecomment-6944021813), [#111](https://github.com/HeeyunCho/mcp-teams/issues/111#issuecomment-6944022775), [#96](https://github.com/HeeyunCho/mcp-teams/issues/96#issuecomment-6944023424), [#122](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6944024021)). All four stay open and `ready-for-human`.
  - **#21:** the ADRs, the handshake (#115), hub draining (#112) and #123 PRs 1–4 are done. New finding, filed as **#193** (`bug`, `ready-for-agent`): over TCP, one oversized answer fails every call on that extension or peer. There's no size check before the WebSocket send (`extension/background.js:2306`; the native path has one since `702669a`), and the bridge calls `rejectAll` (`src/bridge.ts:961`, and `:1432` on a peer). It goes with #169, since lowering the limit makes it likelier. Also left: #123 PR 5's manual checks, no issue yet for the ADR 0002 launcher, and whether to drop the idea of gating send safety on a declared feature.
  - **#111:** it happened again on 0.3.72 today (`restart-needed v=0.3.71 onDisk=0.3.72` at 06:59:39Z; 0.3.70/0.3.71 servers passed the hub around until their sessions ended, the last at 09:21:48Z), but Teams stayed reachable. A hub still hands over only to a newer x.y.z version (`src/bridge.ts:1129`). It needs #123 PR 5 and the launcher, then one release watched recovering on its own.
  - **#96:** detection and the reported version are done (#97). Nothing triggers a takeover after a pull or build, and takeovers compare x.y.z only (`src/bridge.ts:375`). This also needs #123 PR 5 and the launcher.
  - **#122:** #129 is done. Only the user's manual Chrome check is left. As partial evidence, `get_version` on 0.3.72 shows all four services captured, and since #129 only the Teams page can set them.
  - **#25** lists all of these, with #192 and #193, under "Older follow-ups rechecked against 0.3.72".
- **#124, #142, #162 and #123 rechecked against 0.3.72 and `server.log`** ([#124](https://github.com/HeeyunCho/mcp-teams/issues/124#issuecomment-6944425483), [#142](https://github.com/HeeyunCho/mcp-teams/issues/142#issuecomment-6944426050), [#162](https://github.com/HeeyunCho/mcp-teams/issues/162#issuecomment-6944426753), [#123](https://github.com/HeeyunCho/mcp-teams/issues/123#issuecomment-6944427388)).
  - **#124** (still `needs-info`): **no extension from 06:43:49Z to 07:03:10Z, about 19 min**, while a 0.3.71 hub listened (62476, then 91216 from 06:47:46Z). It started about 15 min before the 0.3.72 rebuild. Both `reload-extension` runs ended `reload-failed` (07:00:00Z, 07:01:43Z), and a 4401 auth timeout came at 07:02:48Z. That gives the long occurrence with log lines. Still missing: the service-worker console at such a time, and whether it only follows a release. Since then, one drop came back in 132 ms (09:32:06Z). Shut after about a week of health checks without a long gap.
  - **#142** (`ready-for-human`): **two 0.3.70 servers are still running, pids 4196 and 69468** (started 2026-11-16 at 06:44Z and 10:28Z; confirmed by a process check). `restart-needed` is logged once per process (`src/serverLog.ts:301-305`), so a server two releases behind writes no new line. Count start lines with no exit instead. Shut with #111 once #123 ships.
  - **#162** (`ready-for-human`): **quiet since 07:31:55Z.** Every status read to 09:30Z had a tab and a session, apart from one 1-minute gap after the 132 ms reconnect (#160's transient). Shut after about a week, including a release, without a loss over 15 min.
  - **#123** is now `ready-for-human`: what's left is PR 5 and its preconditions. Its concrete review leftovers moved to **#195** (`ready-for-agent`).
  - **#25** lists all five under "Older follow-ups rechecked against 0.3.72", and its audit section has today's #149, #170, #172 and #173 rechecks.
- **Second pass on #77, #103 and #183** ([#77](https://github.com/HeeyunCho/mcp-teams/issues/77#issuecomment-6946160147), [#103](https://github.com/HeeyunCho/mcp-teams/issues/103#issuecomment-6946160750), [#183](https://github.com/HeeyunCho/mcp-teams/issues/183#issuecomment-6946161425)). No code had changed since the morning recheck, so every line number held. Labels unchanged.
  - **#77** (`ready-for-agent`): **the cursor item moved to #183 as item 5**, since tying a cursor to an account changes which cursors get refused. Left for an agent: the switch before the first page, and the three #141 test nits. #77's body says so.
  - **#103** (`ready-for-human`): the `getVersion` test helper is copied **six** times, not four. #195 lists four, so move all six once under #195, then tick it on #103. Recommendations for its two rules: a separate gap of about 60 s for "stuck", and not counting the recovery tab's calls as Teams-tab calls.
  - **#183** (`ready-for-human`): five items, each with options and a recommendation; item 5 is now in the body.
    1. Keep the four account-unsure checks, and test each send path.
    2. A test that every handler is in `READS` or a named non-read list, and decide `probe`.
    3. An options object for `sendTo`, after or with #189.
    4. Keep `OLD_TOKEN_WINDOW_MS` as one constant, as decided on 2026-11-09.
    5. A keyed tag (an HMAC under a key in `chrome.storage.session`), so a cursor is refused after an account switch. Cursors from before a browser restart would be refused too.
- **Repo tidy:** Dependabot #166 had merged on 2026-11-16, but its branch `dependabot/npm_and_yarn/hono-4.13.18` was left on origin. Its head (`8b43592`) is in `main`, so the branch was deleted (it can be restored from #166). origin now has only `main`. Locally, the `wt-diag` scratchpad worktree and the five merged `worktree-agent-*` branches were removed.

## Earlier on 2026-11-16

| PR | Change | State |
|---|---|---|
| #166 | Dependabot: `hono` 4.13.13 → 4.13.18 (lockfile only; it comes in through `@modelcontextprotocol/sdk`). Closes Dependabot alerts #8–#12 (`csrf()` and `text/ping`, `mount()` path bypass, `css` helper escaping, RegExpRouter wildcard middleware, `validator('form')` with multipart) | Merged as `b76983d`. Its Version bump run failed by design: #165 had merged meanwhile, so the atomic push was refused and #165's run released both |
| #165 | Dependabot: `@hono/node-server` 2.1.4 → 2.1.8 (lockfile only, same path). Closes Dependabot alerts #6–#7 (backslash read as a path separator, unhandled `ECONNRESET` during a WebSocket upgrade) | Merged as `425dddb`, released in 0.3.71 (`9bf7434`, tag `v0.3.71`, on npm) by `version.yml`. No Dependabot alerts open after it |

## Earlier on 2026-11-12

| PR | Change | State |
|---|---|---|
| #157 | `npx mcp-teams setup` also registers the `teams` server with **Antigravity CLI**: detected by `~/.gemini/antigravity-cli`, written to `~/.gemini/config/mcp_config.json` (`mcpServers`). `src/clients.ts`, `test/unit/clients.test.ts`, README | Merged as `ee5de35`, released in 0.3.67 (`aa90cf4`) |
| #158 | Fixes #148: after awaiting `teams.pairingProof(...)`, the challenge branch in `extension/background.js` checks `ws === socket && readyState === OPEN` again before sending `hello`, as the welcome branch already did. Test: the `#148` case in `test/integration/workerConnection.test.ts` | Merged as `4f2fcc3`, released in 0.3.68 (`60f005f`). #148 is closed |
| #161 | The previous handoff (docs only) | Merged as `f4324ad`, no release |
| #163 | Fixes #152: `rotate()` in `src/hubLog.ts` runs under an exclusive lock (below) | Merged as `b4789c6`, released in 0.3.70 (`d5cacdd`). #152 is closed. CI passed first time (test, test-windows, gitleaks) |
| #159 | Fixes #156, part of #149: `handshake-closed` in `server.log` also logs `reason`, `ms`, `hello` and `port` (below) | Merged as `b7e7e11`, released in 0.3.69 (`d35759e`). Closes #156. Local: full `npm test` 909 passed; affected files on Node 20.20.2 78/78. CI: gitleaks and test-windows passed; Linux `test` first failed on the #152 rotation race (2999 of 3000), passed on re-run |

### #159, why a handshake was refused

- **Line:** `handshake-closed v=… role=hub code=4401 reason="auth timeout" via=tcp ms=308 hello=none port=53724`. Field order `code reason via ms hello port`.
- **`reason`:** the reason the hub refused with, recorded by `refuse()` in `src/bridge.ts` (a stalled client never answers the close, so its event would say 1006). `serverLog.ts` checks it against `CLOSE_REASONS` and writes `other` for anything else, so nothing a client sends is logged. `code` is the code the hub refused with; when the client left first, the event's code and `reason=other`.
- **`ms`:** time since the connection opened. **`hello`:** `hello`, `peer-hello` or `none`. **`port`:** the TCP remote port (none on the socket and native transports).
- **De-duplication:** an extension retrying a bad token every 30 s still logs once; the change check ignores `ms` and `port`.
- **Review** (fresh subagents, Standards and Spec): no blockers. Fixed before merge: the unused `native.ts` close-reason change reverted, the duplicate reason check in `bridge.ts` (`closeReason`) removed, the PR body corrected. Posted on #156 as follow-ups:
  - `"not now"` and `"too slow"` are in `CLOSE_REASONS` but close accepted connections, so they never reach `handshake-closed`;
  - logging the refusal code loses a stalled worker's `1006`;
  - slugs instead of quoted reason text would drop `write()`'s special case and decouple the log from the wire text;
  - `"hello" | "peer-hello" | "none"` is spelled out in both `bridge.ts` and `serverLog.ts`;
  - a legacy extension that leaves during its 1 s before 4426 logs `reason=other`, undocumented.

### #163, rotation under a lock (fixes #152)

- **Cause:** a process that found the log already rotated set the small file aside, appended it back and deleted it. A line another process wrote late, through the log it had opened before, went into the deleted copy.
- **Fix:** only the process that creates `<file>.lock` with `wx` rotates, and it checks the size again under the lock. One that finds the lock taken skips rotating for that line. Nothing is copied back or deleted, so a late line stays in the moved file (`.1` or the `.rotating` fallback). A lock older than 30 s counts as left by a dead process and is removed. README mentions `server.log.lock` and `hub.log.lock`.
- **Reproduction:** the 10-process system test never failed on this PC (0 of 30 loaded runs on the old code). The deterministic unit test in `test/unit/hubLog.test.ts` (late writer around `rotate()`) failed on the old code and is the "before" evidence. Watch CI's `test` job for the 10-process test.
- **Follow-ups on #152** (closed; reopen or file new if worked on): the stale-lock check can unlink a live lock (dead rotator plus three processes timed exactly); any `openSync("wx")` error counts as "lock held", not only `EEXIST`.

### #160, closed: the health check ran during a worker restart

- #160 (07:51 CET) was triaged from `server.log` and closed as `wontfix` (transient); the timeline is in the #160 comment. The first `get_version` hit a stuck socket that the extension replaced (`extension-closed code=4000`), then a worker restart (`code=1001`, 06:52:40Z) emptied the captures; all four came back by 07:02:34Z with no user action. Nothing pointed to a sleeping tab.
- **Captures and worker restarts** (posted on #153, which is closed): from 2026-11-11 11:39Z to 2026-11-12 12:47Z, 24 × 1001, 12 × 4000, 3 × 1005, and 70 × `status=unreadable` on 2026-11-12. Only 6 of the 24 restarts were followed by `captured=no`; those recovered in about 10–19 minutes, one (11:31Z) in about 76. Why some restarts keep the captures isn't visible in `server.log`. If this is worked on, open a new issue (the restarts themselves, and the gap without a session).

## Earlier on 2026-11-11

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

### Open bugs from 2026-11-11

- **#148:** fixed by #158 (0.3.68), closed. Old entries on the extension's Errors page stay until "Clear all".
- **#149** (follow-up from #145's review): #159 covers its handshake part. Still open: keep-alive drops write no `hub.log` line. Other system tests on `FAST.keepAliveMs` (200 ms; linger, takeover, `extensionNative`) to audit one by one.
- **#152:** fixed by #163 (0.3.70), closed. Follow-ups in "#163" above.
- **#142** (`needs-triage`): an hourly Hub health report on 2026-11-10 17:44Z, `restartNeeded` with server 0.3.57 running and 0.3.58 on disk. That is the known stale-server case (#111/#96).

### csa/mt captures (no issue needed for now)

*As of 2026-11-12: `csa` and `mt` were captured after the 0.3.68 and 0.3.69 reloads, and `server.log` shows them coming back by themselves after worker restarts. Hypothesis (b) is ruled out. No issue filed; file one only if `csa`/`mt` stay null again for longer than about 15 minutes after the last `extension-connected`. The DevTools check is no longer needed. Background from 2026-11-11 below.*

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
- **Rotation** (`src/hubLog.ts`, shared with `hub.log`): only the process that creates `<file>.lock` exclusively moves the log to `.1` (#152; before that, each process claimed the file and a small claim was appended back, which lost a late line). A real race lost lines before #143 (967 of 3,000 kept). A log that can't replace `.1` (for example antivirus holding it) moves aside as `<file>.<pid>-<random>.rotating`. A lock older than 30 s is treated as left by a dead process and removed.
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

- **#123** (native host, `ready-for-human` since 2026-11-17, [checklist](https://github.com/HeeyunCho/mcp-teams/issues/123#issuecomment-6944427388)): PRs 1–4 merged (#127, #130, #140, #146). Left here: PR 5 and its preconditions. Those are the manual Windows and macOS checks (not run on this PC; `nativeHost` is off), #169, #193, #180, #195 and #173's possible restart loop.
- **#195** (`ready-for-agent`, split out of #123): the PR 3 and #130 review leftovers, each with file:line:
  - the 4403 missing from `get_version` (`src/bridge.ts:932-933`);
  - `transport` null with no extension (`src/tools.ts:213`);
  - `skipNative` applying once;
  - no native welcome deadline;
  - TCP overwriting a failed native proof's `lastError`;
  - `Reassembler` with no tests or set limit (`extension/chunks.js:18-62`);
  - one answer over 1 MB tripping the takeover cap (`src/hub.ts:307` with `:250`);
  - the undocumented signing oracle;
  - dedup and style.

  The wrong Outlook commits in `f32d2f3`, `eedcd82` and `6b66869` are merged history: nothing to do.
- **#77** (`ready-for-agent`, [rechecked 2026-11-17](https://github.com/HeeyunCho/mcp-teams/issues/77#issuecomment-6943292684), [second pass](https://github.com/HeeyunCho/mcp-teams/issues/77#issuecomment-6946160147)): the switch before the first page isn't caught (the cursor item moved to #183 as item 5), and three #141 test nits (7/7c race a real 1 s Retry-After if the process stalls over 1 s; the 2b `setTimeout` spy matches exactly 1000 ms; `requestWithTurn` has no `deadline`).
- **#183** (`ready-for-human`, split out of #77, [second pass](https://github.com/HeeyunCho/mcp-teams/issues/183#issuecomment-6946161425)): the unsure guard copied at four send paths, the hand-kept `READS` list, `sendTo`'s 12 parameters, `OLD_TOKEN_WINDOW_MS` also setting how long the unsure state lasts, and (item 5) tying a `read_messages` cursor to its account. Each has a recommendation; see "Second pass" in Now.
- **#103** (`ready-for-human` since 2026-11-17, [checklist](https://github.com/HeeyunCho/mcp-teams/issues/103#issuecomment-6943293165)): the three leftovers are done (#139). Still open: refactor notes from the #107 review (the `getVersion` test setup duplicated, now in six test files, to be moved once under #195 ([second pass](https://github.com/HeeyunCho/mcp-teams/issues/103#issuecomment-6946160750)); `{at, host}` spelled out in five places, including `src/serverLog.ts`; the "signed in" rule copied, `teamsCalls` naming three things) and behaviour notes (the 5-minute gap in the stuck rule, background-tab calls counting as Teams-tab calls).
- **#22** (`ready-for-human`): **gap 2 needs your decision** (fail a replaced connection's calls at once, or give them a grace period); see "#22, #23 and #35 rechecked" in Now. Its concrete items are #192 (`ready-for-agent`).
- **#23** and **#35** (`ready-for-human`): only decision and live-check items are left; their concrete work is #185 and #186–#190 (`ready-for-agent`).
- **#21** (`ready-for-human`, the Phase 4 umbrella): left are #123 PR 5, the launcher issue to open, and the send-safety gating question. **#193** (`ready-for-agent`): over TCP, one oversized answer fails every call on the connection; do it with or before #169.
- **#122** (`ready-for-human`, rechecked 2026-11-17): the user's manual Chrome check after #129 **ran after the reboot and did not pass**: Teams search in the Chrome tab recorded no `substrate` call, and `substrate`/`chatsvc` weren't refreshed (see "After the reboot" in Resume here). A third try recorded no request at all, and the [diagnosis](https://github.com/HeeyunCho/mcp-teams/issues/122#issuecomment-6947197521) ranks three causes. The user's DevTools Network check (host, Type and Initiator of the search request) decides between them. The recorder's blind spot is #200 (`ready-for-agent`).
  - Today both were seen captured from the Teams page (`chatsvc`, and `substrate` at 12:49:54Z), but not as this check; `csa`/`mt` were not (see "csa/mt captures" in Now).
- **#124** (`needs-info`): the extension stayed disconnected while a hub listened. The 2026-11-10 16:45 episode is in Earlier. On 2026-11-17 it was gone for about 19 min (06:43–07:03Z); see "#124, #142, #162 and #123 rechecked" in Now.
- **#111/#96** (`ready-for-human`, rechecked 2026-11-17): close with the native host and launcher (#123, ADR 0002). #111 happened again on 0.3.72 today without taking Teams down. #142 (`ready-for-human`) is another instance and collects the health check's reports.
- **#162** (`ready-for-human`): no Teams capture for about 29 min on 0.3.72, then quiet from 07:31:55Z; see "Triage round" and the rechecks in Now.
- **#149, #170, #172** (`ready-for-agent`): see "Triage round" in Now. **#182** (`ready-for-agent`): event-loop delay logging for #173's cause-unknown items.
- **#173** (`ready-for-human`, the audit's tracking issue): its low findings are split into #177–#180 (`ready-for-agent`). **#169** (`ready-for-agent`, reopened; see "Triage round"): the 256 MB limit is unchanged. #168's 64 MiB (done) and #169 matter before `nativeHost` is on by default.
- **Closed:** #76 (#137), #134 (#136), #138 (#144), #143 (#147), #145 (#150), #148 (#158), #152 (#163), #153 (#154), #156 (#159), #160 (transient, `wontfix`), #168 (#174), #171 (#175).
- **Outlook:** the pipe-name collision for non-ASCII usernames is mcp-newoutlook#178.

## Next up

1. **Get every server onto 0.3.72** (see "This Windows PC"): rebuild, `reload-extension`, then a full restart of each session (`/mcp` → Reconnect did not replace any process on 2026-11-12), Claude Desktop last. Done by the reboot on 2026-11-17: every server is on 0.3.72 and the two 0.3.70 servers (pids 4196 and 69468) are gone. Still to do: check `server.log` for the first `handshake-closed` lines with `reason`/`ms`/`hello`/`port` (written only by a hub of 0.3.69 or later).
2. **The rest of #149** (keep-alive drops leave no `hub.log` line; the system tests on the 200 ms test heartbeat), the #156 follow-ups from the #159 review, and the #152 follow-ups from #163.
3. **The audit's `ready-for-agent` fixes:** #170, #172, #177–#180 (split out of #173) and #182 (event-loop delay logging). Settle #169's 256 MB limit before #123 PR 5, together with #193 (an oversized answer over TCP failing every call).
4. **Worker restarts emptying the captures** (Now, "#160"): open an issue if it should be worked on.
5. **#123 PR 5:** turn `nativeHost` on by default, with setup registering by default; `feat!:` → 0.4.0. It waits for the manual checks on Windows and the Mac (including Chrome's permission warning from #146), and for #169, #193, #180 and #195. Read the #123 comments first.
6. **Versioned launcher (0.5.0, ADR 0002).** Open the issue from the ADR first.
7. Where Teams search goes for #122 (the DevTools Network check); #200 (`api_traffic` misses `websocket`/`ping`); the `ready-for-agent` leftovers on #77, #185, #186–#190 and #192; the `ready-for-human` decisions on #103, #183, #22's gap 2, #23 and #35 (above).

Run `gh issue list` for the full backlog. #21 and #96 are the umbrella issues that PRs reference as "Part of".

## This Windows PC (checked 2026-11-17)

- **Live install:** `C:\Orca_Project\mcp-teams` is the live install. Every session's `teams` server runs its `dist/index.js`, and Chrome's Teams extension loads a copy of its `extension/` folder.
  - Rebuilt on 2026-11-11 at 12:41 on 0.3.65 (`5ef6c32bb59a`). The user then reconnected every session (`C:\PM_HUB_DB` last), restarted Claude Desktop, reloaded the extension and signed in. All 12 servers ran 0.3.65 by 13:05; the hub moved to the NAVERWORKS session (pid 75600).
  - Rebuilt again after #154 at 14:54 on 0.3.66 (`367f198`, build `e06bb586f16f`). All 13 running servers predate it (Claude Code sessions in PM-HUB, Jev-Agentic-Loops, Downloads, system-manager, mcp-atlassian, local-plugins, mcp-teams, mcp-newoutlook, NAVERWORKS (the hub, pid 75600), C:PM_HUB_DB and one more started 14:38; Claude Desktop's two) and need `/mcp` → teams → Reconnect, the hub's session last.
  - Rebuilt on 2026-11-12 at 11:32 on 0.3.68 (`60f005f`, `npm ci` + `npm run build`, build `cddbbae74f1c`), then `node dist/index.js reload-extension` ("hub restarted"; `~/.mcp-teams/extension` is 0.3.68). All 12 running servers predate it and still ran 0.3.66: Claude Code sessions in PM-HUB, Downloads (two), filemanager, mcp-newoutlook, mcp-teams, MeetNotes, `C:\PM_HUB_DB`, a `claude -p` run, local-plugins (the hub, pid 87248), and Claude Desktop's two. Each needs `/mcp` → teams → Reconnect. By 12:15 the `claude -p` run and one of Claude Desktop's servers had exited; Desktop started a 0.3.68 server at 11:41 (pid 105344), which took over as hub, and `csa`, `mt` and `chatsvc` were captured again. Ten 0.3.66 servers were left (Desktop's other one, pid 8380, among them); restart Claude Desktop last, since it holds the hub. Right after the reload `get_version` showed extension 0.3.68 with `restartNeeded: true` and the status read timed out.
  - Rebuilt on 2026-11-12 at 13:48 on 0.3.69 (`f4324ad`, build `e691dd5ba895`), then `reload-extension`; `~/.mcp-teams/extension` is 0.3.69. The 0.3.69 reload made the hub change hands twice in a second (12:48:38Z, `hub-closed code=1012`); Claude Desktop's 0.3.68 server (pid 105344) ended up as hub again.
  - **The user's `/mcp` → teams → Reconnect in every session (about 14:00) replaced no process:** the same pids ran on, with no new `start` line in `server.log`. At about 15:00 all 14 servers were older than the build: the hub 105344 (0.3.68, Desktop), two `claude -p` runs on 0.3.68 logging `restart-needed onDisk=0.3.69`, and 0.3.66 for the rest (PM-HUB, Downloads, filemanager, local-plugins, mcp-newoutlook, mcp-teams, MeetNotes, `C:\PM_HUB_DB`, Desktop's pid 8380, two more `claude -p` runs). Restart each session fully instead (or check whether `/mcp` offers a restart), Claude Desktop last.
  - **After #163 the checkout was pulled to 0.3.70 (`d5cacdd`) but not rebuilt:** `dist/` is 0.3.69 while `extension/manifest.json` says 0.3.70. Rebuild (`npm ci`, `npm run build`, `node dist/index.js reload-extension`) before restarting sessions.
  - Rebuilt on 2026-11-16 at 12:34 CET on 0.3.71 (`9bf7434`, `npm ci` + `npm run build`, build `cd024402cd0a`; `hono` 4.13.18, `@hono/node-server` 2.1.8), then `node dist/index.js reload-extension` ("hub restarted"); the extension came back as 0.3.71 at 11:38:40Z. All 12 running servers predate the build and still run 0.3.70. **The hub is the `mcp-atlassian` Claude Code session (pid 60680), not Claude Desktop.** The others: Claude Code in local-plugins, PM-HUB, NAVERWORKS, `C:\PM_HUB_DB`, everything-compare, mcp-newoutlook and mcp-teams; Claude Desktop's two (7944, 44968); a `claude -p` run under a non-interactive PowerShell (36424); and a pm-hub-sync `claude -p` run (64328). Restart each one fully, the hub's session last.
  - Rebuilt on 2026-11-17 at 07:59 CET on 0.3.72 (`71f49e2`, `npm ci` + `npm run build`, build `1274f3433802`; #174 and #175). `node dist/index.js reload-extension` answered "The extension is not connected" twice (06:59:59Z, 07:01:43Z): the extension had been gone since `extension-closed code=1001` at 06:43:49Z, before the build. `~/.mcp-teams/extension` was synced to 0.3.72 anyway, and the extension came back by itself as 0.3.72 at 07:03:10Z, with no Teams tab open (`tabs=0`). Meanwhile the hub changed hands about eight times in 3 s (07:01:44Z, `handover … to=0.3.72` and `hub-closed code=1012`), ending with a pm-hub-sync `claude -p` run's 0.3.72 server (pid 126448) as hub. Claude Desktop had no `teams` server running. Six servers predate the build: 0.3.70 in PM-HUB, NAVERWORKS, `C:\PM_HUB_DB`, mcp-newoutlook and mcp-teams, and 0.3.71 in markitdown. The hub, a `claude -p` run, will exit by itself and the hub will move to another server.
  - **Watch out during hand-overs:** old servers kept taking port 47393 back. A new hub stepped down 0.3.58 hubs about 10 times in 3 s.
  - **Chrome loads the extension from `~/.mcp-teams/extension`,** which a *starting* server syncs from the checkout (`syncExtension` in `src/index.ts`). A rebuild alone doesn't update it. `node dist/index.js reload-extension` syncs it (on this PC it answers "hub restarted"; the extension reloads and reconnects within about 5 s). The `reload_extension` tool only reloads from the copy.
  - **Running servers keep their old code** until each session reconnects with `/mcp`. Reconnect the hub's session last; the hub moves between sessions. To list stale servers, compare each `node … mcp-teams/dist/index.js` process's start time with `dist/index.js`'s write time; `~/.claude/sessions/<parent pid>.json` gives a Claude Code session's folder.
  - After an extension reload no Teams session is captured until the Teams tab loads chats again.
- **Claude Desktop's teams log:** `%LOCALAPPDATA%\Claude\Logs\mcp-server-teams.log` (not `%APPDATA%`).
- **Memory:** often only about 2 GB of 27 GB free. Timing tests can then fail (`drain.test.ts` once on Node 20 during #147; #145 before #150); rerun the file alone.
- **`npx tsc` can return exit code 0 on type errors here** (a wrapper prints `npm notice run … npx`). Gate on `node node_modules/typescript/bin/tsc --noEmit` and `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` instead.
- **Stray branches:** none since 2026-11-17. The five merged `worktree-agent-*` branches and the `wt-diag` scratchpad worktree were removed, and the main checkout is the only worktree.
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
  - **closing keywords:** in a PR description or commit message, put "fix", "fixes", "close", "closes" or "resolve" (or their other forms) right before an issue number only when that PR really fixes the issue. GitHub closes the issue on merge. A handoff or docs PR never uses them. Write "settle #NNN next" or "#NNN is still open" instead. On 2026-11-17 handoff PR #176 said "fix" right before #169 and closed it by accident. Handoff PRs #155, #161 and #164 did the same harmlessly, because those issues were already closed. Before merging, check that `gh pr view N --json closingIssuesReferences` lists only the issues the PR fixes (none for docs);
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
