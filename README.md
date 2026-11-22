# mcp-teams

An MCP server that lets AI assistants (Claude Code, Claude Desktop, Cursor and others) work with **Microsoft Teams on the web** in Chrome or Edge. It needs no Azure app registration and no admin consent, because it uses the session of the Teams tab you already have open.

It supports work and school (Microsoft 365) accounts. Personal Teams (teams.live.com) isn't supported.

```
AI app ────stdio(MCP)──► mcp-teams server ──ws://127.0.0.1:47393──► browser extension ──► Teams tab
                                              (loopback only; our      (runs Teams' own
                                               extension's ids)         web API in the tab)
```

## Tools

| Tool | What it does |
|---|---|
| `get_version` | Server and extension versions, the connection status, and which Teams services have a session |
| `reload_extension` | Reloads the browser extension from disk after an update and waits until it is back |
| `list_teams` | Your teams with their channels (`include_ids: true` adds ids). Up to a minute old unless `refresh: true`. |
| `list_chats` | Your 1:1, group and meeting chats, most recent first: title (or the other members' names), last message, unread. Filter with `query` or `unread_only`. The list can be up to a minute old; `refresh: true` reads it again (sending a message refreshes it). |
| `read_messages` | The latest messages of a chat or channel, oldest first: sender, time, text, shared files, reactions. In channels, replies are nested under their post; `reply_to` reads one post's thread; `cursor` (the returned `olderCursor`) pages further back; `before` (a time) still works. |
| `search_messages` | Searches all chats and channels with Microsoft Search, like the search box in Teams |
| `find_people` | Looks people up by name or email: name, email, job title, department, office |
| `list_meetings` | Your meetings (each has a meeting chat), most recent first: subject, scheduled time, organizer, whether there is a transcript, and whether another organization hosted it. Up to a minute old unless `refresh: true`. |
| `get_meeting` | The calls held in a meeting (one per occurrence of a recurring one): start, end, who joined, the recording's link, whether there is a transcript |
| `read_transcript` | What was said: `[hh:mm:ss] Speaker: text` lines and each speaker's talk time. Long transcripts continue with `from`. |
| `search_transcripts` | Finds lines in the transcripts of your recent meetings that contain all the words of a query, each with the line before it |
| `api_traffic` | Diagnostic: the endpoints the Teams tab called while recording was on (method, host, path, status, header **names**, auth scheme). Off until the AI turns it on with `record: true`; it stops after 30 minutes or with `record: false`. Header and query **values** are never recorded. It records only in the sideloaded copy (a clone loaded unpacked, or the copy setup installs); the web store copy doesn't request the hosts it watches, so there it answers that it isn't available (see *Development*). |
| `send_message` | Asks to post in a chat or channel, to reply to a channel post, or to start a chat with people (`to`: one person for a 1:1 chat, several for a group chat, with an optional `title`). **You must click Send.** |

People in `to` are given by name or email and looked up like Teams' people picker; each must mean exactly one person in your organization, otherwise the matches are listed. If a chat with exactly those people already exists (for a group with a `title`, also that title), the message goes there instead of starting another one.

A conversation can be given as an id (`19:…`), as `Team/Channel`, as a chat title, or as a person's name for your 1:1 chat with them. A name must match exactly one conversation; otherwise the matches are listed.

### Meetings and transcripts

Meeting data comes from the meeting chat. Teams posts an event there for each call, saying who joined and when, and a message for each recording and transcript. Transcripts are stored in the organizer's OneDrive, so `read_transcript` reads them with your SharePoint sign-in in a SharePoint tab. If none is open, it opens your OneDrive in a pinned background tab. You can read the transcripts of meetings you were invited to, as in Teams. There is one only when someone turned on transcription in the meeting.

`search_transcripts` searches up to 20 meetings (`meetings`, default 10), newest first. A search across meetings makes at most 100 Teams requests: meeting chat pages and transcripts, not counting what it already has cached. It reads only the newest 5 pages of each meeting chat, where the latest calls are; a chat longer than what was read is listed in `chatsCut`, and the note says how many pages were read. When the 100 requests run out, the result has `stoppedBy: "budget"`, says how many meetings (`notSearched`) or transcripts (`transcriptsNotSearched`) weren't searched, and returns the matches found so far. Searching again within a minute gets further, because what the first search read is cached. A search of one meeting (`meeting`) has no such budget: it reads its chat as far as `get_meeting` does, and all of its transcripts.

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
| AI apps | Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Antigravity CLI, Codex | Claude only |

### Sending always needs your click

The AI can only **request** a send. The extension then opens its own window showing where the message goes (for a new chat: who will be in it, and its title), the post it replies to and the message itself. The message is posted, and a new chat created, only if you click **Send** there. Closing the window, clicking *Don't send*, or waiting 5 minutes all mean nothing is posted.

If the AI stops waiting (it cancels, times out or loses its connection) while the window is open, the window closes and nothing is posted. If you had already clicked *Send* but no answer came back, the AI is told the message may have been posted and to check the chat before sending again, so it doesn't post twice. If Teams accepted the message but its answer, or the time in it, can't be read, the send is still reported as sent, with `time: null` and a `timeNote` saying the time isn't confirmed.

A send only goes to an extension that can close that window: one that declares the `cancelSend` feature, or, for an extension that declares no features (every one up to 0.3.79), one of 0.2.13 or newer. Otherwise the send is refused: `send_message` says nothing was sent and asks to update the extension. With several browsers, a send goes through when the browser picked for it can close the window. If the bridge is held by another AI session running a version from before this check, that server doesn't check the browser it picks, so this session's sends are refused unless every connected browser can. The server keeps the installed folder up to date, so `reload_extension` (or reloading it on the Extensions page) is usually enough; run `npx mcp-teams setup` if it was loaded from another folder. A copy installed from the Chrome Web Store or Edge Add-ons updates from the store instead.

### Extension versions

The extension has its own version line, from 1.0.0 on (the server's stays at 0.x). Its version only moves when the extension itself changes, and a server works with any extension at or above 0.1.0 and never compares the extension's version with its own. What the server may ask of the extension is decided by the features the extension declares when it connects (`cancelSend`, `sizeCheck`, and one more for each new kind of request); `get_version` shows them, `extensionSupported`, and the `missingFeatures` it lacks. See [ADR 0003](docs/adr/0003-extension-version-line.md).

### When Teams is busy

When Teams asks to slow down (HTTP 429), mcp-teams sends nothing more to that service, for that region or account, until Teams' wait is over. A call waits that out if it has time; otherwise it fails with "Teams is busy (throttled) for N s". A list that came back without some people's names says so in a `note`, instead of leaving them out silently.

### When something hangs

Several AI sessions share one connection to the browser: the first one runs it, the others go through it. They check on each other every 20 s. If the session running it stops responding (its app is suspended or hung), the others' calls fail within about 40 s with "The mcp-teams hub stopped responding; try again in a few seconds", and one of them takes over. A session that stops reading what it is sent is disconnected and reconnects. The extension reconnects by itself when it hasn't heard from the server for 45 s.

### What happened while nobody looked: server.log

Every mcp-teams server appends what it went through to `~/.mcp-teams/server.log` (`0600` in a `0700` folder; moved to `server.log.1` soon after it passes 1 MB: each server checks the file's real size every 50 lines or once its own count passes the cap, so with several servers writing it can run a little over), so an outage can be traced after a restart. Each line is one event: the time (UTC), the process id, the event, the server's version and role, then its fields:

```
2026-11-11T00:04:12.345Z pid=4242 extension-closed v=0.3.62 role=hub code=1006 transport=websocket
```

Events: `start` and `exit` (with its `reason`: `stdin-closed`, `stdout-closed` (the AI app closed its end of the pipes, seen when an answer couldn't be written), `drain-timeout` (after either of those, closing ran 2 s past the drain bound), `SIGTERM`, …; a `pid` with a `start` but no `exit` line was killed or crashed hard), `role` (hub, peer or none, and how it reached the hub), `handover` (to a newer server), `restart-needed` (the first time it is seen), `extension-connected` (each connect, with the extension's version as `ext`), `extensions` (how many are connected, by which transport), `extension-closed` (with the close code), `extension-dropped` (`reason=no-pong`: the hub dropped an extension that stopped answering its pings), `peer-dropped` (the hub dropped another AI session's server: `reason=no-pong`, it stopped answering the hub's pings, or `reason=backlog`, it stopped reading its answers), `handshake-closed` (a connection turned away before it was accepted, with its code: 4401 a wrong token or no proof in time, 4426 an extension too old, 4409 another copy connected, 4403 an extension on the native host's TCP port; then its `reason`, one of the hub's own close reasons such as `"auth timeout"` (no hello in time) or `"bad token"` (a wrong proof), or `other`, how long it was open as `ms`, which `hello` it sent (`hello`, `peer-hello` or `none`) and the `port` it came from), `hub-closed` (a peer's hub went away, with the close code; `reason=hub-silent` when this server dropped it because the hub's pings stopped, a hung hub rather than a closed one), `teams` (the Teams state, below), `tool` (a call that failed, by error name and kind, or took longer than 20 s, with its duration; `send_message`'s wait for your click never counts as slow), `loop-delay` (the server's own event loop stalled: since the last such check, usually a minute, longer if a status read was running then, some turn of it ran a second or more late; see below), and `uncaught-exception` / `unhandled-rejection` (by error name and code; one with `code=EPIPE`, a write to a closed pipe, only once per process). States are logged when they change, not on every read. The hub reads the Teams state every minute by itself, so it is logged even while no AI session calls a tool, and every server checks every minute whether mcp-teams was updated on disk.

A `teams` line gives the tabs, whether a session is captured and for which services, `stale=yes` when the tab keeps calling but made no signed-in call for 5 minutes (a captured but expired session looks like that), whether the signed-in account is the `first` seen, the `same` or `changed`, and in `ms` how long the read took. A read over 2.5 s adds `slow=yes` and is logged even when nothing changed, for the 1st and every 10th slow read in a row. A failed read is `status=unreadable kind=… ms=… failures=N`, where `kind` is `timeout` (no answer in 15 s for the hub's own read), `closed` (the connection went while it waited), `not-connected`, `not-hub` or `error` (anything else, such as the extension's error answer), and `failures` counts the failures in a row: the 1st, every 10th, one of a new kind and the first after the extension reconnects are logged, and the read that works again says `after=N`. A read get_version's caller cancelled is `status=aborted`, and isn't counted.

A slow or failed read's line also says whether the server itself was stuck: `eld` and `eldMax` are how late its event loop ran (the 99th percentile and the longest delay, in ms) and `elu` how busy it was (in %). Every server starts a new window once a minute: for the hub's own read the figures cover that read, and for get_version's read the time since the last minute began. A low `eldMax` usually means the server waited on the extension or Teams, but a stall that ended in the same turn as the reply may not be counted yet: then `elu` is still high, and the next `loop-delay` line shows the stall; an `eldMax` near the read's `ms` means its own loop was blocked, by its own work when `elu` is high, or because the process didn't run at all (Windows throttling, sleep) when `elu` is low. Every server, hub or peer, also writes `loop-delay eld=… eldMax=… elu=…` at the end of a minute whose longest delay reached 1 s, for the 1st and every 10th such minute in a row; a quiet server writes nothing.

```
2026-11-17T07:18:29.240Z pid=42868 teams v=0.3.74 role=hub status=unreadable kind=timeout ms=15004 failures=1 eld=21 eldMax=14870 elu=97
2026-11-17T07:19:14.020Z pid=42868 loop-delay v=0.3.74 role=hub eld=22 eldMax=14870 elu=31
```

It holds metadata only: never message text, names, chat ids, tokens, regions or who is signed in. With several AI sessions, all of their servers write to the same file (each line names its `pid`). For a `[Hub health]` report, attach `server.log` (and `server.log.1`) first. A file like `server.log.1234-ab12cd34.rotating` is an older part of the log that couldn't be moved to `server.log.1` because another program (a virus scanner, a viewer) held that open; attach it too. Such a file is removed at a rotation once it is a day old (counted from when it was set aside or last written to), so attach it before then, or delete it. `server.log.lock` (and `hub.log.lock` for the native host's log) exists only while a server moves the log; one left by a server that died then is removed after 30 s.

With the native host on, the host writes `~/.mcp-teams/hub.log` the same way (metadata only, moved to `hub.log.1` past 1 MB). Among its lines: `extension-dropped reason=no-pong transport=…` (the host dropped a browser connection, such as one relayed from another browser's host, that stopped answering its pings), `peer-left via=…` (a server left the host; with `reason=no-pong` or `reason=backlog` when the host dropped it), and, from a relaying host, `relay-closed code=…` (its connection to the serving host closed; the next line says whether it took over, relayed again or exited).

### When the extension's console shows connection errors

While no mcp-teams server is listening on the bridge port (`port`, 47393 by default), the extension's console (and its Errors page in `chrome://extensions`) shows lines like this (with your own port number if you changed it):

```
WebSocket connection to 'ws://127.0.0.1:47393/' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED
```

That's expected when no AI app runs mcp-teams, or for a moment while sessions hand the bridge over to each other. Chrome writes the line itself for each attempt; the extension can't hide it. The extension keeps retrying (quickly at first, then every 30 s) and connects by itself once a server listens. It needs looking into only if `get_version` keeps reporting the extension as not connected (`extension: null`, `bridge: "waiting for extension"`) while a server is running. If you changed `port`, set the same port in the extension popup too: a mismatch also gives these lines.

During a hand-over you may also see, once or twice:

```
WebSocket connection to 'ws://127.0.0.1:47393/' failed: Error during WebSocket handshake: net::ERR_CONNECTION_RESET
```

or, more rarely, `Unexpected response code: 426`. Both are harmless. A server that hands the bridge to another session, or exits, closes its listening socket, and the operating system resets any connection that was still waiting to be picked up, even though the extension had already sent its handshake (a 426 is one that arrived just as the server stopped taking upgrades). Nothing had been sent on that connection, so no call is lost. The extension retries by itself and connects to the next server within a second or two (#212).

### When Teams has no session

`get_version` showing `teamsTabs: 1` (or more) but `sessionCaptured: false` means the extension hasn't seen Teams sign in to its chat service. The extension always keeps when the Teams tab last made a call (`lastTeamsCall`) and when it last made a signed-in one (`lastSignedInCall`), only the time and the host, and `get_version` adds a `note` naming the case:

- **Stuck at sign-in**: the tab has made no signed-in call at all, or none for more than 5 minutes while it keeps making other calls. Within about a minute and a half of a browser start or an extension load, the extension tries to bring the session back by itself; if `get_version` still says so after that, open the Teams tab and finish signing in: an account picker, a sign-in page or a prompt may be waiting there.
- **Asleep**: the tab has made no calls for more than 5 minutes (or none at all). Click into the Teams tab, or add `teams.cloud.microsoft` to Chrome's *Always keep these sites active* (Settings > Performance) so Chrome doesn't put it to sleep.
- **Missed by the capture**: the tab made a signed-in call to a Teams service (chat, teams, people or search) in the last 5 minutes, but no chat session was captured. Refresh the Teams tab or reload the extension; if that doesn't help, it's a bug in mcp-teams: please report it. In the sideloaded copy, add `api_traffic` output (call it with `record: true`, use Teams for a minute, then call it again); the web store copy doesn't record it.

A tool call that fails because the chat, team list or people session is missing gives the same note in place of "Reload the Teams tab and try again" (e.g. "Teams' chat session is not available. The Teams tab hasn't made a signed-in call since …"). Such a call has already waited for the session to come back (for the Teams tab while it is still loading, else for the extension's own attempt in a background tab), so when stuck at sign-in it says to finish signing in right away. When there is nothing to name (the chat session is there, or the extension is older than 0.3.46), and for search's session, the error stays as it was.

These times live in the browser's session storage like the sessions themselves: a restart of the browser (or a reload of the extension) clears them.

### Switching accounts

When Teams switches to another account or tenant, the extension follows Teams' first request as the new account and forgets what the previous one saw. For 30 s after a switch, a request Teams retries with the previous account's older token (issued before the one that switched) doesn't switch back: it is ignored, and `get_version` counts it in `teams.droppedOldCaptures` (`count`, and `lastAt`, the time of the last one; no account data). A real switch back brings a newer token and takes effect at once. Either way, once the previous account shows again within those 30 s (ignored or switching back), it isn't certain which account Teams shows: until that switch's 30 s are over the account is *unsure* (`teams.accountUnsure` in `get_version`, with `since` and `until`; else `null`), a send is refused at once with the time to try again, and a read goes on with an `accountNote`. A request that had to wait before it went out (Teams' throttling) or that the extension would send again (after the throttling, or in another Teams tab after its own was closed) fails with "account changed" instead when the account changed meanwhile: it is never sent as the previous account.

## Setup

You need [Node.js](https://nodejs.org) 20 or later, and Chrome or Edge. Then, in a terminal:

```sh
npx mcp-teams setup
```

`setup` does the rest and can be run again at any time:

- It registers the server with the AI apps it finds: Claude Code, Claude Desktop, Cursor, VS Code (Copilot), Windsurf, Gemini CLI, Antigravity CLI and Codex. It shows what it will change and asks first (`--yes` skips the question). It only adds or updates its own `teams` entry, and keeps a `.mcp-teams.bak` copy of each file it changes. For other MCP clients, register `npx -y mcp-teams@latest` as a stdio server.
- It installs the extension in `~/.mcp-teams/extension`.
- It opens the Extensions page of Chrome and/or Edge, and that folder. The one manual step is in the browser you use Teams in: turn on *Developer mode* and click *Load unpacked* on the folder.
- It waits until the extension connects and Teams answers, then says *Ready*.

Restart the AI apps it registered (in Claude Code: `/mcp`).

You don't need to keep Teams open for most tools. When no Teams tab is open, the extension opens one itself (pinned, in the background) and waits up to a minute for it to sign in. The exceptions are `list_teams` and `list_chats`, which fail at once with an error saying there is no Teams tab open. With several browsers connected, these two go to a browser that has a Teams tab open, if one has.

## How it reaches Teams

Teams on the web talks to several services, each with its own sign-in token: chats and messages (`chatsvc`), the team and chat list (`csa`), people (`mt`) and search (`substrate.office.com`). The extension notes the tokens Teams sends on its own requests and replays them from inside the Teams tab. They are kept in the browser's session memory and never leave the browser. Teams calls most of these services as soon as it loads. Search may only be signed in once you have used Teams' search box; until then `search_messages` and `find_people` say so.

The extension never reloads your Teams tab, so a call, meeting, draft or screen share there goes on. When a tool needs a session that isn't there, or Teams rejects one (tokens expire after about an hour), Teams' own tab gets a few seconds to send a fresh one; if it doesn't (and at once after a rejection), the extension opens Teams in a background tab, notes the tokens from that tab's requests and closes it again as soon as the sessions the waiting calls need are back, or after at most a minute (it stays open if you switch to it, and closing it ends the wait). There is only ever one such tab: calls that need different services at the same time wait on the same one. No tab is opened while your Teams tab is still loading, since it signs in by itself; the call waits up to 30 s for it instead. If the session still isn't back, the call says so and asks you to reload Teams yourself. Search is the exception: Teams signs in to it only once you have used its search box, so no tab is opened for it, and `search_messages` and `find_people` say so after a short wait.

The sessions are kept in memory only, so the browser clears them when it restarts and when the extension is reloaded or updated. An idle Teams tab, such as one restored at a browser start, may not call its services again until you use it. So once per browser session the extension checks for a Teams tab that has loaded, is awake and hasn't brought the chat session back: right after the start, reload or update, then every 30 s until it finds one. That tab gets 15 s to send the session; if it doesn't, the extension opens Teams in the same kind of background tab until the chat session is back, or for at most about a minute. A tool call made meanwhile uses that tab too. Nothing is opened while no Teams tab is open, while the Teams tab is still loading (it signs in by itself), or while the browser has put every Teams tab to sleep (discarded). This happens at most once per browser session, so a Teams tab stuck at sign-in doesn't get a new background tab every 30 s.

## Several sessions at once

Every AI session starts its own mcp-teams server, and they share the one extension connection. The first server owns the bridge port (`role: "hub"` in `get_version`), and later ones forward their calls through it (`role: "peer"`). When the hub's session ends, it first lets other sessions' calls that are already running finish, for up to 5 s (`TEAMS_MCP_DRAIN_MS` changes that; a send whose confirmation window is still open is withdrawn then, so nothing posts late), and calls made meanwhile fail as not sent ("try again in a few seconds"). Then a peer takes over within a second. A newer server takes over from an older one. Servers of 0.2.0 and older can't do the newer handshake: after updating from them, restart AI sessions that are still open (in Claude Code: `/mcp`).

A server that is already running keeps its code when the copy on disk changes (`git pull` and `npm run build`). It notices: `get_version` then shows `restartNeeded: true` with the build on disk, and every failed tool call ends with a line saying to reconnect it with `/mcp`, and to reload the extension if it changed too. It compares its version and build id with those in `dist/build.json` on disk. The build id is a hash of the server code (`dist/**/*.js`) and of the extension it ships (`extension/`, without the `pairing.json` that only the installed copy has). So a release that changes only the extension counts as a new build too, and a rebuild that changes nothing doesn't. The same files give the same build id on Windows and Linux.

## Configuration

`~/.mcp-teams/config.json` is created on first run:

| Key | Env override | Default |
|---|---|---|
| `token` | — | random, generated once; the server, its peers and the extension prove to each other that they know it |
| `port` | `TEAMS_MCP_PORT` | `47393` (also set it in the extension popup) |
| `autoSendTo` | — | `[]`: every send shows the confirmation window |

`autoSendTo` is a list of your own email addresses (or UPNs), compared without regard to case or surrounding spaces, e.g. `"autoSendTo": ["you@example.com"]`. With it, `send_message` posts without the confirmation window when the message goes to you alone: your notes-to-self chat, a chat whose only member is you, or `to` with just your own address. The extension decides this itself after resolving the target: it looks up your profile and posts without asking only if one of your own addresses is on the list. Anything else (other people, group chats you are in, meetings, channels, a chat or profile it can't look up) shows the window as usual. The result then says `autoSent: true`. A send that began before Teams had shown who is signed in never goes without the window. A `to` send then first waits for Teams' session, as any lookup does, and so learns who is signed in. Every send in that case shows the window only when its lookups reveal the account, and the window is for that account. Otherwise it is refused ("Teams hasn't shown who is signed in yet"): reload the Teams tab and send again. A send whose lookups spanned a switch of the signed-in account (even a switch back) posts nothing and opens no window ("changed while this send was being prepared"): check who is signed in and send again. A value that isn't a list of email addresses stops the server with an error. Restart the AI session after changing it.

## Security notes

- The bridge listens only on `127.0.0.1`. Web pages can't connect to it, because only extension origins are accepted.
- The server and the extension prove to each other that they know the pairing token in `~/.mcp-teams/config.json`, without sending it. Setup copies it into the installed extension folder as `pairing.json`; both files can be read only by your user. So a program that takes the port while no AI app runs gets nothing from the extension, and a program posing as the extension gets no calls.
- Teams' tokens are only ever sent to the service they were captured from.
- Messages can contain prompt injection. The send-confirmation window is the safeguard, so read it before clicking Send. With `autoSendTo` set, messages to yourself alone skip it (see Configuration).
- The extension asks for `storage`, `scripting`, `webRequest`, `alarms` and `nativeMessaging`, and for five hosts: `teams.cloud.microsoft`, `teams.microsoft.com`, `*.ng.msg.teams.microsoft.com` (Teams' chat service), `substrate.office.com` (search) and `*.sharepoint.com` (meeting transcripts). The web store copy asks for those five hosts only. The sideloaded copy (the one `setup` installs, which keeps the repo's `key`, or a clone loaded unpacked) also asks for the Microsoft hosts `api_traffic` records (see the next point). It doesn't ask for `tabs` (no "Read your browsing history" warning): it finds Teams and SharePoint tabs through those host permissions, and doesn't see the address of any other tab. The web store copy observes requests only to the five hosts; the sideloaded copy also observes requests to the `api_traffic` hosts, and keeps them only while recording is on. Of requests to the five hosts, either copy keeps only the sessions it replays and the time and host of the Teams tab's last call and last signed-in call (see *When Teams has no session*). It runs requests only in Teams tabs, and in SharePoint tabs to read transcripts.
- `api_traffic` needs the Microsoft hosts the Teams tab calls (`*.microsoft.com`, `*.office.com`, `*.svc.ms` and similar, `https://` and `wss://`), which only the sideloaded copy's manifest requests; the web store copy's leaves them out, so there it isn't available (see *Development*). In the sideloaded copy, it records only requests made by the Teams tab, only names, and only while recording is on, including WebSocket handshakes (`wss://`) and beacons, never what a socket carries.
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
npm test                   # builds, then runs unit, integration and system tests (see docs/testing.md)
npm run probe -- status    # calls one extension method through the bridge (see scripts/probe.mjs)
npm run package-extension  # the zip for the Chrome Web Store and Edge Add-ons (see docs/extension-ids.md)
```

Two development aids:

- **`api_traffic`** listens on the hosts in `TRAFFIC_URLS` and `TRAFFIC_WS_URLS` (`extension/teams.js`). The repo's `extension/manifest.json` requests them, so the sideloaded copy (a clone loaded unpacked, or the copy setup installs) records with no edit. `npm run package-extension` leaves them out of the web store zip's manifest, which requests only the five Teams and SharePoint hosts (`EXTENSION_HOSTS` in `extension/teams.js`), so the web store copy answers that `api_traffic` isn't available in this build.
- **`npm run probe -- probe '{…}'`** (a GET on any Teams service path or SharePoint URL) is refused until you turn it on in that browser: in `chrome://extensions`, open the mcp-teams bridge's *service worker* console and run `chrome.storage.local.set({ devProbe: true })` (`chrome.storage.local.remove("devProbe")` turns it off). Other `npm run probe` methods need nothing.

The server, the native host and setup trust a fixed list of extension ids: the sideloaded copy's (from the manifest's `key`) and, once the web stores have assigned them, the Chrome Web Store's and Edge Add-ons'. Adding a web store id is one line in `src/extension.ts`, then run setup again; see [docs/extension-ids.md](docs/extension-ids.md).

Versions are bumped automatically. On every push to `main` (except Markdown-only changes), the **Version bump** GitHub Action runs the tests, then bumps `package.json` and `package-lock.json`, commits `chore(release): vX.Y.Z` and tags it. It bumps the extension (`extension/manifest.json`) on its own line only when files under `extension/` changed since its last `ext-vX.Y.Z` tag, by the same rules applied to the commits that changed it; the commit then says `chore(release): vX.Y.Z (extension A.B.C)` and both tags are pushed with it. While a version is below 1.0.0, a breaking change (`type!:` or a `BREAKING CHANGE:` footer) bumps the minor version and anything else, `feat:` included, the patch. From 1.0.0 on it's standard semver: breaking → major, `feat:` → minor, anything else → patch.

Every pull request and every push to `main` is also scanned for committed secrets by the **Secret scan** GitHub Action (gitleaks). Known false positives go in `.gitleaksignore`.
