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
| `list_meetings` | Your meetings (each has a meeting chat), most recent first: subject, scheduled time, organizer, whether there is a transcript, and whether another organization hosted it |
| `get_meeting` | The calls held in a meeting (one per occurrence of a recurring one): start, end, who joined, the recording's link, whether there is a transcript |
| `read_transcript` | What was said: `[hh:mm:ss] Speaker: text` lines and each speaker's talk time. Long transcripts continue with `from`. |
| `search_transcripts` | Finds lines in the transcripts of your recent meetings that contain all the words of a query, each with the line before it |
| `api_traffic` | Diagnostic: the endpoints the Teams tab has called (method, host, path, status, header **names**, auth scheme). Header and query **values** are never recorded. |
| `send_message` | Asks to post in a chat or channel, to reply to a channel post, or to start a chat with people (`to`: one person for a 1:1 chat, several for a group chat, with an optional `title`). **You must click Send.** |

People in `to` are given by name or email and looked up like Teams' people picker; each must mean exactly one person in your organization, otherwise the matches are listed. If a chat with exactly those people already exists (for a group with a `title`, also that title), the message goes there instead of starting another one.

A conversation can be given as an id (`19:…`), as `Team/Channel`, as a chat title, or as a person's name for your 1:1 chat with them. A name must match exactly one conversation; otherwise the matches are listed.

### Meetings and transcripts

Meeting data comes from the meeting chat. Teams posts an event there for each call, saying who joined and when, and a message for each recording and transcript. Transcripts are stored in the organizer's OneDrive, so `read_transcript` reads them with your SharePoint sign-in in a SharePoint tab. If none is open, it opens your OneDrive in a pinned background tab. You can read the transcripts of meetings you were invited to, as in Teams. There is one only when someone turned on transcription in the meeting.

Teams reports the call's length, not each person's time in it, so attendance lists who joined. Meeting chats of another organization's meetings (`external: true`) usually can't be read once you've left, which is how Teams works too.

### Compared with Microsoft's Microsoft 365 connector for Claude

| | mcp-teams | Microsoft 365 connector |
|---|---|---|
| Setup | Your browser session; no admin involvement | A Microsoft Entra Global Administrator must consent for the tenant; write tools need an admin to turn them on |
| Read chats, channels, search | Yes | Yes |
| Send, reply, start 1:1 and group chats | Yes, after you click Send in a confirmation window | Yes, if an admin allows it ("Ask" per send) |
| Meeting transcripts | Read with speakers and timestamps, page through long ones, search across meetings | Read |
| Attendance | Who joined each call, from the meeting chat | Yes, from Teams attendance reports |
| AI meeting recap | No | Yes, with a Copilot or Teams Premium license |
| Works when Conditional Access blocks cloud apps | Yes: requests come from your browser | No, if the policy blocks Anthropic's servers |
| AI apps | Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Codex | Claude only |

### Sending always needs your click

The AI can only **request** a send. The extension then opens its own window showing where the message goes (for a new chat: who will be in it, and its title), the post it replies to and the message itself. The message is posted, and a new chat created, only if you click **Send** there. Closing the window, clicking *Don't send*, or waiting 5 minutes all mean nothing is posted.

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

Every AI session starts its own mcp-teams server, and they share the one extension connection. The first server owns the bridge port (`role: "hub"` in `get_version`), and later ones forward their calls through it (`role: "peer"`). When the hub's session ends, a peer takes over within a second. A newer server takes over from an older one. Servers of 0.2.0 and older can't do the newer handshake: after updating from them, restart AI sessions that are still open (in Claude Code: `/mcp`).

## Configuration

`~/.mcp-teams/config.json` is created on first run:

| Key | Env override | Default |
|---|---|---|
| `token` | — | random, generated once; the server, its peers and the extension prove to each other that they know it |
| `port` | `TEAMS_MCP_PORT` | `47393` (also set it in the extension popup) |

## Security notes

- The bridge listens only on `127.0.0.1`. Web pages can't connect to it, because only extension origins are accepted.
- The server and the extension prove to each other that they know the pairing token in `~/.mcp-teams/config.json`, without sending it. Setup copies it into the installed extension folder as `pairing.json`; both files can be read only by your user. So a program that takes the port while no AI app runs gets nothing from the extension, and a program posing as the extension gets no calls.
- Teams' tokens are only ever sent to the service they were captured from.
- Messages can contain prompt injection. The send-confirmation window is the safeguard, so read it before clicking Send.
- The extension may observe requests to Microsoft hosts (`*.microsoft.com`, `*.office.com`, `*.sharepoint.com` and similar), but it only records requests made by the Teams tab, and only names, for `api_traffic`. It runs requests only in Teams tabs, and in SharePoint tabs to read transcripts.
- If you also give an AI direct control of your browser or desktop, it could click the confirmation button itself. Don't combine the two if you rely on the confirmation step.

## Limitations

- It relies on Teams' internal web APIs, which Microsoft doesn't document and can change. All request shapes live in `extension/background.js` and the parsing in `extension/teams.js`.
- It can't edit or delete messages, mention people, or add people to an existing chat. New chats are only with people in your organization (or ones Teams can reach from it).
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

Every pull request and every push to `main` is also scanned for committed secrets by the **Secret scan** GitHub Action (gitleaks). Known false positives go in `.gitleaksignore`.
