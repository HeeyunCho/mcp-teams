// #103: a tool call that fails because a Teams session is missing says why, as get_version's note does
// (stuck at sign-in, asleep, or a call the capture missed), instead of only "Reload the Teams tab". The
// tools against a scripted bridge: its extension fails the call with the worker's own error for that
// service, and answers status as the test says.
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

/**
 * What the extension answers status with: an object, an Error it fails with, or a function given the
 * timeout and signal the server read status with (for a status that doesn't answer).
 */
type Status = object | Error | ((timeoutMs: number | undefined, signal: AbortSignal | undefined) => Promise<unknown>);

type Options = {
  /** The bridge's `connected` (true). */
  connected?: boolean;
  /** The client's signal for the call, to cancel it. */
  signal?: AbortSignal;
  /** Fake setTimeout too (Date always is), to show how long a status that doesn't answer is waited for. */
  timers?: boolean;
};

/**
 * Calls `tool` at `now` against an extension that fails it with `error` and answers status with
 * `status`. Returns the result (a promise) and the methods called so far.
 */
function start(tool: string, error: string, status: Status, now: string, opts: Options = {}) {
  vi.useFakeTimers({ toFake: opts.timers ? ["Date", "setTimeout", "clearTimeout"] : ["Date"] });
  vi.setSystemTime(new Date(now));
  const calls: string[] = [];
  const bridge = {
    connected: opts.connected ?? true,
    extension: { version: "0.3.47", browser: "Chrome" },
    extensions: [{ version: "0.3.47", browser: "Chrome" }],
    listenError: null,
    role: "hub",
    port: 0,
    hubVersion: null,
    call: async (method: string, _params?: unknown, timeoutMs?: number, signal?: AbortSignal) => {
      calls.push(method);
      if (method !== "status") throw new Error(error);
      if (typeof status === "function") return status(timeoutMs, signal);
      if (status instanceof Error) throw status;
      return status;
    },
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN });
  const c = new Client({ name: "test", version: "0.0.0" });
  client = c;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const args = tool === "search_messages" || tool === "find_people" ? { query: "contoso" } : {};
  const result = Promise.all([server.connect(a), c.connect(b)])
    .then(() => c.callTool({ name: tool, arguments: args }, undefined, { signal: opts.signal }))
    .then((r) => {
      const { isError, content } = r as { isError?: boolean; content: { text: string }[] };
      return { isError, text: content[0].text, calls };
    });
  return { result, calls };
}

/** start's result, awaited. */
const failing = (tool: string, error: string, status: Status, now: string, opts: Options = {}) => start(tool, error, status, now, opts).result;

/** A status the extension never answers: it fails as the bridge's own timeout (60 s if none is given) or the signal ends it. */
const unanswered: Status = (timeoutMs, signal) =>
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("The extension did not answer status in time.")), timeoutMs ?? 60_000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    });
  });

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

// Which note fits which status is test/unit/failedCallNote.test.ts; here, that the tools give the
// worker's own errors the note, and how they read status for it.
describe("#103: a call that fails for a missing session says why", () => {
  const asleep = uncaptured({ lastTeamsCall: null, lastSignedInCall: null });
  const note = "The Teams tab has made no calls since the extension started watching; it may be asleep.";

  it("the chat session missing: list_chats' error has the note, from status", async () => {
    const r = await failing("list_chats", help.chatsvc, asleep, "2026-10-01T10:30:00Z");
    expect(r).toMatchObject({ isError: true, calls: ["listChats", "status"] });
    expect(r.text).toMatch(new RegExp(`^Teams' chat session is not available\\. ${note}`));
  });

  it("the team list session missing: list_teams' error has the note, from status", async () => {
    const r = await failing("list_teams", help.csa, asleep, "2026-10-01T10:30:00Z");
    expect(r).toMatchObject({ isError: true, calls: ["listTeams", "status"] });
    expect(r.text).toMatch(new RegExp(`^Teams' team list session is not available\\. ${note}`));
  });

  it("the people session missing: find_people's error has the note, from status", async () => {
    const r = await failing("find_people", help.mt, asleep, "2026-10-01T10:30:00Z");
    expect(r).toMatchObject({ isError: true, calls: ["findPeople", "status"] });
    expect(r.text).toMatch(new RegExp(`^Teams' people session is not available\\. ${note}`));
  });
});

describe("#103: a failed call keeps its error when there is nothing to explain", () => {
  it("search's session missing: its own remedy stays, and status isn't asked", async () => {
    const r = await failing("search_messages", help.substrate, neverSignedIn, "2026-10-01T11:30:00Z");
    expect(r).toEqual({
      isError: true,
      text: "Teams' search session is not available yet. Click into the search box at the top of Teams once (that makes Teams sign in to search), then try again.",
      calls: ["searchMessages"],
    });
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

describe("#103: reading status for a failed call's note", () => {
  // The call has failed already: a stuck worker mustn't hold its error back for the bridge's default minute.
  it("a status that doesn't answer is given up within a few seconds, and the call keeps its error", async () => {
    const { result } = start("list_chats", help.chatsvc, unanswered, "2026-10-01T11:30:00Z", { timers: true });
    let settled: Awaited<typeof result> | undefined;
    // A call still waiting when the test ends fails as the client closes.
    result.then((r) => (settled = r)).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toEqual({ isError: true, text: "Teams' chat session is not available. Reload the Teams tab and try again.", calls: ["listChats", "status"] });
  });

  it("with no extension connected, status isn't asked and the call keeps its error", async () => {
    const r = await failing("list_chats", help.chatsvc, neverSignedIn, "2026-10-01T11:30:00Z", { connected: false });
    expect(r).toEqual({ isError: true, text: "Teams' chat session is not available. Reload the Teams tab and try again.", calls: ["listChats"] });
  });

  it("a call the client cancels while its status is read ends that status read too", async () => {
    const cancel = new AbortController();
    let ended: Promise<boolean> | undefined;
    // The client cancels as soon as status is asked; the read ends when its signal does (false: it has none).
    const status: Status = (_timeoutMs, signal) => {
      ended = signal ? new Promise((resolve) => signal.addEventListener("abort", () => resolve(true))) : Promise.resolve(false);
      cancel.abort();
      return ended.then(() => Promise.reject(new Error("Cancelled.")));
    };
    const { result } = start("list_chats", help.chatsvc, status, "2026-10-01T11:30:00Z", { signal: cancel.signal });
    await expect(result).rejects.toThrow();
    expect(await ended).toBe(true);
  });
});
