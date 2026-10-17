import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExtensionBridge } from "./bridge.js";
import type { Config } from "./config.js";
import { SERVER_VERSION } from "./config.js";

/** Sending waits for the user's click in the confirmation window (5 minutes at most). */
const SEND_TIMEOUT_MS = 6 * 60_000;
/** Reading follows paging links, and the first call may open a Teams tab. */
const READ_TIMEOUT_MS = 120_000;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

/**
 * The bridge's own errors for a call that was already sent, so its outcome is unknown (see
 * src/bridge.ts; a hub relays them to peers word for word). Matched at the start: an error
 * the extension answered with (it refused before any window opened) may quote such words.
 */
const OUTCOME_UNKNOWN =
  /^(Extension call '[^']*' timed out|Cancelled: the request was withdrawn|Browser extension (disconnected|reconnected)|The mcp-teams hub restarted|mcp-teams is shutting down|mcp-teams was updated|Bridge connection error|bridge server error|The response was too large)/;

/** What the MCP SDK passes a tool besides its arguments: `signal` aborts when the AI app cancels the call. */
type Extra = { signal?: AbortSignal };

/**
 * Wraps a handler so thrown errors become MCP tool errors instead of protocol errors.
 * Handlers pass extra.signal to bridge.call, so cancelling a tool withdraws its extension call.
 */
function safe<A, E extends Extra = Extra>(fn: (args: A, extra: E) => Promise<ReturnType<typeof text>>) {
  return async (args: A, extra: E) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(err);
    }
  };
}

const conversation = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Which chat or channel: its id from list_chats/list_teams (19:…), 'Team/Channel' (e.g. 'Engineering/General'), a chat title, or a person's name for your 1:1 chat with them. A name must match exactly one conversation, otherwise the matches are listed.",
  );

type Message = { text: string; truncated?: boolean; replies?: Message[] };

