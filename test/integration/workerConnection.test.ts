// The worker's own connection to the hub (extension/background.js connect()), against a
// scripted hub, so the test decides exactly when each message arrives.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { proof } from "../../src/bridge.js";
import { freePort } from "../helpers/bridgeHarness.js";
import { connectWorker, createFakeChrome, loadWorker, NativeWebSocket, openedSockets } from "../helpers/fakeChrome.js";

const TOKEN = "worker-connection-token";

let wss: WebSocketServer | undefined;
let link: { disconnect: () => Promise<void> } | undefined;

afterEach(async () => {
  await link?.disconnect();
  link = undefined;
  // A worker still connected would hold the server's close open.
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  openedSockets.length = 0;
});

/**
 * A hub that answers hello with a welcome (proving itself like the real one, unless `forged`)
 * and sends `afterWelcome` right behind it, before the worker can have checked the proof;
 * with `dropAfter` it then drops the connection. `token`: the one it proves (asked per welcome).
 */
async function scriptedHub(afterWelcome: object[], { forged = false, dropAfter = false, token = (): string => TOKEN } = {}) {
  const port = await freePort();
  const received: any[] = [];
  let welcomed = false;
  let closed = false;
  wss = new WebSocketServer({ host: "127.0.0.1", port });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("close", () => (closed = true));
    ws.send(JSON.stringify({ type: "challenge", nonce: "challenge-1" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type !== "hello") return;
      ws.send(JSON.stringify({ type: "welcome", serverVersion: "0.0.0", proof: proof(forged ? "not-the-token" : token(), "server", msg.nonce) }));
      for (const m of afterWelcome) ws.send(JSON.stringify(m));
      welcomed = true;
      // The connection goes away before the worker can have checked the welcome.
      if (dropAfter) ws.terminate();
    });
  });
  return { port, received, welcomed: () => welcomed, closed: () => closed };
}

describe("worker connection", () => {
  it("2.1b: a request that arrives while the worker checks the hub's welcome is answered, not dropped", async () => {
    const hub = await scriptedHub([{ type: "request", id: "r1", method: "status", params: {}, timeoutMs: 5_000 }]);
    const fake = createFakeChrome({ local: { token: TOKEN, port: hub.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, hub.welcomed);
    await vi.waitFor(() => expect(hub.received).toContainEqual(expect.objectContaining({ type: "response", id: "r1", ok: true })), { timeout: 2_000 });
  });

  it("2.1b: a request held while its connection closed is never run (a send opens no window nobody could answer)", async () => {
    const send = { type: "request", id: "s1", method: "requestSend", params: { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" }, timeoutMs: 60_000 };
    const hub = await scriptedHub([send], { dropAfter: true });
    // A slow proof check (a busy machine), so the drop always arrives while the welcome is checked.
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args: Parameters<SubtleCrypto["sign"]>) => {
      await new Promise((r) => setTimeout(r, 100));
      return sign(...args);
    });
    const fake = createFakeChrome({ local: { token: TOKEN, port: hub.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    vi.stubGlobal("WebSocket", NativeWebSocket);
    for (const l of fake.chrome.runtime.onStartup.listeners) l();
    await vi.waitFor(() => expect(hub.closed()).toBe(true), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Had the check finished first, the send would have run on an open connection and its close
    // withdrawn it: either way no window may be left that nobody can answer.
    const opened = await Promise.all(fake.spies.windowsCreate.mock.results.map((r) => r.value));
    for (const w of opened) expect(fake.spies.windowsRemove).toHaveBeenCalledWith(w.id);
    expect(worker.pendingSendCount()).toBe(0);
  });

  it("2.1c: a connection refused after the worker already reconnected leaves the newer connection's state alone", async () => {
    // The first connection gets a forged welcome; the pairing changes while it is checked, and the
    // worker's new connection (with the new token) is proven and connected before that check ends.
    const NEW_TOKEN = `${TOKEN}-new`;
    let welcomes = 0;
    const hub = await scriptedHub([], { token: () => (welcomes++ === 0 ? "not-the-token" : NEW_TOKEN) });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let signs = 0;
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args: Parameters<SubtleCrypto["sign"]>) => {
      // Sign 1: the first hello's proof; sign 2: checking the first (forged) welcome, made slow.
      if (++signs === 2) await new Promise((r) => setTimeout(r, 500));
      return sign(...args);
    });
    const fake = createFakeChrome({ local: { token: TOKEN, port: hub.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    vi.stubGlobal("WebSocket", NativeWebSocket);
    for (const l of fake.chrome.runtime.onStartup.listeners) l();
    await vi.waitFor(() => expect(signs).toBe(2), { timeout: 2_000 });
    await fake.chrome.storage.local.set({ token: NEW_TOKEN });
    const status = () => fake.pageMessage("popup.html", { type: "popup:status" }) as Promise<{ state: string }>;
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "connected" }), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 700)); // the first connection's check has ended (refused)
    expect(await status()).toMatchObject({ state: "connected" });
  });

  it("2.1b: after a welcome without the right proof, a request that came with it is never run", async () => {
    const hub = await scriptedHub([{ type: "request", id: "r1", method: "status", params: {}, timeoutMs: 5_000 }], { forged: true });
    const fake = createFakeChrome({ local: { token: TOKEN, port: hub.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    // Not connectWorker: this worker never gets to "connected".
    vi.stubGlobal("WebSocket", NativeWebSocket);
    for (const l of fake.chrome.runtime.onStartup.listeners) l();
    await vi.waitFor(() => expect(hub.closed()).toBe(true), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.received.filter((m) => m.type === "response")).toEqual([]);
    expect(await fake.pageMessage("popup.html", { type: "popup:status" })).toMatchObject({ state: "unauthorized" });
  });
});
