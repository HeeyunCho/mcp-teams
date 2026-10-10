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

/** Wraps a handler so thrown errors become MCP tool errors instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
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

type Message = { text: string; replies?: Message[] };

/** Cuts long message texts (pasted logs, long mails) so a conversation stays readable. */
function capText<T extends Message>(messages: T[], maxLength: number): T[] {
  const cut = (m: Message): Message => {
    const r = m.text.length > maxLength ? { ...m, text: `${m.text.slice(0, maxLength)}…`, truncated: true } : m;
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
    safe(async () => {
      let teams: unknown = null;
      if (bridge.connected) {
        teams = await bridge.call("status").catch((e: Error) => ({ error: e.message }));
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
    "list_teams",
    {
      title: "List teams and channels",
      description:
        "Lists the teams you are a member of, each with its channels. Use 'Team/Channel' or a channel id as the conversation for read_messages and send_message.",
      inputSchema: {
        include_ids: z.boolean().default(false).describe("Also return team and channel ids (long; 'Team/Channel' names are enough to address channels)"),
      },
    },
    safe(async ({ include_ids }) => {
      type Team = { id: string; name: string; channels: { id: string; name: string }[] };
      const r = await bridge.call<{ teams: Team[] }>("listTeams", {}, READ_TIMEOUT_MS);
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
    safe(async ({ query, unread_only, limit }) =>
      text(await bridge.call("listChats", { query, unreadOnly: unread_only, limit }, READ_TIMEOUT_MS)),
    ),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read a chat or channel",
      description:
        "Reads the latest messages of a chat or channel, oldest first: sender, time, text (formatting removed), files shared and reactions. In channels, replies are nested under their post. To read further back, pass the returned olderBefore as `before`. With reply_to, reads one channel post's whole thread.",
      inputSchema: {
        conversation,
        limit: z.number().int().min(1).max(200).default(30).describe("How many messages (channel: posts, each with its replies)"),
        before: z.string().optional().describe("Only messages older than this time (ISO 8601, e.g. olderBefore from a previous call)"),
        reply_to: z.string().optional().describe("Channel only: the id of a post, to read its thread"),
        include_system: z.boolean().default(false).describe("Also return events such as members added or calls started"),
        max_length: z.number().int().min(100).max(100_000).default(4_000).describe("Maximum length of each message's text"),
      },
    },
    safe(async ({ conversation, limit, before, reply_to, include_system, max_length }) => {
      const r = await bridge.call<{ messages: Message[] }>(
        "readMessages",
        { conversation, limit, before, threadId: reply_to, includeSystem: include_system },
        READ_TIMEOUT_MS,
      );
      return text({ ...r, messages: capText(r.messages, max_length) });
    }),
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
    safe(async (args) => text(await bridge.call("searchMessages", args, READ_TIMEOUT_MS))),
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
    safe(async (args) => text(await bridge.call("findPeople", args, READ_TIMEOUT_MS))),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message (needs your click)",
      description:
        "Asks to post a message in an existing chat or channel, or to reply to a channel post. The extension shows a confirmation window with the message and where it goes; it is posted only if the user clicks Send there. Returns whether it was sent. Plain text; line breaks are kept and links become clickable.",
      inputSchema: {
        conversation,
        text: z.string().min(1).max(28_000).describe("The message"),
        reply_to: z.string().optional().describe("Channel only: the id of the post to reply to (from read_messages). Without it, a new post is started."),
        subject: z.string().optional().describe("Channel only: a subject for a new post"),
      },
    },
    safe(async ({ conversation, text: message, reply_to, subject }) =>
      text(await bridge.call("requestSend", { conversation, text: message, threadId: reply_to, subject }, SEND_TIMEOUT_MS)),
    ),
  );
}
