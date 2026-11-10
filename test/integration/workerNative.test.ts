// #123 (ADR 0001): the worker's native-first connect (extension/background.js connect()). Under a
// fake chrome whose connectNative hands each port to a scripted native host, and a scripted TCP
// hub, so the test decides what each side does. pairing.json (a stubbed fetch) says whether
// config.json turns the native host on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { proof } from "../../src/bridge.js";
import { toExtensionFrames } from "../../src/native.js";
import { createFakeChrome, loadWorker, NativeWebSocket, openedSockets, stopWorkers, type FakeChrome, type FakeNativeHost } from "../helpers/fakeChrome.js";
import { until } from "../helpers/timing.js";

const TOKEN = "worker-native-token";

let wss: WebSocketServer | undefined;
let fake: FakeChrome | undefined;

afterEach(async () => {
  stopWorkers();
  for (const h of fake?.nativePorts ?? []) h.disconnect();
  fake = undefined;
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** The installed folder's pairing.json, as the server writes it (nativeHost: config.json's switch). */
function pairing(file: object | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "chrome-extension://fake-extension-id/pairing.json" || file === null) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(file), { status: 200 });
    }),
  );
}

/**
 * A native host that serves like dist/hub.js: a challenge the extension needn't answer (Chrome
 * vouches for it), then a welcome proving the hello's nonce. `then` runs on it after the welcome.
 * `maxMessageBytes`: what its welcome declares it takes (null: no capabilities at all).
 */
function servingHost({ then, maxMessageBytes = 1024 }: { then?: (host: FakeNativeHost) => void; maxMessageBytes?: number | null } = {}) {
  return (host: FakeNativeHost) => {
    host.send({ type: "challenge", nonce: "host-challenge" });
    host.onPost = (msg) => {
      if (msg.type !== "hello") return;
      const capabilities = maxMessageBytes === null ? {} : { capabilities: { features: ["native"], maxMessageBytes } };
      host.send({ type: "welcome", serverVersion: "0.0.0", heartbeatMs: 20_000, ...capabilities, proof: proof(TOKEN, "server", msg.nonce) });
      then?.(host);
    };
  };
}

/** A TCP hub that welcomes the worker like the real one, or refuses it with `refuseWith`. */
async function tcpHub({ refuseWith }: { refuseWith?: number } = {}) {
  const received: any[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss = server;
  server.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "challenge", nonce: "tcp-challenge" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type !== "hello") return;
      if (refuseWith) return void ws.close(refuseWith, "refused");
      ws.send(JSON.stringify({ type: "welcome", serverVersion: "0.0.0", proof: proof(TOKEN, "server", msg.nonce) }));
    });
  });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { port: (server.address() as { port: number }).port, received };
}

/** Loads the worker and starts it as the browser does. */
async function start(f: FakeChrome) {
  fake = f;
  const worker = await loadWorker(f);
  worker.registerListeners();
  vi.stubGlobal("WebSocket", NativeWebSocket);
  for (const l of f.chrome.runtime.onStartup.listeners) l();
  return worker;
}

const status = (f: FakeChrome) => f.pageMessage("popup.html", { type: "popup:status" }) as Promise<{ state: string; lastError: string | null }>;
const connected = async (f: FakeChrome) => vi.waitFor(async () => expect(await status(f)).toMatchObject({ state: "connected" }), { timeout: 3_000 });

