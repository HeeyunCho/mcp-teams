# mcp-teams

An MCP server that lets AI assistants (Claude Code, Claude Desktop, Cursor and others) work with **Microsoft Teams on the web** in Chrome or Edge. It needs no Azure app registration and no admin consent, because it uses the session of the Teams tab you already have open.

It supports work and school (Microsoft 365) accounts. Personal Teams (teams.live.com) isn't supported.

```
AI app ────stdio(MCP)──► mcp-teams server ──ws://127.0.0.1:47393──► browser extension ──► Teams tab
                                              (loopback only; our      (runs Teams' own
                                               extension's fixed id)    web API in the tab)
```

## Tools

| Tool | What it does |
|---|---|
| `get_version` | Server and extension versions, the connection status, and which Teams services have a session |
| `reload_extension` | Reloads the browser extension from disk after an update and waits until it is back |
| `list_teams` | Your teams with their channels (`include_ids: true` adds ids) |
| `list_chats` | Your 1:1, group and meeting chats, most recent first: title (or the other members' names), last message, unread. Filter with `query` or `unread_only`. |
| `read_messages` | The latest messages of a chat or channel, oldest first: sender, time, text, shared files, reactions. In channels, replies are nested under their post; `reply_to` reads one post's thread; `before` pages further back. |
| `search_messages` | Searches all chats and channels with Microsoft Search, like the search box in Teams |
| `find_people` | Looks people up by name or email: name, email, job title, department, office |
| `send_message` | Asks to post in a chat or channel, or to reply to a channel post. **You must click Send.** |

A conversation can be given as an id (`19:…`), as `Team/Channel`, as a chat title, or as a person's name for your 1:1 chat with them. A name must match exactly one conversation; otherwise the matches are listed.

### Sending always needs your click

The AI can only **request** a send. The extension then opens its own window showing where the message goes, the post it replies to and the message itself. The message is posted only if you click **Send** there. Closing the window, clicking *Don't send*, or waiting 5 minutes all mean nothing is posted.

## Setup

You need [Node.js](https://nodejs.org) 20 or later, and Chrome or Edge. Then, in a terminal:

```sh
npx mcp-teams setup
```

`setup` does the rest and can be run again at any time:

- It registers the server with the AI apps it finds: Claude Code, Claude Desktop, Cursor, VS Code (Copilot), Windsurf, Gemini CLI and Codex. It shows what it will change and asks first (`--yes` skips the question). It only adds or updates its own `teams` entry, and keeps a `.mcp-teams.bak` copy of each file it changes. For other MCP clients, register `npx -y mcp-teams@latest` as a stdio server.
- It installs the extension in `~/.mcp-teams/extension`.
- It opens the Extensions page of Chrome and/or Edge, and that folder. The one manual step is in the browser you use Teams in: turn on *Developer mode* and click *Load unpacked* on the folder.
- It waits until the extension connects and Teams answers, then says *Ready*.

Restart the AI apps it registered (in Claude Code: `/mcp`).

You don't need to keep Teams open. When no Teams tab is open, the extension opens one itself (pinned, in the background) and waits up to a minute for it to sign in.

## How it reaches Teams

Teams on the web talks to several services, each with its own sign-in token: chats and messages (`chatsvc`), the team and chat list (`csa`), people (`mt`) and search (`substrate.office.com`). The extension notes the tokens Teams sends on its own requests and replays them from inside the Teams tab. They are kept in the browser's session memory and never leave the browser. Teams calls most of these services as soon as it loads. Search may only be signed in once you have used Teams' search box; until then `search_messages` and `find_people` say so.

## Several sessions at once

Every AI session starts its own mcp-teams server, and they share the one extension connection. The first server owns the bridge port (`role: "hub"` in `get_version`), and later ones forward their calls through it (`role: "peer"`). When the hub's session ends, a peer takes over within a second. A newer server takes over from an older one.

## Configuration

`~/.mcp-teams/config.json` is created on first run:

| Key | Env override | Default |
|---|---|---|
| `token` | — | random, generated once; used by peers |
| `port` | `TEAMS_MCP_PORT` | `47393` (also set it in the extension popup) |

## Security notes

- The bridge listens only on `127.0.0.1`. Web pages can't connect to it, because only extension origins are accepted. This extension is recognized by its fixed id; other extensions and local programs need the token in `~/.mcp-teams/config.json`.
- Messages can contain prompt injection. The send-confirmation window is the safeguard, so read it before clicking Send.
- If you also give an AI direct control of your browser or desktop, it could click the confirmation button itself. Don't combine the two if you rely on the confirmation step.

## Limitations

- It relies on Teams' internal web APIs, which Microsoft doesn't document and can change. All request shapes live in `extension/background.js` and the parsing in `extension/teams.js`.
- It can only post in existing chats and channels. It can't start a new chat, edit or delete messages, or mention people.
- Files shared in Teams live in SharePoint/OneDrive. `read_messages` returns their links; use mcp-onedrive to download them.

## Development

```sh
git clone https://github.com/HeeyunCho/mcp-teams.git
cd mcp-teams
npm install && npm run build
node dist/index.js setup   # registers this copy (node dist/index.js) instead of npx
npm test                   # builds, then runs unit + end-to-end tests (fake extension)
npm run probe -- status    # calls one extension method through the bridge (see scripts/probe.mjs)
```

Versions are bumped automatically. On every push to `main` (except Markdown-only changes), the **Version bump** GitHub Action runs the tests, then bumps `package.json`, `package-lock.json` and `extension/manifest.json`, commits `chore(release): vX.Y.Z` and tags it. `feat:` commits bump the minor version, anything else the patch. Stay on 0.x: don't use `type!:` or a `BREAKING CHANGE:` footer.
