import { describe, expect, it, afterEach, beforeEach } from "vitest";
import WebSocket from "ws";
import { DEFAULT_BRIDGE_OPTIONS, ExtensionBridge } from "../../src/bridge.js";
import { freePort } from "../helpers/bridgeHarness.js";

// A free port per test, so test files and worktrees can run side by side.
let PORT: number;
beforeEach(async () => {
  PORT = await freePort();
});
const ORIGIN = "chrome-extension://abcdefghijklmnop";

function connectExt(token: string, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, version: "0.1.0", browser: "Edge" })));
  return ws;
}
const waitFor = (cond: () => boolean) =>
  new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const tick = () => (cond() ? res() : Date.now() - t0 > 3000 ? rej(new Error("timeout")) : setTimeout(tick, 20));
    tick();
  });

describe("ExtensionBridge", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  it("accepts a paired extension and routes RPC calls", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0");
    await bridge.start();
    const ws = connectExt("secret");
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") {
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { echo: msg.method, p: msg.params } }));
      }
    });
    await waitFor(() => bridge!.connected);
    expect(bridge.extension).toEqual({ version: "0.1.0", browser: "Edge", origin: ORIGIN });
    await expect(bridge.call("ping", { a: 1 })).resolves.toEqual({ echo: "ping", p: { a: 1 } });
    ws.close();
  });

  it("propagates extension errors", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0");
    await bridge.start();
    const ws = connectExt("secret");
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: "boom" }));
    });
    await waitFor(() => bridge!.connected);
    await expect(bridge.call("x")).rejects.toThrow("boom");
    ws.close();
  });

  it("rejects a wrong token", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0");
    await bridge.start();
    const ws = connectExt("wrong");
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4401);
    expect(bridge.connected).toBe(false);
  });

  it("rejects connections that are not from a browser extension (e.g. a web page)", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0");
    await bridge.start();
    const ws = connectExt("secret", "https://evil.example");
    const err = await new Promise<Error>((r) => ws.on("error", r));
    expect(err.message).toMatch(/401|Unexpected server response/);
  });

  it("an oversized message fails the call instead of crashing, and the extension can reconnect", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0", 1024);
    await bridge.start();
    const reply = (ws: WebSocket, size: number) =>
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: "x".repeat(size) }));
      });
    const big = connectExt("secret");
    big.on("error", () => {});
    reply(big, 4096);
    await waitFor(() => bridge!.connected);
    await expect(bridge.call("big")).rejects.toThrow(/too large/);
    await waitFor(() => !bridge!.connected);

    const small = connectExt("secret");
    reply(small, 10);
    await waitFor(() => bridge!.connected);
    await expect(bridge.call("small")).resolves.toBe("x".repeat(10));
    small.close();
  });

  it("reloads the extension and waits until the new version is connected", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.2.0");
    await bridge.start();
    const ext = (version: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: "secret", version })));
      return ws;
    };
    const old = ext("0.1.0");
    old.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "request") return;
      old.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { reloading: true } }));
      // Like chrome.runtime.reload(): the old worker goes away, the new one connects.
      setTimeout(() => {
        old.close();
        setTimeout(() => ext("0.2.0"), 200);
      }, 250);
    });
    await waitFor(() => bridge!.connected);
    await expect(bridge.reloadExtension(5_000)).resolves.toEqual({ before: "0.1.0", after: "0.2.0" });
  });

  it("fails calls clearly when no extension is connected", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.1.0");
    await bridge.start();
    await expect(bridge.call("x")).rejects.toThrow(/not connected/);
  });
});

