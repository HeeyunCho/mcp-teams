// 2.3: liveness between the hub and its peers. The hub pings each peer every keep-alive period
// and drops one that stops answering; a peer drops a hub that declared its heartbeat but stopped
// pinging (a suspended or hung server), so its calls fail at once instead of hanging, and the
// takeover path runs. Real timers, with a 500 ms period so "within 2 periods" is measurable.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOST_CALL, isLostCall, proof } from "../../src/bridge.js";
import { FAST, TOKEN, bridgeHarness, until, type BridgeHarness } from "../helpers/bridgeHarness.js";

const PERIOD = 500;
const OPTIONS = { ...FAST, keepAliveMs: PERIOD };

let h: BridgeHarness | undefined;
const extra: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of extra.splice(0)) await close();
  await h?.cleanup();
  h = undefined;
});

/**
 * A hub that pairs with peers like the real one (challenge, proof) and then never pings them and
 * never answers: a hub that froze right after the welcome. `heartbeatMs`: what its welcome declares
 * (undefined: a hub of 0.2.13 or older, which never pings peers).
 */
async function frozenHub(port: number, heartbeatMs?: number) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const connections: { welcomedAt?: number; closedAt?: number; requests: any[] }[] = [];
  wss.on("connection", (ws) => {
    const c: (typeof connections)[number] = { requests: [] };
    connections.push(c);
    ws.send(JSON.stringify({ type: "challenge", nonce: randomUUID() }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "peer-hello") {
        const declared = heartbeatMs === undefined ? {} : { heartbeatMs };
        ws.send(JSON.stringify({ type: "peer-welcome", serverVersion: "1.0.0", extension: { version: "1.0.0" }, extensions: [{ version: "1.0.0" }], proof: proof(TOKEN, "server", msg.nonce), ...declared }));
        c.welcomedAt = Date.now();
      } else if (msg.type === "request") c.requests.push(msg);
    });
    ws.on("close", () => (c.closedAt = Date.now()));
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  extra.push(() => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r()))));
  return { connections };
}

/** A peer on the real hub, by hand: pairs, records what it gets; pong false: a frozen session. */
async function rawPeer(port: number, { pong = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: pong });
  const received: any[] = [];
  let closeCode: number | undefined;
  const nonce = randomUUID();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "challenge") ws.send(JSON.stringify({ type: "peer-hello", proof: proof(TOKEN, "client", msg.nonce), nonce, version: "1.0.0" }));
  });
  ws.on("close", (code) => (closeCode = code));
  ws.on("error", () => {});
  extra.push(() => ws.terminate());
  await until(() => received.some((m) => m.type === "peer-welcome"), 3_000, "peer-welcome");
  return {
    ws,
    received,
    welcome: received.find((m) => m.type === "peer-welcome"),
    get closeCode() {
      return closeCode;
    },
  };
}

describe("2.3: peer heartbeat", () => {
  it("2.3: the hub declares its heartbeat period to peers", async () => {
    h = await bridgeHarness(OPTIONS);
    await h.session();
    const peer = await rawPeer(h.port);
    expect(peer.welcome.heartbeatMs).toBe(PERIOD);
  });

  it("2.3: a peer whose hub froze fails its pending call within 2 heartbeat periods, as a lost call", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await frozenHub(h.port, PERIOD);
    const peer = await h.session();
    expect(peer.role).toBe("peer");
    const call = peer.call("listChats", {}, 60_000).then(
      () => null,
      (err: Error) => ({ err, at: Date.now() }),
    );
    await until(() => hub.connections[0].requests.length === 1, 3_000, "the request to reach the hub");
    const hung = new Promise<{ err: Error; at: number }>((r) => setTimeout(() => r({ err: new Error("still waiting"), at: Date.now() }), 4 * PERIOD));
    const outcome = await Promise.race([call, hung]);
    expect(outcome?.err.message).toBe(LOST_CALL.hubSilent);
    expect(isLostCall(outcome!.err.message)).toBe(true);
    // The hub went silent at its welcome: no ping ever came.
    const silentFor = outcome!.at - hub.connections[0].welcomedAt!;
    expect(silentFor).toBeGreaterThanOrEqual(PERIOD);
    expect(silentFor).toBeLessThan(2 * PERIOD + 300);
    // The takeover path runs: it pairs again with whoever holds the port.
    await until(() => hub.connections.length >= 2, 3_000, "the peer to join again");
  });

  it("2.3: a peer keeps a hub that declares no heartbeat (0.2.13 and older never ping peers)", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await frozenHub(h.port);
    const peer = await h.session();
    expect(peer.role).toBe("peer");
    await new Promise((r) => setTimeout(r, 6 * PERIOD));
    expect(hub.connections).toHaveLength(1);
    expect(hub.connections[0].closedAt).toBeUndefined();
    expect(peer.role).toBe("peer");
  });

  it("2.3: a peer stays joined to a live hub across many heartbeat periods", async () => {
    h = await bridgeHarness(OPTIONS);
    await h.session();
    await h.extension();
    const peer = await h.session();
    const hubSocket = (peer as any).hub;
    await new Promise((r) => setTimeout(r, 6 * PERIOD));
    expect(peer.role).toBe("peer");
    expect((peer as any).hub).toBe(hubSocket);
    expect(await peer.call("status", {})).toEqual({ ok: true });
  });

  it("2.3: the hub drops a peer that stops answering pings within 2 periods, and withdraws its calls", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await h.session();
    const ext = await h.extension({ silent: true });
    const peer = await rawPeer(h.port, { pong: false });
    const t0 = Date.now();
    peer.ws.send(JSON.stringify({ type: "request", id: "r1", method: "listChats", params: {}, timeoutMs: 60_000 }));
    await until(() => ext.requests().length === 1, 3_000, "the request to reach the extension");
    await until(() => peer.closeCode !== undefined, 4 * PERIOD, "the frozen peer to be dropped");
    expect(Date.now() - t0).toBeLessThan(2 * PERIOD + 300);
    // Nobody can be told the outcome: the extension is told to drop the call.
    await until(() => ext.received.some((m) => m.type === "cancel" && m.id === ext.requests()[0].id), 2_000, "the cancel");
    expect(hub.inFlight.peerCalls).toBe(0);
  });
});

