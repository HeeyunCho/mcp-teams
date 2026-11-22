// A peer or extension whose hello reaches a hub that has just handed over (stopServing ran between
// its challenge and its hello) must not end up connected to that ex-hub (#230). Seen live on
// 2026-11-18 twice: a peer logged role=peer hub=0.3.72 44-55 ms after the 0.3.72 hub logged
// handover and role=none, and stayed there for minutes ("waiting for extension"), with no
// hub-closed or hub-silent line: the ex-hub kept pinging it, so the peer's watchdog (#149) never fired.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { proof, type BridgeOptions } from "../../src/bridge.js";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../../src/extension.js";
import { FAST, TOKEN, bridgeHarness, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness;
afterEach(() => h?.cleanup());

/**
 * A client that connected to the hub and got its challenge, but whose hello is still on its way
 * (it isn't in the hub's peers or extensions yet). It counts the hub's pings: WebSocket frames
 * (to peers) and {type:"ping"} messages (to extensions).
 */
async function challenged(port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  const c = { ws, seen: [] as string[], pings: 0, closed: undefined as number | undefined, challenge: undefined as string | undefined };
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    c.seen.push(msg.type);
    if (msg.type === "challenge") c.challenge = msg.nonce;
    if (msg.type === "ping") c.pings++;
  });
  ws.on("ping", () => c.pings++);
  ws.on("close", (code) => (c.closed = code));
  ws.on("error", () => {});
  await until(() => c.challenge !== undefined, 2_000, "the challenge");
  return c;
}

// An auth timeout far past the hand-over, so only the hand-over can close a connection at its
// challenge in time, not FAST's 500 ms.
const SLOW_AUTH: BridgeOptions = { ...FAST, authTimeoutMs: 10_000 };

/**
 * A "0.3.72" hub, a client at its challenge, then a "0.3.80" session that the hub hands the port to.
 * paused: the client stops reading once it has its challenge, so it never sees the ex-hub's close.
 */
async function handOverWith({
  origin,
  oldHubOptions = {},
  newHubOptions = {},
  paused = false,
}: { origin?: string; oldHubOptions?: BridgeOptions; newHubOptions?: BridgeOptions; paused?: boolean } = {}) {
  h = await bridgeHarness(SLOW_AUTH);
  const oldHub = await h.session("0.3.72", oldHubOptions);
  expect(oldHub.role).toBe("hub");
  const late = await challenged(h.port, origin);
  if (paused) (late.ws as any)._socket.pause();
  // A newer server joins: the old hub hands over (handover, role=none) and closes its listener.
  const newHub = await h.session("0.3.80", newHubOptions);
  await until(() => oldHub.role === "none", 2_000, "the old hub to step down");
  return { oldHub, newHub, late };
}

// Longer than a peer's watchdog would wait for its hub's ping (2 periods, never under 2 s), and
// long enough for the ex-hub to rejoin the new hub as a peer (retryMs 700).
const settle = () => new Promise((r) => setTimeout(r, 3_000));

describe("a hello that arrives after the hub handed over", () => {
  it("a peer-hello is not accepted by the ex-hub, and the connection does not stay open on its pings", async () => {
    const { oldHub, late } = await handOverWith();
    late.ws.send(JSON.stringify({ type: "peer-hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.3.72" }));
    await settle();
    const snapshot = { exHubRole: oldHub.role, welcomed: late.seen.includes("peer-welcome"), pings: late.pings, closed: late.closed !== undefined };
    late.ws.terminate();

    // Expected: the ex-hub refuses (or closes) a connection it can no longer serve, so the peer
    // races for the port again. Bug: it sends peer-welcome, keeps pinging, and never closes it.
    expect(snapshot).toEqual({ exHubRole: "peer", welcomed: false, pings: 0, closed: true });
  }, 10_000);

  it("an extension's hello is not accepted by the ex-hub either", async () => {
    const { oldHub, late } = await handOverWith({ origin: EXTENSION_ORIGIN });
    const hello = { type: "hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.1.0", browser: "Chrome", instance: "late" };
    late.ws.send(JSON.stringify(hello));
    await settle();
    const snapshot = { exHubRole: oldHub.role, welcomed: late.seen.includes("welcome"), pings: late.pings, closed: late.closed !== undefined };
    late.ws.terminate();

    expect(snapshot).toEqual({ exHubRole: "peer", welcomed: false, pings: 0, closed: true });
  }, 10_000);

  it("a connection still waiting to say hello is closed when the hub hands over, not left to its auth timeout", async () => {
    const { late } = await handOverWith();
    await until(() => late.closed !== undefined, 2_000, "the ex-hub to close the connection");
    expect(late.closed).toBe(1012);
  }, 10_000);

  it("a hello that crosses the ex-hub's close on the wire is not accepted", async () => {
    const events: string[] = [];
    const diagnose = (event: string) => void events.push(event);
    // The client stops reading before the hand-over, so it sends its hello without having seen the
    // ex-hub's close frame; the ex-hub reads that hello on a connection it is already closing.
    const { late } = await handOverWith({ origin: EXTENSION_ORIGIN, oldHubOptions: { diagnose }, paused: true });
    expect(late.closed).toBeUndefined();
    const handedOver = events.length;
    late.ws.send(JSON.stringify({ type: "hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.1.0", browser: "Chrome", instance: "late" }));
    await new Promise((r) => setTimeout(r, 500));
    late.ws.terminate();

    expect(events.slice(handedOver)).not.toContain("extension-connected");
  }, 10_000);
});

