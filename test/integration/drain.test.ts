// #112: a hub whose own AI session ends (its stdin closed) used to close at once, failing every
// other session's call in flight through it with "hub restarted", an open send confirmation
// window included. Now it takes no new calls (they fail as not sent), lets the running ones
// finish for a bounded time, then closes. Ported from mcp-newoutlook test/integration/drain.test.ts
// (PR #108 there, #68b), adapted to the Teams bridge.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOST_CALL, NOT_SENT, isLostCall, proof } from "../../src/bridge.js";
import { TOKEN, bridgeHarness, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness | undefined;
let wss: WebSocketServer | undefined;
const raw: WebSocket[] = [];
afterEach(async () => {
  for (const ws of raw.splice(0)) ws.terminate();
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
  await h?.cleanup();
  h = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
/** The error a promise rejects with (fails the test when it resolves). */
const failure = async (p: Promise<unknown>): Promise<Error> => p.then(
  (v) => {
    throw new Error(`expected a failure, got ${JSON.stringify(v)}`);
  },
  (e: Error) => e,
);

/** A peer on a raw socket that pairs with the hub on `port` and records every message it gets. */
async function rawPeer(port: number) {
  const received: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  raw.push(ws);
  const nonce = randomUUID();
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
      if (msg.type === "challenge") ws.send(JSON.stringify({ type: "peer-hello", proof: proof(TOKEN, "client", msg.nonce), nonce, version: "1.0.0" }));
      if (msg.type === "peer-welcome") resolve();
    });
    ws.on("error", reject);
  });
  let closed = false;
  ws.on("close", () => (closed = true));
  return { ws, received, closed: () => closed };
}

/**
 * A hub that pairs with peers like the real one and, on a peer's first request, closes without
 * answering it: after a {type:"drained"} note when `note`, else at once (a hub that crashed).
 */
async function scriptedHub({ note }: { note: boolean }) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss = server;
  server.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "challenge", nonce: "challenge-1" }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "peer-hello") {
        ws.send(JSON.stringify({ type: "peer-welcome", serverVersion: "1.0.0", extension: { version: "0.2.13" }, extensions: [{ version: "0.2.13" }], proof: proof(TOKEN, "server", msg.nonce) }));
      } else if (msg.type === "request") {
        if (note) ws.send(JSON.stringify({ type: "drained" }));
        ws.close(1001, "going away");
      }
    });
  });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return (server.address() as { port: number }).port;
}

