---
status: accepted
date: 2026-11-27
---

# MCP SDK v2, served through serveStdio, to ship skills

mcp-teams ships **skills**: playbooks for its tools (`skills/<name>/SKILL.md`), served through the MCP Skills extension (`io.modelcontextprotocol/skills`). AI apps load them on demand, and they update with the server. The extension needs protocol revision 2026-07-28. Only the v2 TypeScript SDK (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`) supports that revision. The v1 package (`@modelcontextprotocol/sdk` 1.32) stops at 2025-11-25. So this change also moves the server to v2.

## Why

- **Skills replace prose nobody loads.** How to catch up on chats, recap a meeting or fix the connection was spread across tool descriptions and the README. Tool descriptions take context in every session, and the README is never in context. A skill takes context only when it is used.
- **The SDK provides the extension.** `loadSkills` (`@modelcontextprotocol/server/ext/skills/node`) builds the catalog from a folder: digests, limits and name checks. `attach` serves `skills/list`, `skills/get` and `resources/read` for `skill://` URIs. Building this ourselves on v1 would mean hand-writing a protocol revision v1 does not support.

## Decision

1. **v2 packages, migrated with the official codemod** (`@modelcontextprotocol/codemod v1-to-v2`). Tool handlers keep their internal `{ signal }` argument. `safeWith` (`src/tools.ts`) maps v2's `ctx.mcpReq.signal` onto it, so cancelling a call still withdraws its extension call. The only visible change to the tool contract is the input schemas' `$schema`, which is now JSON Schema 2020-12.
2. **`serveStdio`, not `server.connect(new StdioServerTransport())`.** Only `serveStdio` answers a 2026-07-28 opening, and it still serves 2025 clients from the same factory. The factory builds the server and registers the tools, and attaches the skills only for the `era` it is given as `modern`: a 2025 client gets no skills and no resources. Our own lifecycle (`serverEnding`, `watchParent`, `watchStdout`, the signal handlers) is unchanged. The drain closes the stdio handle where it closed the server before.
3. **A broken skills folder never stops the server.** `loadTeamsSkills` (`src/skills.ts`) leaves out a skill with a problem, with a warning on stderr. If the folder can't be read at all, it returns null and the tools serve without skills.
4. **Skills name only what exists.** A system test checks that every identifier in backticks in a `SKILL.md` is a tool, one of its arguments, a skill or a result field on a short allowlist, and that a result field passed back as an argument (`olderCursor` as `cursor`) is named with it. A unit test loads `skills/` under `strict` and checks Claude Code's size limits (100 KB a file, 400 KB a skill).
5. **Sending stays with the user.** No skill sends on its own. Each one that may post says that `send_message` opens the confirmation window, and that a lost call is checked with `read_messages` before any resend.

## Consequences

- The skills extension's `attach` API is marked experimental in the SDK and may change in a minor release. Pin the v2 packages with `^2.4.0` and check the skills tests when updating.
- A new skill is a folder under `skills/`. The folder name must equal the skill's `name` in its frontmatter. Add it to the lists in `test/unit/skills.test.ts` and `test/system/skills.test.ts`.
