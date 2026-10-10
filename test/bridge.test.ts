import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { ExtensionBridge } from "../src/bridge.js";

const PORT = 47599;
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

