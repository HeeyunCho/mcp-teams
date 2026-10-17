// Every call has a deadline and can be cancelled: a frozen Teams tab or a Teams that never
// answers holds a call no longer than its timeout, and a withdrawn call stops sending
// requests. The real worker (extension/background.js) runs under a fake chrome; the MCP
// tools (src/tools.ts) run against a real hub.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { bridgeHarness, TOKEN, until, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { connectWorker, createFakeChrome, loadWorker, never, openedSockets, type Worker } from "../helpers/fakeChrome.js";

const csa = () => ({ teams: [], chats: [{ id: "19:contoso-launch@thread.v2", title: "Contoso launch", chatType: "chat", members: [] }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: BridgeHarness | undefined;
let link: { disconnect: () => Promise<void> } | undefined;

afterEach(async () => {
  await link?.disconnect();
  link = undefined;
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** Runs one request as the bridge sends it; resolves with the worker's response and how long it took. */
async function request(worker: Worker, method: string, params: object, timeoutMs: number) {
  const start = Date.now();
  const replies: any[] = [];
  await worker.dispatch({ type: "request", id: "r1", method, params, timeoutMs }, (r) => replies.push(r));
  return { reply: replies[0], ms: Date.now() - start };
}

describe("deadlines", () => {
  it("2.1: a call to a frozen Teams tab answers with an error at its deadline (timeoutMs)", async () => {
    const fake = createFakeChrome({ services: { csa } });
    fake.freezeTab(1);
    const worker = await loadWorker(fake);
    const { reply, ms } = await Promise.race([request(worker, "listChats", {}, 300), sleep(2_000).then(() => ({ reply: null, ms: Infinity }))]);
    expect(reply).toMatchObject({ id: "r1", ok: false });
    expect(ms).toBeLessThan(1_500);
  });

  it("2.1: a frozen tab that wakes after the deadline sends nothing", async () => {
    const fake = createFakeChrome({ services: { csa } });
    fake.freezeTab(1);
    const worker = await loadWorker(fake);
    void request(worker, "listChats", {}, 300);
    await sleep(500);
    fake.wake(1);
    await sleep(100);
    expect(fake.sent).toHaveLength(0);
  });

  it("2.1: Teams not answering fails the call at its deadline, not after the page's own 60 s", async () => {
    const fake = createFakeChrome({ services: { csa: () => never() } });
    const worker = await loadWorker(fake);
    const { reply, ms } = await Promise.race([request(worker, "listChats", {}, 300), sleep(2_000).then(() => ({ reply: null, ms: Infinity }))]);
    expect(reply).toMatchObject({ id: "r1", ok: false });
    expect(ms).toBeLessThan(1_500);
    expect(fake.count("csa")).toBe(1);
  });

  it("2.1: a call to a frozen tab through the hub fails at its timeout; nothing stays in flight and the tab sends nothing on waking", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const fake = createFakeChrome({ services: { csa }, local: { token: TOKEN, port: h.port } });
    fake.freezeTab(1);
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, () => hub.connected);
    await expect(hub.call("listChats", {}, 500)).rejects.toThrow(/timed out/);
    expect(hub.inFlight).toEqual({ pending: 0, peerCalls: 0 });
    fake.wake(1);
    await sleep(100);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("cancellation from the AI app", () => {
  // Each tool and the extension method it calls, with arguments that pass its schema.
  const TOOLS: [string, string, Record<string, unknown>][] = [
    ["get_version", "status", {}],
    ["api_traffic", "apiTraffic", {}],
    ["list_teams", "listTeams", {}],
    ["list_chats", "listChats", {}],
    ["read_messages", "readMessages", { conversation: "Contoso launch" }],
    ["list_meetings", "listMeetings", {}],
    ["get_meeting", "getMeeting", { meeting: "Contoso review" }],
    ["read_transcript", "readTranscript", { meeting: "Contoso review" }],
    ["search_transcripts", "searchTranscripts", { query: "budget" }],
    ["search_messages", "searchMessages", { query: "budget" }],
    ["find_people", "findPeople", { query: "Alex" }],
  ];

  it.each(TOOLS)("2.1: cancelling %s withdraws its extension call (%s)", async (tool, method, args) => {
    h = await bridgeHarness();
    const hub = await h.session();
    const ext = await h.extension({ silent: true });
    await until(() => hub.connected);
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, hub, { port: h.port, token: TOKEN });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const abort = new AbortController();
    const call = client.callTool({ name: tool, arguments: args }, undefined, { signal: abort.signal });
    call.catch(() => {});
    await until(() => ext.requests().some((r) => r.method === method), 3_000, `${method} reaches the extension`);
    const id = ext.requests().find((r) => r.method === method)!.id;
    abort.abort();
    await until(() => ext.received.some((m) => m.type === "cancel" && m.id === id), 2_000, `${method} is cancelled`);
    expect(hub.inFlight.pending).toBe(0);
    await client.close();
  });
});