// #216: a web store install has another id, which a hub counts as our extension when it is in its
// trusted ids (trustedExtensionIds, #224). The ex-hub's role check (#230) comes before that origin
// logic, so a trusted id doesn't get a late hello past it.
describe("a late hello from a trusted web store id", () => {
  // A fictional web store id (32 letters a-p).
  const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
  const STORE_ORIGIN = `chrome-extension://${STORE_ID}`;
  const trustedExtensionIds = { unpacked: EXTENSION_ID, chromeWebStore: STORE_ID };

  it("is refused by the ex-hub with 1012, while a serving hub with the same trusted ids takes that id", async () => {
    const events: { event: string; fields?: Record<string, string | number | undefined> }[] = [];
    const diagnose = (event: string, fields?: Record<string, string | number | undefined>) => void events.push({ event, fields });
    // As in "a hello that crosses the ex-hub's close on the wire": the client stops reading before
    // the hand-over, so its hello reaches the ex-hub on a connection it is already closing.
    const { oldHub, newHub, late } = await handOverWith({
      origin: STORE_ORIGIN,
      oldHubOptions: { diagnose, trustedExtensionIds },
      newHubOptions: { trustedExtensionIds },
      paused: true,
    });
    expect(late.closed).toBeUndefined();
    const handedOver = events.length;
    late.ws.send(JSON.stringify({ type: "hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.1.0", browser: "Chrome", instance: "late" }));
    await new Promise((r) => setTimeout(r, 500));
    // Now it reads what the ex-hub sent: its close, and nothing else.
    (late.ws as any)._socket.resume();
    await until(() => late.closed !== undefined, 2_000, "the ex-hub's close");
    const after = events.slice(handedOver);
    const snapshot = {
      closed: late.closed,
      welcomed: late.seen.includes("welcome"),
      pings: late.pings,
      takenAsExtension: after.some((e) => e.event === "extension-connected") || oldHub.extensions.some((e) => e.origin === STORE_ORIGIN),
    };
    late.ws.terminate();
    expect(snapshot).toEqual({ closed: 1012, welcomed: false, pings: 0, takenAsExtension: false });
    expect(after.find((e) => e.event === "handshake-closed")?.fields).toMatchObject({ code: 1012, reason: "restarting", hello: "hello" });

    // The same id is ours to a serving hub with the same trusted ids: with the sideloaded copy
    // connected, it is welcomed beside it, not turned away as another copy (4409).
    await h.extension({ origin: EXTENSION_ORIGIN, instance: "profile-a" });
    const store = await h.extension({ origin: STORE_ORIGIN, instance: "profile-b" });
    expect(store.welcome).toMatchObject({ type: "welcome" });
    await until(() => newHub.extensions.length === 2, 2_000, "both copies on the new hub");
    expect(newHub.extensions.map((e) => e.origin).sort()).toEqual([EXTENSION_ORIGIN, STORE_ORIGIN].sort());
  }, 10_000);
});

describe("a server whose peer-hello an ex-hub refuses with 1012", () => {
  /**
   * A hub that, like an ex-hub, turns the first peer-hello away with 1012 "restarting", and
   * welcomes the ones after it, as the new hub on the port would.
   */
  async function exHub() {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const hellos: number[] = [];
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "challenge", nonce: randomUUID() }));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "peer-hello") return;
        hellos.push(Date.now());
        if (hellos.length === 1) return void ws.close(1012, "restarting");
        ws.send(JSON.stringify({ type: "peer-welcome", serverVersion: "0.3.80", extension: null, extensions: [], proof: proof(TOKEN, "server", msg.nonce) }));
      });
    });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    closeExHub = () => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r())));
    return { port: (wss.address() as { port: number }).port, hellos };
  }
  let closeExHub: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeExHub?.();
    closeExHub = undefined;
  });

  it("doesn't say the port is in use, and joins the new hub promptly, not after the role=none backoff", async () => {
    const hub = await exHub();
    // A retryMs far above the 100-500 ms a closed hub's peers wait, so the backoff (0.5-1.5 x
    // retryMs) can't pass for a prompt rejoin.
    h = await bridgeHarness({ ...FAST, retryMs: 10_000 }, { port: hub.port });
    const server = await h.session("0.3.80");
    expect(hub.hellos).toHaveLength(1);
    expect(server.listenError).toBeUndefined();
    await until(() => server.role === "peer", 2_000, "the server to join the new hub");
    expect(hub.hellos[1] - hub.hellos[0]).toBeLessThan(1_500);
  }, 10_000);
});
