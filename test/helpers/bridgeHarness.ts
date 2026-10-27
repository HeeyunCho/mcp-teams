// Real-socket bridge tests: hubs and peers (ExtensionBridge) on the port the first hub got from
// listen(0), and a scripted fake extension that pairs like the real one, records every message
// it gets and answers requests as told.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ExtensionBridge, proof, type BridgeOptions } from "../../src/bridge.js";
import { EXTENSION_ORIGIN } from "../../src/extension.js";

export const TOKEN = "test-token";

/**
 * Short timings so tests that wait on joins, step-downs or pings run quickly. retryMs stays
 * above the peers' 0.1–0.5 s takeover delay: a hub handing over waits that long to rejoin.
 * Tests that move big payloads keep the real keep-alive (DEFAULT_BRIDGE_OPTIONS): under load
 * a 200 ms pong can queue behind the data and the hub drops the connection.
 */
export const FAST: BridgeOptions = { retryMs: 700, joinTimeoutMs: 500, stepDownMaxWaitMs: 2_000, keepAliveMs: 200, pickStatusTimeoutMs: 300, authTimeoutMs: 500 };

export interface Request {
  type: "request";
  id: string;
  method: string;
  params: any;
  timeoutMs?: number;
}

/** How the fake extension answers a request: a result, or a thrown error. */
export type Handler = (req: Request) => unknown | Promise<unknown>;

export interface FakeExtensionOptions {
  /** Answers each request; default: { ok: true }. Throwing answers with an error. */
  handle?: Handler;
  /** Delay before answering, in ms. */
  latencyMs?: number;
  /** Don't answer requests at all (a browser that hangs). */
  silent?: boolean;
  /** The pairing token it proves; null: says hello with neither token nor proof (0.2.0 and older). */
  token?: string | null;
  origin?: string;
  browser?: string;
  instance?: string;
  version?: string;
  /** Answer WebSocket pings (default true; false: a frozen browser). */
  pong?: boolean;
  /** Connect again soon after the connection closes, like the real extension (default true). */
  reconnect?: boolean;
}

/**
 * A fake browser extension connected to the hub on `port`. It answers the challenge with a
 * proof of the token and checks the hub's proof, as the real one does. Like the real one, it
 * connects again soon after its connection closes (e.g. a hub handing over), until close().
 */
export async function fakeExtension(port: number, opts: FakeExtensionOptions = {}) {
  const {
    handle = () => ({ ok: true }),
    latencyMs = 0,
    silent = false,
    token = TOKEN,
    origin = EXTENSION_ORIGIN,
    browser = "Chrome",
    instance = "profile-1",
    version = "0.0.0",
    pong = true,
    reconnect: again = true,
  } = opts;
  const received: any[] = [];
  let ws!: WebSocket;
  let welcome: any;
  let closing = false;
  const connect = () =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin, autoPong: pong });
      ws = socket;
      const nonce = randomUUID();
      let welcomed = false;
      socket.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.type === "challenge") {
          const hello = token === null ? { token: null } : { proof: proof(token, "client", msg.nonce), nonce };
          socket.send(JSON.stringify({ type: "hello", ...hello, version, browser, instance }));
          return;
        }
        if (msg.type === "welcome") {
          if (token !== null && msg.proof !== proof(token, "server", nonce)) return void socket.close();
          welcome = msg;
          welcomed = true;
          resolve();
          return;
        }
        if (msg.type !== "request" || silent) return;
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        let reply;
        try {
          reply = { type: "response", id: msg.id, ok: true, result: await handle(msg) };
        } catch (err) {
          reply = { type: "response", id: msg.id, ok: false, error: (err as Error).message };
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
      });
      socket.on("error", (err) => !welcomed && reject(err));
      socket.on("close", (code) => {
        if (!welcomed) reject(new Error(`extension refused (${code})`));
        else if (!closing && again) retry();
      });
    });
  // Like the real extension, it keeps trying until a hub answers (here every 100 ms).
  const retry = () =>
    setTimeout(() => {
      if (!closing) connect().catch(() => retry());
    }, 100);
  await connect();
  return {
    get ws() {
      return ws;
    },
    received,
    get welcome() {
      return welcome;
    },
    /** The requests it got, in order. */
    requests: () => received.filter((m) => m.type === "request") as Request[],
    close: () => {
      closing = true;
      return new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : (ws.once("close", () => r()), ws.close())));
    },
  };
}

export type FakeExtension = Awaited<ReturnType<typeof fakeExtension>>;

/**
 * Creates bridges and fake extensions on one port and closes them all in cleanup(). The first
 * session listens on port 0 and the rest use the port it got, so no port is ever picked, freed
 * and bound again (a test file running alongside could take it in between). `port`: a port the
 * test already holds instead, e.g. its own scripted hub listening on port 0.
 * Call cleanup() from afterEach, so a failing test never leaves a server holding the port.
 */
export async function bridgeHarness(options: BridgeOptions = FAST, { port: given }: { port?: number } = {}) {
  let port = given;
  const held = (): number => {
    if (port === undefined) throw new Error("the harness has no port until its first session listens");
    return port;
  };
  const bridges: ExtensionBridge[] = [];
  const extensions: FakeExtension[] = [];
  return {
    /** The port, once something holds it: the first session's, or the one given. */
    get port(): number {
      return held();
    },
    /** A server session's bridge: the first one started becomes the hub (on port 0), later ones peers. */
    async session(version = "1.0.0", extra: BridgeOptions & { token?: string } = {}) {
      const { token = TOKEN, ...rest } = extra;
      const b = new ExtensionBridge(port ?? 0, token, version, { ...options, ...rest });
      bridges.push(b);
      await b.start();
      port ??= b.port;
      return b;
    },
    async extension(opts: FakeExtensionOptions = {}) {
      const e = await fakeExtension(held(), opts);
      extensions.push(e);
      return e;
    },
    async cleanup() {
      await Promise.all(extensions.map((e) => e.close().catch(() => {})));
      await Promise.all(bridges.map((b) => b.close().catch(() => {})));
    },
  };
}

export type BridgeHarness = Awaited<ReturnType<typeof bridgeHarness>>;
