// #103: a tool call that fails because a Teams session is missing says why, as get_version's note does
// (stuck at sign-in, asleep, or a call the capture missed), instead of only "Reload the Teams tab". The
// tools against a scripted bridge: its extension fails the call with the worker's own error for that
// service, and answers status with the given object.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";
import { createFakeChrome, loadWorker, type Worker } from "../helpers/fakeChrome.js";

let help: Worker["SERVICE_HELP"];
let client: Client | undefined;

beforeAll(async () => {
  // The worker's wording, so the server's recognition of it can't drift from it unseen.
  help = (await loadWorker(createFakeChrome())).SERVICE_HELP;
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.useRealTimers();
});

type Status = object | Error;

/**
 * Calls `tool` at `now` against an extension that fails it with `error` and answers status with
 * `status` (or fails status with it, if an Error). Returns the result and the methods called.
 */
async function failing(tool: string, error: string, status: Status, now: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const calls: string[] = [];
  const bridge = {
    connected: true,
    extension: { version: "0.3.47", browser: "Chrome" },
    extensions: [{ version: "0.3.47", browser: "Chrome" }],
    listenError: null,
    role: "hub",
    port: 0,
    hubVersion: null,
    call: async (method: string) => {
      calls.push(method);
      if (method !== "status") throw new Error(error);
      if (status instanceof Error) throw status;
      return status;
    },
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const args = tool === "search_messages" || tool === "find_people" ? { query: "contoso" } : {};
  const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text, calls };
}

const noServices = { chatsvc: null, csa: null, mt: null, substrate: null };
/** A status with a Teams tab open and no chat session, as the extension reports it. */
const uncaptured = (calls: object, services: object = noServices) => ({
  extensionVersion: "0.3.47",
  teamsTabs: 1,
  sessions: [{ sessionCaptured: false }],
  services,
  region: null,
  signedInAs: null,
  ...calls,
});
const neverSignedIn = uncaptured({ lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "teams.cloud.microsoft" }, lastSignedInCall: null });

describe("#103: a call that fails for a missing session says why", () => {
  it("the chat session missing, the tab never signed in: the call's error says it looks stuck at sign-in", async () => {
    const r = await failing("list_chats", help.chatsvc, neverSignedIn, "2026-10-01T11:30:00Z");
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Teams' chat session is not available. The Teams tab hasn't made a signed-in call since the extension started watching; its last call (2026-10-01T10:26:37.000Z, teams.cloud.microsoft) wasn't signed in. It looks stuck at sign-in. Within about a minute and a half of the browser or the extension starting, the extension tries to bring the session back by itself; if this note is still there after that, open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).",
    );
  });

  it("the team list session missing, the tab silent: the call's error says it may be asleep", async () => {
    const r = await failing("list_teams", help.csa, uncaptured({ lastTeamsCall: null, lastSignedInCall: null }), "2026-10-01T10:30:00Z");
    expect(r).toMatchObject({ isError: true, calls: ["listTeams", "status"] });
    expect(r.text).toBe(
      "Teams' team list session is not available. The Teams tab has made no calls since the extension started watching; it may be asleep. Click into the Teams tab, or add teams.cloud.microsoft to Chrome's \"Always keep these sites active\" (Settings > Performance).",
    );
  });

  it("the people session missing after a recent signed-in call: the call's error says it looks like a capture problem", async () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    const r = await failing("find_people", help.mt, uncaptured({ lastTeamsCall: call, lastSignedInCall: call }), "2026-10-01T10:00:10Z");
    expect(r.text).toBe(
      "Teams' people session is not available. The Teams tab made a signed-in call at 2026-10-01T10:00:08.000Z (teams.cloud.microsoft), but no chat session was captured. Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again).",
    );
  });
});

describe("#103: a failed call keeps its error when there is nothing to explain", () => {
  it("the chat session captured but the team list's missing", async () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    const captured = {
      ...uncaptured({ lastTeamsCall: call, lastSignedInCall: call }, { ...noServices, chatsvc: call.at }),
      sessions: [{ sessionCaptured: true }],
    };
    const r = await failing("list_teams", help.csa, captured, "2026-10-01T10:00:10Z");
    expect(r).toEqual({ isError: true, text: "Teams' team list session is not available. Reload the Teams tab and try again.", calls: ["listTeams", "status"] });
  });

  it("search's session missing: its own remedy stays, and status isn't asked", async () => {
    const r = await failing("search_messages", help.substrate, neverSignedIn, "2026-10-01T11:30:00Z");
    expect(r).toEqual({
      isError: true,
      text: "Teams' search session is not available yet. Click into the search box at the top of Teams once (that makes Teams sign in to search), then try again.",
      calls: ["searchMessages"],
    });
  });

  it("an extension that doesn't report its last calls", async () => {
    const old = { extensionVersion: "0.3.43", teamsTabs: 1, sessions: [{ sessionCaptured: false }], services: noServices };
    const r = await failing("list_chats", help.chatsvc, old, "2026-10-01T11:30:00Z");
    expect(r.text).toBe("Teams' chat session is not available. Reload the Teams tab and try again.");
  });

  it("status failing too", async () => {
    const r = await failing("list_chats", help.chatsvc, new Error("The extension is not connected."), "2026-10-01T11:30:00Z");
    expect(r).toEqual({ isError: true, text: "Teams' chat session is not available. Reload the Teams tab and try again.", calls: ["listChats", "status"] });
  });

  it("another error: status isn't asked", async () => {
    const r = await failing("list_chats", "Teams HTTP 500 (chatsvc)", neverSignedIn, "2026-10-01T11:30:00Z");
    expect(r).toEqual({ isError: true, text: "Teams HTTP 500 (chatsvc)", calls: ["listChats"] });
  });
});