/** The first `n` UTF-16 units of `text`, one fewer if the last would be half a surrogate pair (extension/teams.js cutAt). */
function cutAt(text: string, n: number): string {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Cuts long message texts (pasted logs, long mails) so a conversation stays readable. The
 * extension cuts them already (maxLength); this cuts for older extensions that don't, and
 * leaves a text it cut alone.
 */
function capText<T extends Message>(messages: T[], maxLength: number): T[] {
  const cut = (m: Message): Message => {
    const r = !m.truncated && m.text.length > maxLength ? { ...m, text: `${cutAt(m.text, maxLength)}…`, truncated: true } : m;
    return r.replies ? { ...r, replies: r.replies.map(cut) } : r;
  };
  return messages.map(cut) as T[];
}

export function registerTools(server: McpServer, bridge: ExtensionBridge, config: Config) {
  server.registerTool(
    "get_version",
    {
      title: "Version and connection status",
      description:
        "Shows the mcp-teams server version, the browser extension version, and whether Teams is reachable (which of its services have a session).",
      inputSchema: {},
    },
    safe(async (_, extra) => {
      let teams: unknown = null;
      if (bridge.connected) {
        teams = await bridge.call("status", {}, undefined, extra.signal).catch((e: Error) => ({ error: e.message }));
      }
      return text({
        server: SERVER_VERSION,
        extension: bridge.extension?.version ?? null,
        browser: bridge.extension?.browser ?? null,
        // With several browsers connected, calls go to the one shown above.
        ...(bridge.extensions.length > 1
          ? { browsers: bridge.extensions.map((e) => ({ browser: e.browser ?? null, version: e.version })) }
          : {}),
        versionsMatch: bridge.extension ? bridge.extension.version === SERVER_VERSION : null,
        bridge: bridge.listenError ?? (bridge.connected ? "connected" : "waiting for extension"),
        // hub: this session owns the port; peer: it forwards through another session's server.
        role: bridge.role,
        ...(bridge.role === "peer" ? { hubServer: bridge.hubVersion } : {}),
        port: config.port,
        teams,
      });
    }),
  );

  server.registerTool(
    "reload_extension",
    {
      title: "Reload the browser extension",
      description:
        "Reloads the mcp-teams browser extension from disk, e.g. after an update changed it, and waits until it is connected again. Returns the extension version before and after. Refused while a send confirmation window is open.",
      inputSchema: {},
    },
    safe(async () => {
      const r = await bridge.reloadExtension();
      return text({ ...r, server: SERVER_VERSION, versionsMatch: r.after === SERVER_VERSION });
    }),
  );

  server.registerTool(
    "api_traffic",
    {
      title: "Show the Teams web app's API calls (diagnostic)",
      description:
        "Lists the API endpoints the open Teams tab has called since the browser started: method, host, path, status, which headers were sent (names only, never values) and the auth scheme. Used to find out which API Teams uses for a feature: click through it in Teams first.",
      inputSchema: {
        filter: z.string().optional().describe("Only requests whose host or path contains this text"),
        limit: z.number().int().min(1).max(400).default(100),
        clear: z.boolean().default(false).describe("Clear the recorded traffic after returning it"),
      },
    },
    safe(async (args, extra) => text(await bridge.call("apiTraffic", args, undefined, extra.signal))),
  );

  server.registerTool(
    "list_teams",
    {
      title: "List teams and channels",
      description:
        "Lists the teams you are a member of, each with its channels. Use 'Team/Channel' or a channel id as the conversation for read_messages and send_message.",
      inputSchema: {
        include_ids: z.boolean().default(false).describe("Also return team and channel ids (long; 'Team/Channel' names are enough to address channels)"),
      },
    },
    safe(async ({ include_ids }, extra) => {
      type Team = { id: string; name: string; channels: { id: string; name: string }[] };
      const r = await bridge.call<{ teams: Team[] }>("listTeams", {}, READ_TIMEOUT_MS, extra.signal);
      return text(
        include_ids
          ? r
          : { teams: r.teams.map(({ id, channels, ...t }) => ({ ...t, channels: channels.map(({ id: _, ...c }) => c) })) },
      );
    }),
  );

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "Lists your chats (1:1, group and meeting chats), most recent first, with their title (or the other members' names), the last message and whether it is unread. Returns ids for read_messages and send_message.",
      inputSchema: {
        query: z.string().optional().describe("Only chats whose title or a member's name contains these words"),
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    safe(async ({ query, unread_only, limit }, extra) =>
      text(await bridge.call("listChats", { query, unreadOnly: unread_only, limit }, READ_TIMEOUT_MS, extra.signal)),
    ),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read a chat or channel",
      description:
        "Reads the latest messages of a chat or channel, oldest first: sender, time, text (formatting removed), files shared and reactions. In channels, replies are nested under their post (a reply whose post is on an older page comes on its own, with replyTo). To read further back, pass the returned olderCursor as `cursor` (with the same conversation and reply_to); it is there whenever older history exists, so keep paging while it is returned. A page usually costs one or two Teams requests, but one call reads at most 20 pages of Teams history: it may then return fewer messages than asked, even none, with `truncated: true`, a note and an olderCursor to go on. `before` (a time) also works but re-reads from the newest message each call, so it hits that limit sooner. Give cursor or before, not both. With reply_to, reads one channel post's whole thread.",
      inputSchema: {
        conversation,
        limit: z.number().int().min(1).max(200).default(30).describe("How many messages (channel: posts, each with its replies)"),
        cursor: z.string().max(4096).optional().describe("Continue from olderCursor of a previous call on the same conversation (opaque; pass it exactly as returned)"),
        before: z.string().optional().describe("Only messages older than this time (ISO 8601, e.g. olderBefore from a previous call). Prefer cursor for paging"),
        reply_to: z.string().optional().describe("Channel only: the id of a post, to read its thread"),
        include_system: z.boolean().default(false).describe("Also return events such as members added or calls started"),
        max_length: z.number().int().min(100).max(100_000).default(4_000).describe("Maximum length of each message's text"),
      },
    },
    safe(async ({ conversation, limit, cursor, before, reply_to, include_system, max_length }, extra) => {
      const r = await bridge.call<{ messages: Message[] }>(
        "readMessages",
        { conversation, limit, cursor, before, threadId: reply_to, includeSystem: include_system, maxLength: max_length },
        READ_TIMEOUT_MS,
        extra.signal,
      );
      return text({ ...r, messages: capText(r.messages, max_length) });
    }),
  );

  const meeting = z
    .string()
    .trim()
    .min(1)
    .describe("Which meeting: its chat id from list_meetings (19:meeting_…) or its title. A title must match exactly one meeting chat.");

  server.registerTool(
    "list_meetings",
    {
      title: "List Teams meetings",
      description:
        "Lists your Teams meetings (each scheduled meeting or recurring series has a meeting chat), most recent activity first: subject, scheduled time (for a series, its first occurrence), organizer, whether a transcript exists, and whether another organization hosted it (`external`: its chat and recordings are usually no longer readable afterwards). Use get_meeting for the calls held and who attended, read_transcript for what was said, read_messages for the meeting chat.",
      inputSchema: {
        query: z.string().optional().describe("Only meetings whose subject or organizer contains these words"),
        transcript_only: z.boolean().default(false).describe("Only meetings with a transcript"),
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    safe(async ({ query, transcript_only, limit }, extra) =>
      text(await bridge.call("listMeetings", { query, transcriptOnly: transcript_only, limit }, READ_TIMEOUT_MS, extra.signal)),
    ),
  );

  server.registerTool(
    "get_meeting",
    {
      title: "Get a meeting's calls and attendance",
      description:
        "One meeting with the calls held in it, newest first (a recurring meeting has one per occurrence): when it started and ended, who joined, the recording's link, and whether there is a transcript.",
      inputSchema: {
        meeting,
        limit: z.number().int().min(1).max(100).default(10).describe("Most recent calls to return"),
      },
    },
    safe(async (args, extra) => text(await bridge.call("getMeeting", args, READ_TIMEOUT_MS, extra.signal))),
  );

  server.registerTool(
    "read_transcript",
    {
      title: "Read a meeting transcript",
      description:
        "What was said in a meeting, from its Teams transcript: lines '[hh:mm:ss] Speaker: text', plus how long each speaker talked. Reads the latest call with a transcript unless `session` names another. Long transcripts are cut at max_length; pass the returned continueFrom as `from` to read on. Transcripts are stored in the organizer's OneDrive, so this may open OneDrive in a background tab.",
      inputSchema: {
        meeting,
        session: z.string().optional().describe("Which call: its callId from get_meeting, or its start date/time prefix (e.g. '2026-10-06')"),
        from: z.string().regex(/^\d{1,2}(:\d{1,2}){0,2}$/).optional().describe("Start at this point of the meeting, 'hh:mm:ss' or 'mm:ss'"),
        max_length: z.number().int().min(1000).max(200_000).default(40_000).describe("Most characters of transcript to return"),
      },
    },
    safe(async ({ meeting, session, from, max_length }, extra) =>
      text(await bridge.call("readTranscript", { meeting, session, from, maxLength: max_length }, READ_TIMEOUT_MS, extra.signal)),
    ),
  );

  server.registerTool(
    "search_transcripts",
    {
      title: "Search meeting transcripts",
      description:
        "Finds what was said in meetings: the transcript lines containing all words of the query, each with the line before it, from the most recent meetings with a transcript (or one meeting). Then read_transcript with `from` reads around a match.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Words that must all appear in a line (case-insensitive)"),
        meeting: meeting.optional(),
        meetings: z.number().int().min(1).max(50).default(10).describe("How many of the most recent meetings with a transcript to search"),
        limit: z.number().int().min(1).max(200).default(30).describe("Most matching lines to return"),
      },
    },
    safe(async (args, extra) => text(await bridge.call("searchTranscripts", args, 300_000, extra.signal))),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Searches all your Teams chats and channels with Microsoft Search, like the search box in Teams. Returns matching messages with their conversation id (for read_messages), sender, time and a highlighted excerpt.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Words to search for; Teams search syntax such as from:alice or \"exact phrase\" works too"),
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).default(0),
      },
    },
    safe(async (args, extra) => text(await bridge.call("searchMessages", args, READ_TIMEOUT_MS, extra.signal))),
  );

  server.registerTool(
    "find_people",
    {
      title: "Find people",
      description:
        "Looks people up by name or email in your organization (and people you work with), as in Teams' people picker: name, email, job title, department, office.",
      inputSchema: {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    safe(async (args, extra) => text(await bridge.call("findPeople", args, READ_TIMEOUT_MS, extra.signal))),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message (needs your click)",
      description:
        "Asks to post a message in an existing chat or channel (conversation), to reply to a channel post, or to start a chat with people (to): one person for a 1:1 chat, several for a group chat. If a chat with exactly those people already exists, the message goes there. The extension shows a confirmation window with the message, where it goes and who is in a new chat; nothing is posted, and no chat is created, unless the user clicks Send there. Returns whether it was sent. Plain text; line breaks are kept and links become clickable.",
      inputSchema: {
        conversation: conversation.optional(),
        to: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(250)
          .optional()
          .describe(
            "Instead of conversation: the people to chat with, by name or email (e.g. ['김민준', 'ana@example.com']). Each must match exactly one person in your organization, otherwise the matches are listed.",
          ),
        title: z.string().trim().min(1).max(255).optional().describe("With to (two or more people): a title for the new group chat"),
        text: z.string().min(1).max(28_000).describe("The message"),
        reply_to: z.string().optional().describe("Channel only: the id of the post to reply to (from read_messages). Without it, a new post is started."),
        subject: z.string().optional().describe("Channel only: a subject for a new post"),
      },
    },
    // A cancelled call withdraws the send: the confirmation window closes and nothing is sent.
    safe(async ({ conversation, to, title, text: message, reply_to, subject }, extra) => {
      if (!conversation === !to) throw new Error("Give either conversation (an existing chat or channel) or to (people to start a chat with).");
      try {
        return text(await bridge.call("requestSend", { conversation, to, title, text: message, threadId: reply_to, subject }, SEND_TIMEOUT_MS, extra.signal));
      } catch (err) {
        const message = (err as Error).message;
        // The bridge lost the call after it was sent (its own messages, also as relayed by a hub):
        // the user may have clicked Send just before, so retrying blindly could post twice.
        if (!OUTCOME_UNKNOWN.test(message)) throw err;
        throw new Error(`${message} The message may have been posted if the user had just clicked Send: check with read_messages before sending again.`);
      }
    }),
  );
}
