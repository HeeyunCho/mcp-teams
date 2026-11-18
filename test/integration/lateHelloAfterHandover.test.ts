// A peer or extension whose hello reaches a hub that has just handed over (stopServing ran between
// its challenge and its hello) must not end up connected to that ex-hub (#230). Seen live on
// 2026-11-18 twice: a peer logged role=peer hub=0.3.72 44-55 ms after the 0.3.72 hub logged
// handover and role=none, and stayed there for minutes ("waiting for extension"), with no
// hub-closed or hub-silent line: the ex-hub kept pinging it, so the peer's watchdog (#149) never fired.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { proof, type BridgeOptions } from "../../src/bridge.js";
import { EXTENSION_ORIGIN } from "../../src/extension.js";
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

/** A "0.3.72" hub, a client at its challenge, then a "0.3.80" session that the hub hands the port to. */
async function handOverWith(origin?: string, options = FAST, oldHubOptions: BridgeOptions = {}) {
  h = await bridgeHarness(options);
  const oldHub = await h.session("0.3.72", oldHubOptions);
  expect(oldHub.role).toBe("hub");
  const late = await challenged(h.port, origin);
  // A newer server joins: the old hub hands over (handover, role=none) and closes its listener.
  await h.session("0.3.80");
  await until(() => oldHub.role === "none", 2_000, "the old hub to step down");
  return { oldHub, late };
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
    const { oldHub, late } = await handOverWith(EXTENSION_ORIGIN);
    const hello = { type: "hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.1.0", browser: "Chrome", instance: "late" };
    late.ws.send(JSON.stringify(hello));
    await settle();
    const snapshot = { exHubRole: oldHub.role, welcomed: late.seen.includes("welcome"), pings: late.pings, closed: late.closed !== undefined };
    late.ws.terminate();

    expect(snapshot).toEqual({ exHubRole: "peer", welcomed: false, pings: 0, closed: true });
  }, 10_000);

  it("a connection still waiting to say hello is closed when the hub hands over, not left to its auth timeout", async () => {
    // An auth timeout far past the hand-over, so only the hand-over can close it in time.
    const { late } = await handOverWith(undefined, { ...FAST, authTimeoutMs: 10_000 });
    await until(() => late.closed !== undefined, 2_000, "the ex-hub to close the connection");
    expect(late.closed).toBe(1012);
  }, 10_000);

  it("a hello that crosses the ex-hub's close on the wire is not accepted", async () => {
    const events: string[] = [];
    const diagnose = (event: string) => void events.push(event);
    // The client stops reading, so it sends its hello without having seen the ex-hub's close frame;
    // the ex-hub reads that hello on a connection it is already closing.
    const { late } = await handOverWith(EXTENSION_ORIGIN, FAST, { diagnose });
    (late.ws as any)._socket.pause();
    const handedOver = events.length;
    late.ws.send(JSON.stringify({ type: "hello", proof: proof(TOKEN, "client", late.challenge!), nonce: "n-late", version: "0.1.0", browser: "Chrome", instance: "late" }));
    await new Promise((r) => setTimeout(r, 500));
    late.ws.terminate();

    expect(events.slice(handedOver)).not.toContain("extension-connected");
  }, 10_000);
});
