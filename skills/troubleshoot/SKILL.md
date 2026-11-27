---
name: troubleshoot
description: Diagnose and fix mcp-teams when Teams tools fail - extension not connected, no Teams session, wrong account, server or extension needing a restart or update. Use when a Teams tool returns an error, times out, or the user says the Teams connection isn't working.
---

# Troubleshoot mcp-teams

mcp-teams reaches Teams through a browser extension that works in the user's signed-in Teams web tab. Most failures are one of the cases below. Start with `get_version`: it reads the state of every part.

## Read `get_version`

| Field | Meaning | What to tell the user |
|---|---|---|
| `bridge: "waiting for extension"` | No browser extension is connected | Open Chrome or Edge; the extension connects within 30 s. If it stays disconnected, open `chrome://extensions`, reload mcp-teams and look for errors, then reload the Teams tab. |
| `bridge` is an error text | This server could not open its port | Usually another program holds it; quote the error. |
| `extensionSupported: false` | The extension is too old for this server | Follow the `hint`; reloading the extension usually updates it (`reload_extension`). |
| `missingFeatures` not empty | The extension lacks features this server uses | Same: reload or update the extension. |
| `restartNeeded: true` | mcp-teams was updated on disk, this server still runs the old code | Reconnect the server (Claude Code: `/mcp`), then reload the extension if it changed too. |
| `teams` with a `note` | The Teams tab has no session | Follow the note: usually open or reload `teams.microsoft.com` and sign in. |
| `teams.accountUnsure: true` | The account in the tab changed recently | Reload the Teams tab and check the signed-in account. |
| `twoCopies` | Two copies of the extension in one browser | Remove the copy the note names. |

## Common tool errors

- **Fails at once with no Teams tab**: the list tools and reads need a Teams tab open in the browser. Ask the user to open one.
- **A name matched several conversations or people**: the error lists the matches. Ask the user which one, or use the id from `list_chats` / `list_teams` / `find_people`.
- **Send window refused or closed**: `reload_extension` is refused while a send confirmation window is open; ask the user to finish or close it first.
- **A send whose call was lost**: the message may have been posted. Check with `read_messages` before sending it again. Never resend blindly.
- **Timeouts on transcripts**: transcripts are read from the organizer's OneDrive. An external meeting's transcript is usually not readable. Retry once; if it fails again, say so.

## Reloading

`reload_extension` reloads the extension from disk and waits for it to reconnect, returning the version before and after. Use it after an update or when the extension is in a bad state, not as a first step for every error.

Do not ask the user for tokens or to edit config files unless `get_version` points there. The pairing token is set up by `npx mcp-teams setup`.