describe("ExtensionBridge with several sessions", () => {
  const bridges: ExtensionBridge[] = [];
  const sockets: WebSocket[] = [];
  const make = async (token = "secret", version = "0.1.0") => {
    const b = new ExtensionBridge(PORT, token, version);
    bridges.push(b);
    await b.start();
    return b;
  };
  /** A fake extension that echoes requests and reconnects like the real one does. */
  const fakeExtension = () => {
    const ws = connectExt("secret");
    sockets.push(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { echo: msg.method, p: msg.params } }));
    });
    return ws;
  };
  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.close());
    await Promise.all(bridges.splice(0).map((b) => b.close()));
  });

  it("the first server is the hub, later ones forward their calls through it", async () => {
    const hub = await make();
    const peer = await make("secret", "0.0.9");
    expect([hub.role, peer.role]).toEqual(["hub", "peer"]);
    expect(peer.hubVersion).toBe("0.1.0");
    expect(peer.connected).toBe(false);

    fakeExtension();
    await waitFor(() => peer.connected); // the hub tells peers when the extension connects
    // Peers learn where the extension connected from too (setup checks it is ours).
    expect(peer.extension).toEqual({ version: "0.1.0", browser: "Edge", origin: ORIGIN });
    await expect(peer.call("search", { q: 1 })).resolves.toEqual({ echo: "search", p: { q: 1 } });
    await expect(hub.call("read")).resolves.toEqual({ echo: "read", p: {} });
  });

  it("forwards extension errors to the peer", async () => {
    await make();
    const peer = await make();
    const ws = connectExt("secret");
    sockets.push(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: "boom" }));
    });
    await waitFor(() => peer.connected);
    await expect(peer.call("x")).rejects.toThrow("boom");
  });

  it("a peer takes over when the hub exits, and the extension reconnects to it", async () => {
    const hub = await make();
    const peer = await make();
    fakeExtension();
    await waitFor(() => peer.connected);

    await hub.close();
    await waitFor(() => peer.role === "hub");
    expect(peer.connected).toBe(false);
    fakeExtension(); // the real extension retries every 30 s
    await waitFor(() => peer.connected);
    await expect(peer.call("after")).resolves.toEqual({ echo: "after", p: {} });
  });

  it("a server with another token does not join", async () => {
    await make("secret");
    const stranger = await make("other");
    expect(stranger.role).toBe("none");
    expect(stranger.listenError).toMatch(/rejected this server's token/);
    await expect(stranger.call("x")).rejects.toThrow(/rejected/);
  });
});

describe("ExtensionBridge options", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  /** An extension on the bridge's port that says hello with the token; pong: false is a frozen browser. */
  const helloExt = (port: number, pong = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN, autoPong: pong });
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "challenge") ws.send(JSON.stringify({ type: "hello", token: "secret", version: "0.1.0" }));
    });
    return ws;
  };

  it("defaults to the timings it has always used", () => {
    expect(DEFAULT_BRIDGE_OPTIONS).toEqual({
      maxMessageBytes: 256 * 1024 * 1024,
      keepAliveMs: 20_000,
      retryMs: 2_000,
      joinTimeoutMs: 3_000,
      authTimeoutMs: 5_000,
      pickStatusTimeoutMs: 3_000,
      stepDownMaxWaitMs: 5 * 60_000,
      cancelGraceMs: 2_000, // 1.2: how long a withdrawn call's answer still counts
    });
  });

  it("listens on a free port when given port 0, and reports the port it got", async () => {
    bridge = new ExtensionBridge(0, "secret", "0.1.0");
    await bridge.start();
    expect(bridge.role).toBe("hub");
    expect(bridge.port).toBeGreaterThan(0);
    const ws = helloExt(bridge.port);
    await waitFor(() => bridge!.connected);
    ws.close();
  });

  it("drops an extension that stops answering pings after the keep-alive interval it was given", async () => {
    bridge = new ExtensionBridge(0, "secret", "0.1.0", { keepAliveMs: 100 });
    await bridge.start();
    const ws = helloExt(bridge.port, false);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await waitFor(() => bridge!.connected);
    await waitFor(() => !bridge!.connected);
    expect(await closed).toBe(1006); // terminated, not closed politely
  });

  it("keeps the defaults for options given as undefined", async () => {
    bridge = new ExtensionBridge(0, "secret", "0.1.0", {
      maxMessageBytes: undefined,
      keepAliveMs: undefined,
      retryMs: undefined,
      joinTimeoutMs: undefined,
      authTimeoutMs: undefined,
      pickStatusTimeoutMs: undefined,
      stepDownMaxWaitMs: undefined,
    });
    await bridge.start();
    // A frozen extension (no pongs) and a socket that never authenticates: with the default
    // 20 s keep-alive and 5 s auth timeout, both are still there 500 ms later.
    const frozen = helloExt(bridge.port, false);
    await waitFor(() => bridge!.connected);
    const silent = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: ORIGIN });
    let silentClosed = false;
    silent.on("close", () => (silentClosed = true));
    await new Promise((r) => silent.on("open", r));
    await new Promise((r) => setTimeout(r, 500));
    expect(bridge.connected).toBe(true);
    expect(silentClosed).toBe(false);
    frozen.terminate();
    silent.terminate();
  });

  it("closes a connection that doesn't authenticate within the auth timeout it was given", async () => {
    bridge = new ExtensionBridge(0, "secret", "0.1.0", { authTimeoutMs: 100 });
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: ORIGIN });
    const started = Date.now();
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4401);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