// A peer that doesn't read its answers (a hung session, or one paused in a debugger) would make
// the hub buffer them without limit. Over maxPeerBufferedBytes at two ticks in a row, or over 4x
// it at any send, the hub closes it (1013): its calls fail and it connects again. Big payloads
// here, so the period is a full second (a pong can queue behind the data).
describe("2.3: slow peers", () => {
  const LIMIT = 1024 * 1024;

  it("2.3: a peer that stops reading is closed (1013) within about 2 ticks", async () => {
    const keepAliveMs = 1_000;
    h = await bridgeHarness({ ...FAST, keepAliveMs, maxPeerBufferedBytes: LIMIT });
    const hub = await h.session();
    // One answer far larger than the kernel's socket buffers, sent while the buffer is empty
    // (under the hard cap), so only the check at the ticks can close the peer.
    const big = "x".repeat(16 * 1024 * 1024);
    const ext = await h.extension({ handle: () => big });
    const peer = await rawPeer(h.port);
    (peer.ws as any)._socket.pause();
    peer.ws.send(JSON.stringify({ type: "request", id: "r1", method: "readMessages", params: {}, timeoutMs: 60_000 }));
    await until(() => ext.requests().length === 1, 3_000, "the request to reach the extension");
    const t0 = Date.now();
    await until(() => (hub as any).peers.size === 0, 4 * keepAliveMs, "the hub to drop the stalled peer");
    expect(Date.now() - t0).toBeLessThanOrEqual(3 * keepAliveMs);
    (peer.ws as any)._socket.resume();
    await until(() => peer.closeCode !== undefined, 10_000, "the stalled peer to see the close");
    // Windows may take the whole answer into its loopback buffers, so the backlog never shows;
    // the peer, not reading, then misses a ping and is dropped without a close frame (1006).
    expect(process.platform === "win32" ? [1006, 1013] : [1013]).toContain(peer.closeCode);
  }, 30_000);

  it("2.3: over 4x the limit, a peer that doesn't read is closed (1013) at once, between ticks", async () => {
    // Ticks are slow here, so only the check at send time can close the stalled peer.
    h = await bridgeHarness({ ...FAST, keepAliveMs: 30_000, maxPeerBufferedBytes: LIMIT });
    await h.session();
    const big = "x".repeat(4 * 1024 * 1024);
    const ext = await h.extension({ handle: () => big });
    const peer = await rawPeer(h.port);
    (peer.ws as any)._socket.pause();
    const n = 20;
    for (let i = 0; i < n; i++) peer.ws.send(JSON.stringify({ type: "request", id: `r${i}`, method: "readMessages", params: {}, timeoutMs: 60_000 }));
    await until(() => ext.requests().length === n, 10_000, "every request to reach the extension");
    await new Promise((r) => setTimeout(r, 500));
    (peer.ws as any)._socket.resume();
    await until(() => peer.closeCode !== undefined, 10_000, "the stalled peer to be closed");
    expect(peer.closeCode).toBe(1013);
    expect(peer.received.filter((m) => m.type === "response").length).toBeLessThan(n);
  }, 30_000);

  it("2.3: a burst over the limit that drains before the next tick never closes the peer", async () => {
    // 6 answers of 512 KB at once: up to 3 MB buffered, over the 1 MB limit but under the hard
    // cap, and drained long before the next tick.
    const keepAliveMs = 1_000;
    h = await bridgeHarness({ ...FAST, keepAliveMs, maxPeerBufferedBytes: LIMIT });
    await h.session();
    const big = "x".repeat(512 * 1024);
    await h.extension({ handle: () => big });
    const peer = await h.session();
    const hubSocket = (peer as any).hub;
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(Array.from({ length: 6 }, () => peer.call<string>("readMessages", {})));
      expect(results.every((r) => r.length === big.length)).toBe(true);
      await new Promise((r) => setTimeout(r, keepAliveMs));
    }
    expect((peer as any).hub).toBe(hubSocket);
    expect(peer.role).toBe("peer");
  }, 20_000);

  it("2.3: a peer that reads its answers gets them all, even ones larger than the limit", async () => {
    h = await bridgeHarness({ ...FAST, keepAliveMs: 1_000, maxPeerBufferedBytes: LIMIT });
    await h.session();
    const big = "x".repeat(2 * 1024 * 1024);
    await h.extension({ handle: () => big });
    const peer = await h.session();
    const hubSocket = (peer as any).hub;
    for (let i = 0; i < 6; i++) expect((await peer.call<string>("readMessages", {})).length).toBe(big.length);
    expect((peer as any).hub).toBe(hubSocket);
  }, 20_000);
});
