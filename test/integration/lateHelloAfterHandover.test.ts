// A peer whose peer-hello reaches a hub that has just handed over (stopServing ran between its
// challenge and its peer-hello) must not end up as that ex-hub's peer. Seen live on 2026-11-18
// twice: a peer logged role=peer hub=0.3.72 44-55 ms after the 0.3.72 hub logged handover and
// role=none, and stayed there for minutes ("waiting for extension"), with no hub-closed or
// hub-silent line: the ex-hub kept pinging it, so the peer's watchdog (#149) never fired.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { proof } from "../../src/bridge.js";
import { TOKEN, bridgeHarness, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness;
afterEach(() => h?.cleanup());

describe("a peer-hello that arrives after the hub handed over", () => {
  it("is not accepted by the ex-hub, and the connection does not stay open on its pings", async () => {
    h = await bridgeHarness();
    const oldHub = await h.session("0.3.72");
    expect(oldHub.role).toBe("hub");

    // A peer that connected to the hub and got its challenge, but whose peer-hello is still on its
    // way (it isn't in the hub's peers yet, so stopServing doesn't know about it).
    const late = new WebSocket(`ws://127.0.0.1:${h.port}`);
    const seen: string[] = [];
    let pings = 0;
    let closed = false;
    let challenge: string | undefined;
    late.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg.type);
      if (msg.type === "challenge") challenge = msg.nonce;
    });
    late.on("ping", () => pings++);
    late.on("close", () => (closed = true));
    late.on("error", () => {});
    await until(() => challenge !== undefined, 2_000, "the challenge");

    // A newer server joins: the old hub hands over (handover, role=none) and closes its listener.
    await h.session("0.3.80");
    await until(() => oldHub.role === "none", 2_000, "the old hub to step down");

    // Now the late peer-hello arrives at the ex-hub.
    late.send(JSON.stringify({ type: "peer-hello", proof: proof(TOKEN, "client", challenge!), nonce: "n-late", version: "0.3.72" }));

    // Longer than a peer's watchdog would wait for its hub's ping (2 periods, never under 2 s), and
    // long enough for the ex-hub to rejoin the new hub as a peer (retryMs 700).
    await new Promise((r) => setTimeout(r, 3_000));
    const snapshot = { exHubRole: oldHub.role, welcomed: seen.includes("peer-welcome"), pings, closed };
    late.terminate();

    // Expected: the ex-hub refuses (or closes) a connection it can no longer serve, so the peer
    // races for the port again. Bug: it sends peer-welcome, keeps pinging, and never closes it.
    expect(snapshot).toEqual({ exHubRole: "peer", welcomed: false, pings: 0, closed: true });
  }, 10_000);
});
