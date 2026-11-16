// What the bridge does at its transport's edges: listening when the port is held, joining
// something on the port that is not an mcp-teams hub, and freeing the port on close. The
// WebSocket transport behind the transport seam (#123) must keep these.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { DEFAULT_BRIDGE_OPTIONS, ExtensionBridge } from "../../src/bridge.js";
import { FAST } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

const bridges: ExtensionBridge[] = [];
const servers: { close(cb: () => void): void }[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function bridge(port: number): ExtensionBridge {
  const b = new ExtensionBridge(port, "secret", "0.1.0", FAST);
  bridges.push(b);
  return b;
}

/**
 * A program on a port (default: a free one) that drops every connection at once (not a WebSocket
 * server), telling `onConnection` of each.
 */
async function rawHolder(onPort = 0, onConnection?: () => void): Promise<{ server: Server; port: number }> {
  const server = createServer((s: Socket) => {
    onConnection?.();
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(onPort, "127.0.0.1", () => r()));
  // Closed by afterEach too if a test fails before closing it (closing it twice is harmless here).
  servers.push({ close: (cb) => (server.listening ? server.close(() => cb()) : cb()) });
  return { server, port: (server.address() as { port: number }).port };
}

describe("the bridge's transport edges", () => {
  it("names a program on the port that isn't mcp-teams, and becomes the hub on that port once it is gone", async () => {
    const { server, port } = await rawHolder();
    const b = bridge(port);
    await b.start();
    expect(b.role).toBe("none");
    expect(b.listenError).toBe(
      `Port ${port} is held by an mcp-teams of 0.2.0 or older (restart the other AI sessions, in Claude Code with /mcp) or by another program.`,
    );
    await new Promise<void>((r) => server.close(() => r()));
    await until(() => b.role === "hub", 5_000, "the bridge to take the freed port");
    expect(b.port).toBe(port);
    expect(b.listenError).toBeUndefined();
  });

  it("names a WebSocket program that challenges and then closes as another program on the port", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "challenge", nonce: "n" }));
      ws.once("message", () => ws.close(1000));
    });
    const b = bridge(port);
    await b.start();
    expect(b.role).toBe("none");
    expect(b.listenError).toBe(`Port ${port} is in use by another program.`);
  });

  it("frees its port on close, so the next server becomes the hub there at once", async () => {
    const first = bridge(0);
    await first.start();
    expect(first.role).toBe("hub");
    const port = first.port;
    await first.close();
    const next = bridge(port);
    await next.start();
    expect(next.role).toBe("hub");
    expect(next.port).toBe(port);
  });

  it("a peer joins the hub on its port, and takes the port when the hub closes", async () => {
    const hub = bridge(0);
    await hub.start();
    const peer = bridge(hub.port);
    await peer.start();
    expect(peer.role).toBe("peer");
    expect(peer.hubVersion).toBe("0.1.0");
    await hub.close();
    await until(() => peer.role === "hub", 5_000, "the peer to take over the port");
    expect(peer.port).toBe(hub.port);
  });
});

// With a dozen servers on one PC, a port held by something that isn't their hub must not draw
// several connection attempts a second forever, all in lockstep: the role=none retry backs off.
describe("the role=none retry", () => {
  afterEach(() => void vi.useRealTimers());

  /** Waits for real I/O under fake timers (vi.waitFor would advance them; until polls on setTimeout). */
  async function settle(cond: () => boolean, what: string, timeoutMs = 3_000) {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * A bridge on a port held by a program that drops every connection: each attempt (listen fails,
   * join fails) ends in role=none and draws one connection at the holder. `randoms` feed the
   * jitter source in turn (the last one repeats); each call to it is one retry being scheduled.
   */
  async function heldBridge(randoms: number[], retryMs = 1_000, retryMaxMs = 8_000) {
    let attempts = 0;
    let scheduled = 0;
    let scheduledAt = 0; // fake time of the last retry scheduled
    const holder = await rawHolder(0, () => attempts++);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = () => vi.getMockedSystemTime()!.valueOf();
    const b = new ExtensionBridge(holder.port, "secret", "0.1.0", {
      retryMs,
      retryMaxMs,
      random: () => {
        scheduledAt = now();
        return randoms[Math.min(scheduled++, randoms.length - 1)]!;
      },
    });
    bridges.push(b);
    await b.start();
    expect(b.role).toBe("none");
    expect(attempts).toBe(1);
    expect(scheduled).toBe(1);
    /** The next attempt comes exactly `ms` after the last retry was scheduled, and fails again. */
    const nextAfter = async (ms: number) => {
      const [a, s] = [attempts, scheduled];
      await vi.advanceTimersByTimeAsync(scheduledAt + ms - 1 - now());
      await new Promise((r) => setImmediate(r));
      expect(attempts, `no attempt before ${ms} ms`).toBe(a);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => scheduled === s + 1, "the next retry to be scheduled");
      expect(attempts).toBe(a + 1);
      expect(b.role).toBe("none");
    };
    return { b, holder, nextAfter, countAttempt: () => void attempts++, scheduled: () => scheduled };
  }

  it("doubles its wait from retryMs after each failed attempt, up to retryMaxMs", async () => {
    const { nextAfter } = await heldBridge([0.5]); // 0.5: the middle, no jitter
    for (const ms of [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]) await nextAfter(ms);
  });

  it("puts up to 50% jitter either way on each wait", async () => {
    // Waits of 1, 2, 4 and 8 s; random 0 -> 0.5x, 0.75 -> 1.25x, 1 -> 1.5x, 0.25 -> 0.75x
    const { nextAfter } = await heldBridge([0, 0.75, 1, 0.25]);
    for (const ms of [500, 2_500, 6_000, 6_000]) await nextAfter(ms);
  });

  it("caps the wait at 30 s by default", () => {
    expect(DEFAULT_BRIDGE_OPTIONS.retryMaxMs).toBe(30_000);
  });

  it("starts again from retryMs once it reached a hub", async () => {
    const { b, holder, nextAfter, countAttempt, scheduled } = await heldBridge([0.5]);
    await nextAfter(1_000);
    await nextAfter(2_000); // the next wait would be 4 s
    const port = holder.port;
    await new Promise<void>((r) => holder.server.close(() => r()));
    const hub = new ExtensionBridge(port, "secret", "0.1.0"); // default keep-alive: no pings while time jumps
    bridges.push(hub);
    await hub.start();
    expect(hub.role).toBe("hub");
    await vi.advanceTimersByTimeAsync(4_000);
    await settle(() => b.role === "peer", "the bridge to join the hub");

    // The hub goes and something else takes the port: the peer falls back to none.
    let again = 0;
    await hub.close();
    await rawHolder(port, () => (again++, countAttempt()));
    await settle(() => b.role === "none", "the bridge to see its hub close");
    const before = scheduled();
    await vi.advanceTimersByTimeAsync(500); // a peer whose hub closed tries again within 0.1-0.5 s
    await settle(() => again === 1 && scheduled() === before + 1, "the bridge to try the port again and fail");
    await nextAfter(1_000); // not 8 s
  });
});
