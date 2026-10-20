// A confirmation window whose send can no longer be reported to the caller is closed, and the
// send ends as "nothing was sent", so a late click never posts. The real worker
// (extension/background.js, under a fake chrome) is connected to a real hub over a socket.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { bridgeHarness, TOKEN, until, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { connectWorker, createFakeChrome, loadWorker, ME_OID, networkError, openedSockets, reply, timedOut, type FakeChrome, type SentRequest, type Worker } from "../helpers/fakeChrome.js";

const CHAT = "19:contoso-launch@thread.v2";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";
const csa = () => ({ teams: [], chats: [{ id: CHAT, title: "Contoso launch", chatType: "chat", members: [{ mri: `8:orgid:${ME_OID}` }, { mri: ALEX }] }] });
const SEND = { conversation: CHAT, text: "Hi Alex" };

const posts = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST").length;

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

/** A hub with the worker connected to it; chatsvc answers posts with `post`. */
async function setup(post: (req: SentRequest) => unknown = () => ({ OriginalArrivalTime: Date.parse("2026-10-01T09:00:00Z") })) {
  h = await bridgeHarness();
  const hub = await h.session();
  const fake = createFakeChrome({ services: { csa, chatsvc: (req) => (req.method === "POST" ? post(req) : undefined) }, local: { token: TOKEN, port: h.port } });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  link = await connectWorker(fake, () => hub.connected);
  return { hub, fake, worker };
}

/** Waits for the confirmation window; returns its window id and the send's id. */
async function windowOpened(fake: FakeChrome) {
  await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
  const win = await fake.spies.windowsCreate.mock.results[0].value;
  const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
  return { windowId: win.id as number, id };
}

const click = (fake: FakeChrome, id: string) => fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });

/** The window was closed, no send waits any more, and a Send click afterwards posts nothing. */
async function expectWithdrawn(fake: FakeChrome, worker: Worker, w: { windowId: number; id: string }) {
  await vi.waitFor(() => expect(fake.spies.windowsRemove).toHaveBeenCalledWith(w.windowId));
  expect(worker.pendingSendCount()).toBe(0);
  await click(fake, w.id);
  await new Promise((r) => setTimeout(r, 50));
  expect(posts(fake)).toBe(0);
}

