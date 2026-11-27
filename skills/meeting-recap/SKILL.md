---
name: meeting-recap
description: Recap a Microsoft Teams meeting from its transcript - who attended, the decisions made, action items with owners, and open questions, with timestamps to check against. Use when the user asks what happened in a meeting, for meeting minutes or notes, for action items from a call, or what someone said in a meeting.
---

# Recap a Teams meeting

## 1. Find the meeting

- `list_meetings` with `query` (subject or organizer words) and `transcript_only: true`. If several match, ask the user which one, showing subject, time and organizer.
- A meeting with `external: true` was hosted by another organization: its transcript is usually not readable afterwards. Say so instead of retrying.
- `get_meeting` lists the calls held in it, newest first (a recurring meeting has one per occurrence), with who joined and whether each has a transcript. Pick the occurrence the user means (by date) and keep its `callId` to pass as `session` below.

## 2. Read the whole transcript

- `read_transcript` with the meeting's chat id and `session` (the `callId`, or a date prefix such as `2026-10-06`). Without `session` it reads the latest call with a transcript.
- Long transcripts are cut at `max_length`: keep calling with `from` set to the returned `continueFrom` until there is none. Do not summarize from the first part only.
- Transcripts live in the organizer's OneDrive; the extension may open OneDrive in a background tab. That is expected.
- To answer "what did X say about Y", start with `search_transcripts` (all words must appear in a line), then `read_transcript` with `from` a little before the match for context.

## 3. Write the recap

Use the language of the meeting unless the user asks otherwise. Structure:

1. **Header**: subject, date and time, organizer, attendees (from `get_meeting`), length.
2. **Summary**: three to five sentences on what the meeting was for and where it landed.
3. **Decisions**: one line each, with the `[hh:mm:ss]` where it was made.
4. **Action items**: owner, task, due date if one was said, timestamp. Only what someone actually agreed to; do not invent owners or dates. Mark unclear ones "owner unclear".
5. **Open questions / risks** raised and not resolved.

Attribute statements to the speaker names in the transcript. Transcription can mishear names and numbers: flag anything that looks garbled rather than guessing.

## 4. Share (only if asked)

If the user wants the recap posted, find the meeting chat (`list_meetings` gives its id) and use `send_message` with it as `conversation`. The extension asks the user to confirm before anything is posted. Plain text only: keep the structure with line breaks and simple dashes.
