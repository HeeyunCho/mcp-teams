// 2.3: liveness between the hub and its peers. The hub pings each peer every keep-alive period
// and drops one that stops answering; a peer drops a hub that declared its heartbeat but stopped
// pinging (a suspended or hung server), so its calls fail at once instead of hanging, and the
// takeover path runs. Real timers, with a 1.5 s period so "within 2 periods" is measurable and
// differs from the 2 s a peer's watchdog never waits under.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOST_CALL, isLostCall, proof } from "../../src/bridge.js";
import { FAST, TOKEN, bridgeHarness, until, type BridgeHarness } from "../helpers/bridgeHarness.js";

const PERIOD = 1_500;
const OPTIONS = { ...FAST, keepAliveMs: PERIOD };

/** Blocks this process (hubs, peers and fake extensions alike) for `ms`: a stalled event loop. */
function stall(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

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
 * (undefined: a hub of 0.2.13 or older, which never pings peers). It listens on port 0: pass its
 * port to bridgeHarness().
 */
async function frozenHub(heartbeatMs?: number) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
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
  return { port: (wss.address() as { port: number }).port, connections };
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

describe("2.3: peer heartbeat", { timeout: 15_000 }, () => {
  it("2.3: the hub declares its heartbeat period to peers", async () => {
    h = await bridgeHarness(OPTIONS);
    await h.session();
    const peer = await rawPeer(h.port);
    expect(peer.welcome.heartbeatMs).toBe(PERIOD);
  });

  it("2.3: a peer whose hub froze fails its pending call within 2 heartbeat periods, as a lost call", async () => {
    const hub = await frozenHub(PERIOD);
    h = await bridgeHarness(OPTIONS, { port: hub.port });
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
    expect(silentFor).toBeGreaterThanOrEqual(2 * PERIOD - 20); // the hub stamps the welcome first; clock rounding
    expect(silentFor).toBeLessThan(2 * PERIOD + 300);
    // The takeover path runs: it pairs again with whoever holds the port.
    await until(() => hub.connections.length >= 2, 3_000, "the peer to join again");
  });

  it("2.3: a peer's watchdog never waits under 2 s, however short the declared period (a busy machine runs timers late)", async () => {
    const hub = await frozenHub(200);
    h = await bridgeHarness(OPTIONS, { port: hub.port });
    const peer = await h.session();
    const call = peer.call("listChats", {}, 60_000).then(
      () => null,
      (err: Error) => ({ err, at: Date.now() }),
    );
    const outcome = await call;
    expect(outcome?.err.message).toBe(LOST_CALL.hubSilent);
    // The hub stamps the welcome before the peer starts its timer; allow for clock rounding.
    expect(outcome!.at - hub.connections[0].welcomedAt!).toBeGreaterThanOrEqual(2_000 - 20);
    expect(outcome!.at - hub.connections[0].welcomedAt!).toBeLessThan(2_000 + 500);
  });

  it("2.3: a peer keeps a hub that declares no heartbeat (0.2.13 and older never ping peers)", async () => {
    const hub = await frozenHub();
    h = await bridgeHarness(OPTIONS, { port: hub.port });
    const peer = await h.session();
    expect(peer.role).toBe("peer");
    await new Promise((r) => setTimeout(r, 4 * PERIOD));
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
    await new Promise((r) => setTimeout(r, 4 * PERIOD));
    expect(peer.role).toBe("peer");
    expect((peer as any).hub).toBe(hubSocket);
    expect(await peer.call("status", {})).toEqual({ ok: true });
  });

  // A process that stalls (a busy machine, a GC pause, a large answer being parsed) runs its
  // overdue timers before it reads what arrived meanwhile. A liveness verdict taken then would
  // blame the other side for a pong or ping that is waiting unread. Hub and peer share this
  // process, so blocking it stalls both, like CPU starvation during a full test run.
  it("2.3: the hub keeps a peer whose pong waits unread while the hub stalls past a tick", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await h.session();
    const peer = await h.session();
    const hubSocket = (peer as any).hub;
    // The peer pongs as it hears the ping; then everything stalls past the hub's next tick (but
    // not the peer's watchdog, 2 periods), so when that tick runs the pong is still unread.
    await new Promise<void>((r) => hubSocket.once("ping", () => (stall(1.75 * PERIOD), r())));
    await new Promise((r) => setTimeout(r, 1.5 * PERIOD));
    expect((peer as any).hub === hubSocket, "the peer kept its hub connection").toBe(true);
    expect((hub as any).peers.size).toBe(1);
  });

  it("2.3: a peer keeps its live hub when the peer stalls past its watchdog", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await h.session();
    const peer = await h.session();
    const hubSocket = (peer as any).hub;
    // As the hub reads the peer's pong, everything stalls past the peer's watchdog (2 periods
    // after the ping): when it runs, the hub's next ping has not been read yet.
    const peerSocket = [...(hub as any).peers][0];
    await new Promise<void>((r) => peerSocket.once("pong", () => (stall(3 * PERIOD), r())));
    await new Promise((r) => setTimeout(r, 1.5 * PERIOD));
    expect((peer as any).hub === hubSocket, "the peer kept its hub connection").toBe(true);
    expect(peer.role).toBe("peer");
  });

  it("2.3: the hub keeps an extension whose pong waits unread while the hub stalls past a tick", async () => {
    h = await bridgeHarness(OPTIONS);
    const hub = await h.session();
    const ext = await h.extension();
    const socket = ext.ws;
    // As in the peer's case: the extension pongs, then everything stalls past the hub's next tick.
    await new Promise<void>((r) => socket.once("ping", () => (stall(1.75 * PERIOD), r())));
    await new Promise((r) => setTimeout(r, 1.5 * PERIOD));
    expect(ext.ws === socket && socket.readyState === WebSocket.OPEN, "the extension kept its connection").toBe(true);
    expect(await hub.call("status", {})).toEqual({ ok: true });
  });

  // A late check skips its verdict at most once in a row: on a loop that runs late all the
  // time, a frozen peer, extension or hub is still dropped, at the second late check.
  it("2.3: a hub that stalls at tick after tick still drops a frozen peer, at the second late tick", async () => {
    h = await bridgeHarness(OPTIONS);
    await h.session();
    // A frozen peer; each time it hears a ping (at most 3 times), everything stalls past the
    // hub's next tick, so every tick after the first runs late.
    const peer = await rawPeer(h.port, { pong: false });
    const stallEnds: number[] = [];
    peer.ws.on("ping", () => stallEnds.length < 3 && (stall(1.75 * PERIOD), stallEnds.push(Date.now())));
    await until(() => peer.closeCode !== undefined, 10 * PERIOD, "the frozen peer to be dropped");
    const droppedAt = Date.now();
    expect(stallEnds).toHaveLength(2);
    expect(droppedAt - stallEnds[1]).toBeLessThan(0.5 * PERIOD);
  }, 30_000);

  it("2.3: a hub that stalls at tick after tick still drops a frozen extension, at the second late tick", async () => {
    h = await bridgeHarness(OPTIONS);
    await h.session();
    // A frozen browser; each time it hears a ping (at most 3 times), everything stalls past the
    // hub's next tick.
    const ext = await h.extension({ pong: false, reconnect: false });
    const socket = ext.ws;
    let closedAt: number | undefined;
    socket.once("close", () => (closedAt = Date.now()));
    const stallEnds: number[] = [];
    socket.on("ping", () => stallEnds.length < 3 && (stall(1.75 * PERIOD), stallEnds.push(Date.now())));
    await until(() => closedAt !== undefined, 10 * PERIOD, "the frozen extension to be dropped");
    expect(stallEnds).toHaveLength(2);
    expect(closedAt! - stallEnds[1]).toBeLessThan(0.5 * PERIOD);
  }, 30_000);

  it("2.3: a peer whose watchdog runs late twice in a row still drops its frozen hub", async () => {
    const hub = await frozenHub(PERIOD);
    h = await bridgeHarness(OPTIONS, { port: hub.port });
    const peer = await h.session();
    let settled = false;
    const call = peer.call("listChats", {}, 60_000).then(
      () => null,
      (err: Error) => ({ err, at: Date.now() }),
    );
    void call.then(() => (settled = true));
    // The hub never pings. Everything stalls past the watchdog (2 periods after the welcome),
    // then, once the watchdog has run, past the next one, and so on (at most 3 times).
    const stallEnds: number[] = [];
    const stallAgain = () => {
      if (settled || stallEnds.length >= 3) return;
      stall(3 * PERIOD);
      stallEnds.push(Date.now());
      setTimeout(stallAgain, 0); // due after the overdue watchdog, so it runs second
    };
    setTimeout(stallAgain, 0);
    const outcome = await call;
    expect(outcome?.err.message).toBe(LOST_CALL.hubSilent);
    expect(stallEnds).toHaveLength(2);
    expect(outcome!.at - stallEnds[1]).toBeLessThan(0.5 * PERIOD);
  }, 30_000);

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

  /**
   * A peer that stops reading while one answer far larger than the kernel's socket buffers is
   * sent to it (on an empty buffer, so under the hard cap: only the check at the ticks can close
   * it). `afterPing`: the extension answers only once the hub has pinged the peer (at a tick).
   * Returns how long the hub took from when the backlog showed to dropping the peer, the code
   * the peer saw, and whether the tick after the first ping saw the backlog (`landed`): a tick
   * checks the buffer and then pings or terminates in one go, so wrapping both shows what it saw.
   */
  async function stallPeer(keepAliveMs: number, { afterPing = false } = {}) {
    h = await bridgeHarness({ ...FAST, keepAliveMs, maxPeerBufferedBytes: LIMIT });
    const hub = await h.session();
    const big = "x".repeat(8 * 1024 * 1024);
    let pinged = false;
    const ext = await h.extension({ handle: async () => (afterPing && (await until(() => pinged, 4 * keepAliveMs, "a ping to the peer")), big) });
    const peer = await rawPeer(h.port);
    const peerSocket = [...(hub as any).peers][0];
    const ticks: boolean[] = []; // per tick after the first ping: did it see the backlog?
    const ping = peerSocket.ping.bind(peerSocket);
    peerSocket.ping = (...args: unknown[]) => {
      if (pinged) ticks.push(peerSocket.bufferedAmount > LIMIT);
      pinged = true;
      return ping(...args);
    };
    const terminate = peerSocket.terminate.bind(peerSocket);
    peerSocket.terminate = () => (ticks.push(peerSocket.bufferedAmount > LIMIT), terminate());
    (peer.ws as any)._socket.pause();
    peer.ws.send(JSON.stringify({ type: "request", id: "r1", method: "readMessages", params: {}, timeoutMs: 60_000 }));
    await until(() => ext.requests().length === 1, 3_000, "the request to reach the extension");
    // From when the backlog shows (Windows may take the whole answer into its loopback buffers,
    // so it may never show: then from now).
    let t0 = Date.now();
    await until(() => peerSocket.bufferedAmount > LIMIT || (hub as any).peers.size === 0, 6 * keepAliveMs, "the backlog");
    if ((hub as any).peers.size) t0 = Date.now();
    await until(() => (hub as any).peers.size === 0, 4 * keepAliveMs, "the hub to drop the stalled peer");
    const tookMs = Date.now() - t0;
    (peer.ws as any)._socket.resume();
    await until(() => peer.closeCode !== undefined, 10_000, "the stalled peer to see the close");
    return { tookMs, closeCode: peer.closeCode, landed: ticks[0] ?? true };
  }

  // Where the backlog never shows (Windows), the peer, not reading, misses a ping instead and is
  // dropped without a close frame (1006).
  const SLOW_PEER_CODES = process.platform === "win32" ? [1006, 1013] : [1013];

  it("2.3: a peer that stops reading is closed (1013) within about 2 ticks", async () => {
    const keepAliveMs = 1_000;
    const { tookMs, closeCode } = await stallPeer(keepAliveMs);
    expect(tookMs).toBeLessThanOrEqual(2 * keepAliveMs + 500);
    expect(SLOW_PEER_CODES).toContain(closeCode);
  }, 30_000);

  it("2.3: a backlog that starts just after a tick closes the peer as slow (1013), not for the ping stuck behind it", async () => {
    // The answer follows a tick's ping: at the next tick, that ping is still queued behind the
    // data, so the peer could not have answered it. A 2 s period gives the answer time to land.
    const keepAliveMs = 2_000;
    const { tookMs, closeCode, landed } = await stallPeer(keepAliveMs, { afterPing: true });
    if (landed) {
      expect(tookMs).toBeLessThanOrEqual(2 * keepAliveMs + 500);
      expect(SLOW_PEER_CODES).toContain(closeCode);
    } else {
      // Under heavy load the answer reached the buffer only after the next tick: that tick
      // rightly dropped the peer, which hadn't answered a ping sent on an empty buffer.
      expect(closeCode).toBe(1006);
    }
  }, 30_000);

  // Windows takes the whole answer into its loopback buffers, so the hub never sees a backlog here.
  it.skipIf(process.platform === "win32")("2.3: a peer that reads one large answer slowly keeps its live hub (the hub's pings go on behind the backlog)", async () => {
    // The answer lands right after a ping, and the peer reads nothing until the hub has seen the
    // backlog at one tick; then it drains well before the next. Neither side may drop the other.
    const keepAliveMs = 1_000;
    h = await bridgeHarness({ ...FAST, keepAliveMs, maxPeerBufferedBytes: LIMIT });
    const hub = await h.session();
    const big = "x".repeat(8 * 1024 * 1024);
    let pinged = false;
    const ext = await h.extension({ handle: async () => (await until(() => pinged, 4 * keepAliveMs, "a ping to the peer"), big) });
    const peer = await h.session();
    const peerSocket = [...(hub as any).peers][0];
    const ping = peerSocket.ping.bind(peerSocket);
    // Pings after the first go out 150 ms late (a busy hub), so a skipped one is always missed.
    peerSocket.ping = (...args: unknown[]) => {
      const late = pinged;
      pinged = true;
      setTimeout(() => peerSocket.readyState === 1 && ping(...args), late ? 150 : 0);
    };
    const hubSocket = (peer as any).hub;
    // The peer stops reading right after it heard the ping the answer follows.
    hubSocket.once("ping", () => hubSocket._socket.pause());
    const call = peer.call<string>("readMessages", {}, 60_000);
    await until(() => ext.requests().length === 1, 3_000, "the request to reach the extension");
    await until(() => (hub as any).backlogged.has(peerSocket), 3 * keepAliveMs, "the hub to see the backlog at a tick");
    hubSocket._socket.resume();
    expect((await call).length).toBe(big.length);
    await new Promise((r) => setTimeout(r, 2 * keepAliveMs));
    expect((peer as any).hub).toBe(hubSocket);
    expect((hub as any).peers.size).toBe(1);
  }, 30_000);

  it("2.3: over 4x the limit, a peer that doesn't read is closed (1013) at once, between ticks", async () => {
    // Ticks are slow here, so only the check at send time can close the stalled peer. All 20
    // calls run at once (2.4 lets a session run maxConcurrentCalls), so their answers pile up.
    h = await bridgeHarness({ ...FAST, keepAliveMs: 30_000, maxPeerBufferedBytes: LIMIT, maxConcurrentCalls: 20 });
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
