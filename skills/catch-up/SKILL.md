---
name: catch-up
description: Catch up on Microsoft Teams - find unread chats and channel posts that need the user, summarize them by priority, and draft replies that are only sent after the user confirms each one. Use when the user asks what they missed in Teams, to triage unread messages, or to clear their Teams inbox.
---

# Catch up on Teams

Goal: a short, prioritized picture of what needs the user in Teams, then replies they approve one by one.

## 1. Collect

1. `list_chats` with `unread_only: true` and `refresh: true` (the list is otherwise up to a minute old, and the unread state lags). Raise `limit` if the user has been away for long.
2. If the user named people, topics or a time window, narrow with `list_chats` `query`, or use `search_messages` (Teams search syntax works: `from:alice`, `"exact phrase"`).
3. For each unread chat, `read_messages` with the chat id from the list and a small `limit` (10-20). Read further back with `olderCursor` only when the thread does not make sense without it.
4. Channels: `list_teams` lists teams and channels but not their unread state. Read a channel only when the user asks for it or a chat points to it (`'Team/Channel'` works as `conversation`).

Do not read every chat in full: a long backlog costs many Teams requests. Prefer breadth first, depth only where needed.

## 2. Summarize

Group what you found, most urgent first:

- **Needs a reply or decision**: direct questions, requests, @mentions, deadlines. Quote the ask in a few words, say who asked and when.
- **FYI**: updates the user should know about, no action.
- **Noise**: bots, reactions-only, system events. Count them, don't list them.

Keep each item to one or two lines with the chat name. Use the senders' names as Teams shows them. Times are as Teams recorded them; say "today 09:14" rather than raw ISO strings.

## 3. Reply (only with the user)

Never send on your own initiative. Propose a draft for each item that needs a reply and wait for the user to approve or edit it.

Then call `send_message` with the chat id as `conversation` (or `reply_to` with the post id for a channel thread). The browser extension opens a confirmation window: nothing is posted until the user clicks Send there. Tell the user to look for it.

If `send_message` fails saying the call was lost, the message may still have been posted: check with `read_messages` before sending it again. A result with `time: null` and a `timeNote` was posted; do not send it again.

If a tool fails because Teams or the extension isn't reachable, use the `troubleshoot` skill.
