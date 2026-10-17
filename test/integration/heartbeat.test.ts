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