describe("send confirmation window", () => {
  it("1.2: the extension's bridge connection closing (hub lost) closes the window; nothing is sent", async () => {
    const { hub, fake, worker } = await setup();
    const call = hub.call("requestSend", SEND, 60_000);
    call.catch(() => {});
    const w = await windowOpened(fake);
    await hub.close();
    await expect(call).rejects.toThrow();
    await expectWithdrawn(fake, worker, w);
  });

  it("1.2: a send the hub stops waiting for (bridge timeout) is withdrawn: the window closes and the call reports nothing sent", async () => {
    const { hub, fake, worker } = await setup();
    // Long enough that the window has opened before the hub stops waiting, even on a busy machine.
    const call = hub.call("requestSend", SEND, 1_500);
    const w = await windowOpened(fake);
    await expect(call).resolves.toMatchObject({ sent: false, reason: expect.stringContaining("nothing was sent") });
    await expectWithdrawn(fake, worker, w);
  });

  it("1.2: a peer that disconnects withdraws its send: the window closes; nothing is sent", async () => {
    const { fake, worker } = await setup();
    const peer = await h!.session();
    await until(() => peer.connected, 3_000, "peer sees the extension");
    const call = peer.call("requestSend", SEND, 60_000);
    call.catch(() => {});
    const w = await windowOpened(fake);
    await peer.close();
    await expect(call).rejects.toThrow();
    await expectWithdrawn(fake, worker, w);
  });

  it("1.2: a cancelled send on a peer session is withdrawn through the hub: the window closes; nothing is sent", async () => {
    const { hub, fake, worker } = await setup();
    const peer = await h!.session();
    await until(() => peer.connected, 3_000, "peer sees the extension");
    const abort = new AbortController();
    const call = peer.call("requestSend", SEND, 60_000, abort.signal);
    call.catch(() => {});
    const w = await windowOpened(fake);
    expect(hub.inFlight).toEqual({ pending: 1, peerCalls: 1 });
    abort.abort();
    await expect(call).resolves.toMatchObject({ sent: false, reason: expect.stringContaining("nothing was sent") });
    await expectWithdrawn(fake, worker, w);
    expect(hub.inFlight).toEqual({ pending: 0, peerCalls: 0 });
    expect(peer.inFlight.pending).toBe(0);
  });

  it("1.2: cancelling send_message (MCP cancellation) closes the window; nothing is sent", async () => {
    const { hub, fake, worker } = await setup();
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, hub, { port: h!.port, token: TOKEN });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const abort = new AbortController();
    const call = client.callTool({ name: "send_message", arguments: SEND }, undefined, { signal: abort.signal });
    call.catch(() => {});
    const w = await windowOpened(fake);
    abort.abort();
    await expect(call).rejects.toThrow();
    await expectWithdrawn(fake, worker, w);
    await client.close();
  });

  it("1.2: a send that fails without an outcome (hub lost) tells the AI to check the chat before retrying", async () => {
    const lost = { call: () => Promise.reject(new Error("mcp-teams is shutting down")) } as unknown as Parameters<typeof registerTools>[1];
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, lost, { port: 0, token: TOKEN });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "send_message", arguments: SEND })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/shutting down/);
    expect(r.content[0].text).toMatch(/read_messages before sending again/);
    await client.close();
  });

  it("1.2: a send refused before any window opened gets no 'may have been posted' warning", async () => {
    const refused = { call: () => Promise.reject(new Error("No chat or channel matches 'Alex Doe'.")) } as unknown as Parameters<typeof registerTools>[1];
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, refused, { port: 0, token: TOKEN });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "send_message", arguments: SEND })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("No chat or channel matches 'Alex Doe'.");
    await client.close();
  });

  /** send_message's answer when the bridge call fails with `message`. */
  async function sendFailingWith(message: string) {
    const failing = { call: () => Promise.reject(new Error(message)) } as unknown as Parameters<typeof registerTools>[1];
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, failing, { port: 0, token: TOKEN });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "send_message", arguments: SEND })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    return r;
  }

  it("2.1: a send the extension refused before any window gets no warning, even when its reason mentions a connection", async () => {
    // E.g. a chat lookup whose names note quotes a failed people lookup.
    const refused = 'No chat or channel matches "Alex Doe". Use list_chats or list_teams to find it.\nChat names missing: some people couldn\'t be looked up, so they are shown without their names. Try again. The lookup failed with: Could not reach Teams: net::ERR_CONNECTION_RESET';
    const r = await sendFailingWith(refused);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(refused);
  });

  it.each([
    "Extension call 'requestSend' timed out",
    "Cancelled: the request was withdrawn.",
    "Browser extension disconnected",
    "Browser extension reconnected; try again.",
    "The mcp-teams hub restarted; try again in a few seconds.",
    "mcp-teams was updated; try again in a few seconds.",
    "Bridge connection error: read ECONNRESET",
    "mcp-teams is shutting down",
    "bridge server error: listen EADDRINUSE",
    "The response was too large (over 256 MB) and was dropped. The connection is re-established automatically.",
  ])("2.1: the bridge losing a sent call (%s) still tells the AI to check before sending again", async (message) => {
    const r = await sendFailingWith(message);
    expect(r.content[0].text).toMatch(/may have been posted.*read_messages before sending again/);
  });

  it("1.2: a click before the withdrawal posts once and the call reports the real outcome", async () => {
    let answer!: (v: unknown) => void;
    const posted = new Promise((r) => (answer = r));
    const { hub, fake, worker } = await setup(() => posted);
    const call = hub.call("requestSend", SEND, 400);
    const w = await windowOpened(fake);
    void click(fake, w.id);
    await vi.waitFor(() => expect(posts(fake)).toBe(1));
    await new Promise((r) => setTimeout(r, 600)); // the hub stops waiting while the post runs
    answer({ OriginalArrivalTime: Date.parse("2026-10-01T09:00:00Z") });
    await expect(call).resolves.toMatchObject({ sent: true });
    expect(posts(fake)).toBe(1);
    expect(worker.pendingSendCount()).toBe(0);
  });

  // A post the user clicked whose answer never came may have reached Teams: saying it failed
  // would invite a second post (#25: a late click must never post after the AI was told it failed).
  it.each([
    ["Teams doesn't answer the post in time", timedOut],
    ["the post's connection fails", () => networkError("net::ERR_CONNECTION_RESET")],
  ])("2.1: %s after the click: the outcome is unknown, so the AI is told to check before sending again", async (_, answer) => {
    const { hub, fake } = await setup(() => answer());
    const call = hub.call("requestSend", SEND, 60_000);
    const w = await windowOpened(fake);
    await click(fake, w.id);
    const r = (await call) as { sent: boolean; reason: string };
    expect(r.sent).toBe(false);
    // Its own sentence, after the cause: "… net::ERR_CONNECTION_RESET. The message may have been posted …"
    expect(r.reason).toMatch(/[.!?] The message may have been posted/);
    expect(r.reason).toMatch(/read_messages before sending again/);
  });

  it("2.1: the Teams tab closing while the post runs: the outcome is unknown, so the AI is told to check before sending again", async () => {
    const { hub, fake } = await setup(() => new Promise(() => {}));
    const call = hub.call("requestSend", SEND, 60_000);
    const w = await windowOpened(fake);
    void click(fake, w.id);
    await vi.waitFor(() => expect(posts(fake)).toBe(1));
    fake.closeTab(1);
    const r = (await call) as { sent: boolean; reason: string };
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/[.!?] The message may have been posted/);
  });

  it("2.1: creating a new group chat gets no answer: the AI is told the chat may exist (not that the message was posted)", async () => {
    const SAM = "8:orgid:00000000-0000-4000-8000-00000000000b";
    const { hub, fake } = await setup(() => timedOut());
    const call = hub.call("requestSend", { to: [ALEX, SAM], title: "Contoso launch team", text: "Hi both" }, 60_000);
    const w = await windowOpened(fake);
    await click(fake, w.id);
    const r = (await call) as { sent: boolean; reason: string };
    expect(fake.sent.filter((q) => q.service === "chatsvc" && q.method === "POST").map((q) => q.path)).toEqual(["/v1/threads"]);
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/chat may have been created/);
    expect(r.reason).toMatch(/list_chats/);
    expect(r.reason).not.toMatch(/message may have been posted/);
  });

  it("2.1: a post Teams refuses (HTTP error) after the click is a known failure, without that warning", async () => {
    const { hub, fake } = await setup(() => reply(403, { message: "Forbidden" }));
    const call = hub.call("requestSend", SEND, 60_000);
    const w = await windowOpened(fake);
    await click(fake, w.id);
    const r = (await call) as { sent: boolean; reason: string };
    expect(r).toMatchObject({ sent: false, reason: expect.stringMatching(/^Sending failed: Teams HTTP 403/) });
    expect(r.reason).not.toMatch(/may have been posted/);
  });

  it("1.2: a replaced extension connection is told to cancel its pending calls before it closes", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const old = await h.extension({ instance: "profile-1", version: "0.2.13", reconnect: false, handle: () => new Promise(() => {}) });
    const call = hub.call("requestSend", SEND, 60_000);
    call.catch(() => {});
    await until(() => old.requests().length === 1, 3_000, "the send reaches the extension");
    const { id } = old.requests()[0];
    const closed = new Promise((r) => old.ws.once("close", r));
    await h.extension({ instance: "profile-1" });
    await closed;
    // Messages after the close can't arrive: the cancel came before it.
    expect(old.received.some((m) => m.type === "cancel" && m.id === id)).toBe(true);
    await expect(call).rejects.toThrow("reconnected");
    expect(hub.inFlight.pending).toBe(0);
  });

  it("1.2: the browser reconnecting (connection replaced) closes the window; nothing is sent", async () => {
    const { hub, fake, worker } = await setup();
    const call = hub.call("requestSend", SEND, 60_000);
    call.catch(() => {});
    const w = await windowOpened(fake);
    await h!.extension({ instance: String(fake.local.get("instance")), reconnect: false });
    await expect(call).rejects.toThrow("reconnected");
    await expectWithdrawn(fake, worker, w);
    expect(hub.inFlight.pending).toBe(0);
  });

  it("1.2: an extension that doesn't know cancel gets one, ignores it, and keeps working", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const ext = await h.extension({ handle: (req) => (req.method === "slow" ? new Promise(() => {}) : { ok: true }) });
    await expect(hub.call("slow", {}, 200)).rejects.toThrow("timed out");
    const slow = ext.requests().find((r) => r.method === "slow")!;
    await until(() => ext.received.some((m) => m.type === "cancel" && m.id === slow.id));
    await expect(hub.call("status", {}, 1_000)).resolves.toEqual({ ok: true });
  });
});
