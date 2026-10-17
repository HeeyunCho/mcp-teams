// 2.3: the extension's watchdog. The hub sends {type:"ping"} every keep-alive period; when none has
// come for about 2 periods (the welcome's heartbeatMs, else 45 s) the worker connects again, so a
// hub that froze is noticed instead of holding the worker's connection open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { proof } from "../../src/bridge.js";
import { FAST, bridgeHarness, freePort, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { connectWorker, createFakeChrome, loadWorker, NativeWebSocket, openedSockets } from "../helpers/fakeChrome.js";

const TOKEN = "watchdog-token";
const PERIOD = 200;

let wss: WebSocketServer | undefined;
let h: BridgeHarness | undefined;
let link: { disconnect: () => Promise<void> } | undefined;
const timers: NodeJS.Timeout[] = [];

afterEach(async () => {
  await link?.disconnect();
  link = undefined;
  for (const t of timers.splice(0)) clearInterval(t);
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/**
 * A hub that pairs with the worker like the real one. `heartbeatMs`: what its welcome declares
 * (undefined: declares nothing); `pingEveryMs`: how often it sends {type:"ping"} (0: never, a
 * frozen hub). Records when each connection was welcomed and closed.
 */
async function scriptedHub({ heartbeatMs, pingEveryMs = 0 }: { heartbeatMs?: number; pingEveryMs?: number }) {
  const port = await freePort();
  const connections: { welcomedAt?: number; closedAt?: number }[] = [];
  wss = new WebSocketServer({ host: "127.0.0.1", port });
  wss.on("connection", (ws: WebSocket) => {
    const c: (typeof connections)[number] = {};
    connections.push(c);
    ws.on("close", () => (c.closedAt = Date.now()));
    ws.send(JSON.stringify({ type: "challenge", nonce: "challenge-1" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "hello") return;
      const declared = heartbeatMs === undefined ? {} : { heartbeatMs };
      ws.send(JSON.stringify({ type: "welcome", serverVersion: "0.0.0", proof: proof(TOKEN, "server", msg.nonce), ...declared }));
      c.welcomedAt = Date.now();
      if (pingEveryMs) timers.push(setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "ping" })), pingEveryMs));
    });
  });
  return { port, connections };
}

async function connectedWorker(port: number, connected: () => boolean) {
  const fake = createFakeChrome({ local: { token: TOKEN, port } });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  link = await connectWorker(fake, connected);
  return worker;
}

describe("2.3: extension watchdog", () => {
  it("2.3: the hub's welcome declares its heartbeat period", async () => {
    h = await bridgeHarness({ ...FAST, keepAliveMs: PERIOD });
    await h.session();
    const ext = await h.extension();
    expect(ext.welcome.heartbeatMs).toBe(PERIOD);
  });

  it("2.3: without the welcome's heartbeatMs, the watchdog waits 45 s", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    expect(worker.HEARTBEAT_TIMEOUT_MS).toBe(45_000);
  });

  it("2.3: the worker connects again when a hub that declared its heartbeat sends no ping for about 2 periods", async () => {
    const hub = await scriptedHub({ heartbeatMs: PERIOD });
    await connectedWorker(hub.port, () => hub.connections[0]?.welcomedAt !== undefined);
    await vi.waitFor(() => expect(hub.connections.length).toBeGreaterThanOrEqual(2), { timeout: 10 * PERIOD });
    const first = hub.connections[0];
    // The frozen hub's connection is dropped, after about 2 periods of silence, not sooner.
    expect(first.closedAt).toBeDefined();
    expect(first.closedAt! - first.welcomedAt!).toBeGreaterThanOrEqual(2 * PERIOD);
    expect(first.closedAt! - first.welcomedAt!).toBeLessThan(3 * PERIOD + 300);
  });

  it("2.3: pings from the hub keep the connection", async () => {
    const hub = await scriptedHub({ heartbeatMs: PERIOD, pingEveryMs: PERIOD });
    await connectedWorker(hub.port, () => hub.connections[0]?.welcomedAt !== undefined);
    await new Promise((r) => setTimeout(r, 8 * PERIOD));
    expect(hub.connections).toHaveLength(1);
    expect(hub.connections[0].closedAt).toBeUndefined();
  });

  it("2.3: a worker on a live hub stays connected across many periods", async () => {
    h = await bridgeHarness({ ...FAST, keepAliveMs: PERIOD });
    const bridge = await h.session();
    const fake = createFakeChrome({ local: { token: "test-token", port: h.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, () => bridge.connected);
    const extensionSocket = () => [...(bridge as any).sockets.keys()][0];
    const before = extensionSocket();
    await new Promise((r) => setTimeout(r, 8 * PERIOD));
    expect(extensionSocket()).toBe(before);
    expect(await fake.pageMessage("popup.html", { type: "popup:status" })).toMatchObject({ state: "connected" });
  });
});