describe("#123: the worker connects to the native host first, and falls back to TCP", () => {
  it("with nativeHost off (pairing.json without it) it never tries native messaging: TCP as before", async () => {
    pairing({ token: TOKEN });
    const hub = await tcpHub();
    const f = createFakeChrome({ local: { token: TOKEN, port: hub.port }, nativeHost: servingHost() });
    await start(f);
    await connected(f);
    expect(hub.received.some((m) => m.type === "hello")).toBe(true);
    expect(f.connectNative).not.toHaveBeenCalled();
  });

  it("with nativeHost on it connects by native messaging: hello at once with its nonce, the welcome's proof checked, requests answered", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    const f = createFakeChrome({ nativeHost: servingHost() });
    await start(f);
    await connected(f);
    expect(f.connectNative).toHaveBeenCalledWith("com.mcp_teams.hub");
    expect(openedSockets).toEqual([]);
    const host = f.nativePorts[0];
    const hello = host.received.find((m) => m.type === "hello");
    expect(hello).toMatchObject({ nonce: expect.any(String), browser: "Chrome", capabilities: { maxMessageBytes: 256 * 1024 * 1024 } });
    // Only one hello: the host's challenge needs no answer on the native port.
    expect(host.received.filter((m) => m.type === "hello")).toHaveLength(1);
    host.send({ type: "request", id: "r1", method: "noSuchMethod", params: {}, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(host.received).toContainEqual({ type: "response", id: "r1", ok: false, error: "Unknown method noSuchMethod" }), { timeout: 2_000 });
  });

  it("with nativeHost on, a welcome that doesn't prove its nonce isn't trusted: the worker leaves for TCP", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    const hub = await tcpHub();
    const f = createFakeChrome({
      local: { port: hub.port },
      nativeHost: (host) => {
        host.onPost = (msg) => {
          if (msg.type !== "hello") return;
          host.send({ type: "welcome", serverVersion: "0.0.0", proof: proof("not-the-token", "server", msg.nonce) });
          host.send({ type: "request", id: "r1", method: "noSuchMethod", params: {} });
        };
      },
    });
    await start(f);
    await connected(f);
    expect(hub.received.some((m) => m.type === "hello")).toBe(true);
    expect(f.nativePorts[0].received.filter((m) => m.type === "response")).toEqual([]);
  });

  it("with no native host installed (Chrome closes the port before any welcome) it connects over TCP at once", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    const hub = await tcpHub();
    const f = createFakeChrome({ local: { port: hub.port }, nativeHost: (host) => host.disconnect("Specified native messaging host not found.") });
    await start(f);
    await connected(f);
    expect(f.connectNative).toHaveBeenCalledTimes(1);
    expect(hub.received.some((m) => m.type === "hello")).toBe(true);
  });

  it("joins a message the host split into chunks (over Chrome's 1 MB) before handling it", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    const f = createFakeChrome({ nativeHost: servingHost() });
    await start(f);
    await connected(f);
    const host = f.nativePorts[0];
    const request = { type: "request", id: "big-1", method: "noSuchMethod", params: { text: "Hallo Sam, 안녕하세요! ".repeat(80_000) }, timeoutMs: 5_000 };
    // Split by the host's own code: each frame's payload is one message to the extension.
    const frames = toExtensionFrames(JSON.stringify(request)).map((b) => JSON.parse(b.subarray(4).toString("utf8")));
    expect(frames.length).toBeGreaterThan(1);
    for (const chunk of frames) host.send(chunk);
    await vi.waitFor(() => expect(host.received).toContainEqual({ type: "response", id: "big-1", ok: false, error: "Unknown method noSuchMethod" }), { timeout: 3_000 });
  });

  it("an answer over what the native connection takes (the host's maxMessageBytes, at most Chrome's 64 MB) is answered with a short error at once, and the port stays open", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    // servingHost declares maxMessageBytes: 1024; this answer ("Unknown method …") is over 2 KB.
    const f = createFakeChrome({ nativeHost: servingHost() });
    await start(f);
    await connected(f);
    const host = f.nativePorts[0];
    host.send({ type: "request", id: "huge-1", method: "x".repeat(2_000), params: {}, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(host.received).toContainEqual({ type: "response", id: "huge-1", ok: false, error: expect.stringMatching(/too large .*native connection/) }), {
      timeout: 2_000,
    });
    expect(host.open).toBe(true);
    host.send({ type: "request", id: "small-1", method: "noSuchMethod", params: {}, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(host.received).toContainEqual({ type: "response", id: "small-1", ok: false, error: "Unknown method noSuchMethod" }), { timeout: 2_000 });
  });

  for (const [what, maxMessageBytes] of [
    ["declares no limit", null],
    ["declares more than Chrome passes (256 MB)", 256 * 1024 * 1024],
  ] as const) {
    it(`an answer Chrome refuses to post (over its 64 MiB; here lowered) still gets a short error at once, when the host ${what}`, async () => {
      pairing({ token: TOKEN, nativeHost: true });
      // Chrome's refusal at 1 KB instead of 64 MiB: the same path, without allocating 64 MB.
      const f = createFakeChrome({ nativeHost: servingHost({ maxMessageBytes }), nativeRefusesOver: 1024 });
      await start(f);
      await connected(f);
      const host = f.nativePorts[0];
      host.send({ type: "request", id: "huge-2", method: "x".repeat(2_000), params: {}, timeoutMs: 60_000 });
      await vi.waitFor(
        () =>
          expect(host.received).toContainEqual({
            type: "response",
            id: "huge-2",
            ok: false,
            error: expect.stringMatching(/too large .*native connection \(Message length exceeded maximum allowed length\.\)/),
          }),
        { timeout: 2_000 },
      );
      expect(host.open).toBe(true);
    });
  }

  it("with a host that declares a tiny limit, the error answer itself fits: a bare 'too large'", async () => {
    pairing({ token: TOKEN, nativeHost: true });
    // 100 bytes: the full explanation (about 250) would itself be over, and the hub would drop the connection.
    const f = createFakeChrome({ nativeHost: servingHost({ maxMessageBytes: 100 }) });
    await start(f);
    await connected(f);
    const host = f.nativePorts[0];
    host.send({ type: "request", id: "t1", method: "x".repeat(2_000), params: {}, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(host.received).toContainEqual({ type: "response", id: "t1", ok: false, error: "too large" }), { timeout: 2_000 });
    for (const m of host.received) expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThanOrEqual(m.type === "hello" ? Infinity : 100);
  });

  it("a TCP hub that refuses it with 4403 (the native host holds the port) sends it back to native messaging, even before pairing.json says so", async () => {
    pairing({ token: TOKEN });
    const hub = await tcpHub({ refuseWith: 4403 });
    const f = createFakeChrome({ local: { port: hub.port }, nativeHost: servingHost() });
    await start(f);
    await vi.waitFor(() => expect(f.connectNative).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await connected(f);
    expect(hub.received.filter((m) => m.type === "hello")).toHaveLength(1);
  });

  it("after a 4403, a native host that still fails sends it back to TCP, and native is tried again with backoff (no tight loop)", async () => {
    pairing({ token: TOKEN });
    const hub = await tcpHub({ refuseWith: 4403 });
    const tried: number[] = [];
    const f = createFakeChrome({
      local: { port: hub.port },
      nativeHost: (host) => {
        tried.push(Date.now());
        host.disconnect("Native host has exited.");
      },
    });
    await start(f);
    await until(() => tried.length >= 2, 3_000, "a second native try");
    // Each failed native try goes to TCP once (whose 4403 sends the next one back), and the retries
    // back off (RETRY_MIN_MS 0.5 s, doubling): the first 4403 waits 0.5 s, the second (after native
    // try 1) 1 s, so try 2 comes at least 1 s after try 1; 900 ms leaves room for timer jitter.
    expect(tried[1] - tried[0]).toBeGreaterThanOrEqual(900);
    const hellos = () => hub.received.filter((m) => m.type === "hello").length;
    await until(() => hellos() >= 3, 3_000, "TCP after the second native try");
    // The third native try waits 2 s more: TCP once per native try, no loop.
    expect([tried.length, hellos()]).toEqual([2, 3]);
    expect((await status(f)).lastError).toMatch(/native/i);
  });
});
