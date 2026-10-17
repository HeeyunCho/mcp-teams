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
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/**
 * A hub that answers hello with a welcome (proving itself like the real one, unless `forged`)
 * and sends `afterWelcome` right behind it, before the worker can have checked the proof;
 * with `dropAfter` it then drops the connection.
 */
async function scriptedHub(afterWelcome: object[], { forged = false, dropAfter = false } = {}) {
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
      ws.send(JSON.stringify({ type: "welcome", serverVersion: "0.0.0", proof: proof(forged ? "not-the-token" : TOKEN, "server", msg.nonce) }));
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
    const fake = createFakeChrome({ local: { token: TOKEN, port: hub.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    vi.stubGlobal("WebSocket", NativeWebSocket);
    for (const l of fake.chrome.runtime.onStartup.listeners) l();
    await vi.waitFor(() => expect(hub.closed()).toBe(true), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 300));
    // On a busy machine the check may finish before the drop arrives: then the send ran on an open
    // connection and its close withdrew it. Either way no window is left that nobody can answer.
    const opened = await Promise.all(fake.spies.windowsCreate.mock.results.map((r) => r.value));
    for (const w of opened) expect(fake.spies.windowsRemove).toHaveBeenCalledWith(w.id);
    expect(worker.pendingSendCount()).toBe(0);
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