describe("#112: the hub drains when its session ends", { timeout: 15_000 }, () => {
  it("#112: a peer's call in flight still gets its answer, and the hub closes once it is answered", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    const ext = await h.extension({ handle: async (req) => (req.method === "readMessages" ? sleep(400).then(() => ({ n: req.params.n })) : {}) });
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const running = peer.call("readMessages", { n: 1 }, 5_000);
    await until(() => ext.requests().some((r) => r.method === "readMessages"), 2_000, "the call to reach the extension");
    const t0 = Date.now();
    const drained = hub.drainAndClose(3_000);

    await expect(running).resolves.toEqual({ n: 1 });
    await drained;
    // It closed once the call was answered, not at the end of its bound.
    expect(Date.now() - t0).toBeLessThan(2_000);
    await until(() => peer.role === "hub", 3_000, "the peer to take over the port");
  });

  it("#112: a call that comes while the hub drains is refused as not sent, and never reaches Teams", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    const ext = await h.extension({ handle: async (req) => (req.method === "readMessages" ? sleep(500).then(() => ({ done: true })) : {}) });
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const running = peer.call("readMessages", {}, 5_000);
    await until(() => ext.requests().some((r) => r.method === "readMessages"), 2_000, "the call to reach the extension");
    const drained = hub.drainAndClose(3_000);

    const fromPeer = await failure(peer.call("listChats", {}, 5_000));
    expect(fromPeer.message).toBe(NOT_SENT.hubClosing);
    expect(isLostCall(fromPeer.message)).toBe(false);
    // The hub's own session ended; a call its tools still make is refused the same way.
    const own = await failure(hub.call("listTeams", {}, 5_000));
    expect(own.message).toBe(NOT_SENT.hubClosing);
    expect(ext.requests().map((r) => r.method)).not.toContain("listChats");
    expect(ext.requests().map((r) => r.method)).not.toContain("listTeams");

    await expect(running).resolves.toEqual({ done: true });
    await drained;
  });

  it("#112: the wait is bounded; a call still running then fails as before", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    await h.extension({ handle: never });
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const stuck = peer.call("readMessages", {}, 10_000);
    await until(() => hub.inFlight.peerCalls === 1, 2_000, "the hub to run the peer's call");
    const t0 = Date.now();
    await hub.drainAndClose(300);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1_500);
    const err = await failure(stuck);
    expect(err.message).toBe(LOST_CALL.hubRestarted);
  });

  it("#112: an open send confirmation is withdrawn when the bound runs out, as a lost call, and is not sent again", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    // A confirmation window nobody clicks.
    const ext = await h.extension({ version: "0.2.13", handle: (req) => (req.method === "requestSend" ? never() : {}) });
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");
    const firstSocket = ext.ws;

    const send = peer.call("requestSend", { conversation: "19:contoso@thread.v2", text: "Hi Alex" }, 60_000);
    await until(() => ext.requests().some((r) => r.method === "requestSend"), 2_000, "the send to reach the extension");
    const sendId = ext.requests().find((r) => r.method === "requestSend")!.id;
    const t0 = Date.now();
    await hub.drainAndClose(300);
    // The bound isn't made longer for a send.
    expect(Date.now() - t0).toBeLessThan(1_500);

    const err = await failure(send);
    // The user may have clicked just before: the AI is told to check before sending again.
    expect(err.message).toBe(LOST_CALL.hubRestarted);
    expect(isLostCall(err.message)).toBe(true);
    // The window was told to close, and its connection closed (the extension withdraws what came on it).
    expect(ext.received).toContainEqual({ type: "cancel", id: sendId });
    await until(() => firstSocket.readyState === WebSocket.CLOSED, 2_000, "the hub to close the extension's connection");

    // The peer takes over and the extension connects to it; nothing sends it again.
    await until(() => peer.role === "hub" && peer.connected, 3_000, "the peer to take over with the extension");
    await sleep(200);
    expect(ext.requests().filter((r) => r.method === "requestSend")).toHaveLength(1);
  });

  it("#112: a hub with nothing in flight closes at once", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    await h.extension();
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const t0 = Date.now();
    await hub.drainAndClose(3_000);
    expect(Date.now() - t0).toBeLessThan(200);
    await until(() => peer.role === "hub", 3_000, "the peer to take over");
  });

  it("#112: a peer's bridge closes at once, and the hub's own call goes on", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    await h.extension({ latencyMs: 400 });
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const own = hub.call("readMessages", {}, 5_000);
    const t0 = Date.now();
    await peer.drainAndClose(3_000);
    expect(Date.now() - t0).toBeLessThan(200);
    await expect(own).resolves.toEqual({ ok: true });
  });

  // Item 4: when the hub answered everything it accepted, a call still on its way to it was never run.
  it("#112: a hub that answered everything tells its peers so before it closes", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    await h.extension({ handle: async (req) => (req.method === "readMessages" ? sleep(200).then(() => ({})) : {}) });
    const watcher = await rawPeer(h.port);
    const peer = await h.session();
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const running = peer.call("readMessages", {}, 5_000);
    await until(() => hub.inFlight.peerCalls === 1, 2_000, "the hub to run the peer's call");
    await hub.drainAndClose(3_000);
    await running;
    await until(watcher.closed, 2_000, "the hub to close the raw peer");
    expect(watcher.received.filter((m) => m.type === "drained")).toHaveLength(1);
  });

  it("#112: a hub that gave up on a call at its bound sends no such note", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    await h.extension({ handle: never });
    const watcher = await rawPeer(h.port);
    const peer = await h.session();
    await until(() => hub.connected && peer.connected, 3_000, "hub and peer connected");

    const stuck = peer.call("readMessages", {}, 10_000);
    void stuck.catch(() => {});
    await until(() => hub.inFlight.peerCalls === 1, 2_000, "the hub to run the peer's call");
    await hub.drainAndClose(200);
    await until(watcher.closed, 2_000, "the hub to close the raw peer");
    expect(watcher.received.filter((m) => m.type === "drained")).toHaveLength(0);
  });

  it("#112: a peer whose hub said it answered everything fails a call still on its way as not sent", async () => {
    const port = await scriptedHub({ note: true });
    h = await bridgeHarness(undefined, { port });
    const peer = await h.session();
    await until(() => peer.connected, 3_000, "the peer to join the scripted hub");

    const err = await failure(peer.call("requestSend", { conversation: "19:contoso@thread.v2", text: "Hi Sam" }, 5_000));
    expect(err.message).toBe(NOT_SENT.hubClosing);
    expect(isLostCall(err.message)).toBe(false);
  });

  it("#112: without that note, a call on its way to a hub that closed is still a lost call", async () => {
    const port = await scriptedHub({ note: false });
    h = await bridgeHarness(undefined, { port });
    const peer = await h.session();
    await until(() => peer.connected, 3_000, "the peer to join the scripted hub");

    const err = await failure(peer.call("requestSend", { conversation: "19:contoso@thread.v2", text: "Hi Sam" }, 5_000));
    expect(err.message).toBe(LOST_CALL.hubRestarted);
    expect(isLostCall(err.message)).toBe(true);
  });
});
