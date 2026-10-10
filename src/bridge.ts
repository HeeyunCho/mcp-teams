import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { EXTENSION_ORIGIN as TRUSTED_EXTENSION_ORIGIN } from "./extension.js";

/**
 * Local WebSocket bridge between MCP server processes and the browser extension.
 *
 * Several Claude sessions can each run an mcp-teams server, but only one can
 * own the port. The first one becomes the hub: the extension connects to it (MV3
 * service workers cannot listen), authenticates with the pairing token and answers
 * RPC requests. Later servers become peers: they connect to the hub with the same
 * token and forward their calls through it. If the hub exits, a peer takes over the
 * port and the extension reconnects to it.
 *
 * Only loopback connections are accepted, and never from a web page: browsers always
 * send an Origin header, so connections must come from an extension origin or from
 * a local process (no Origin). Our own extension (its fixed id) needs no token; any
 * other extension origin and the peers must present the pairing token.
 */

export interface ExtensionInfo {
  version: string;
  browser?: string;
  /** chrome-extension://<id> it connected from (unset for connections without an Origin). */
  origin?: string;
  /** Stays the same for one browser profile across reconnects. */
  instance?: string;
}

export type BridgeRole = "hub" | "peer" | "none";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Hub: the extension connection the request went to. */
  socket?: WebSocket;
}

/** How long the hub trusts what it learned about which browser has Teams signed in. */
const PICK_STATUS_TIMEOUT_MS = 3_000;

const EXTENSION_ORIGIN = /^(chrome-extension|extension):\/\/[a-z0-9]+$/i;
const RETRY_MS = 2_000;
/** Largest message accepted on the bridge. Attachments travel one per message as base64 (+33%). */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const JOIN_TIMEOUT_MS = 3_000;
/** A hub handing over to a newer server waits this long for its own calls to finish. */
const STEP_DOWN_MAX_WAIT_MS = 5 * 60_000;

/** True when version a is newer than b (x.y.z; anything else never counts as newer). */
export function isNewer(a: unknown, b: unknown): boolean {
  const parse = (v: unknown) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function describeSocketError(err: NodeJS.ErrnoException, limit: number): string {
  return err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
    ? `The response was too large (over ${Math.round(limit / 1024 / 1024)} MB) and was dropped. The connection is re-established automatically.`
    : `Bridge connection error: ${err.message}`;
}

export class ExtensionBridge {
  role: BridgeRole = "none";
  /** The extension calls go to (with several browsers: the preferred one). */
  extension?: ExtensionInfo;
  /** Every connected extension, one per browser profile. */
  extensions: ExtensionInfo[] = [];
  listenError?: string;
  /** Peer only: version of the hub server it forwards through. */
  hubVersion?: string;

  private wss?: WebSocketServer;
  private sockets = new Map<WebSocket, ExtensionInfo>(); // hub: the extensions
  private preferred?: WebSocket; // hub: the extension that last answered a call
  private hub?: WebSocket; // peer: the hub
  private peers = new Set<WebSocket>();
  private pending = new Map<string, Pending>();
  private keepAlive?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private steppingDown = false;
  private alive = new WeakSet<WebSocket>(); // hub: extensions that answered the last ping

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly serverVersion: string,
    private readonly maxMessageBytes = MAX_MESSAGE_BYTES,
  ) {}

  /** Becomes the hub, or a peer of the existing hub. Keeps retrying in the background if neither works. */
  async start(): Promise<void> {
    if (this.closed) return;
    if (await this.listen()) return this.setRole("hub");
    if (await this.join()) return this.setRole("peer");
    this.role = "none";
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), RETRY_MS);
    this.retry.unref();
  }

  get connected(): boolean {
    if (this.role === "hub") return [...this.sockets.keys()].some((s) => s.readyState === WebSocket.OPEN);
    if (this.role === "peer") return this.hub?.readyState === WebSocket.OPEN && !!this.extension;
    return false;
  }

  private setRole(role: BridgeRole) {
    this.role = role;
    this.listenError = undefined;
  }

  // ------------------------------------------------------------------ hub

  private listen(): Promise<boolean> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        maxPayload: this.maxMessageBytes,
        verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => !origin || EXTENSION_ORIGIN.test(origin),
      });
      let listening = false;
      wss.once("listening", () => {
        listening = true;
        this.wss = wss;
        resolve(true);
      });
      wss.on("error", (err: NodeJS.ErrnoException) => {
        if (listening) return this.restartHub(`bridge server error: ${err.message}`);
        if (err.code !== "EADDRINUSE") this.listenError = err.message;
        wss.close();
        resolve(false);
      });
      wss.on("connection", (ws, req) => this.onConnection(ws, req.headers.origin));
    });
  }

  private onConnection(ws: WebSocket, origin?: string) {
    let authed = false;
    const authTimer = setTimeout(() => !authed && ws.close(4401, "auth timeout"), 5000);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (!authed) {
        const trusted = msg.type === "hello" && origin === TRUSTED_EXTENSION_ORIGIN;
        if ((!trusted && msg.token !== this.token) || (msg.type !== "hello" && msg.type !== "peer-hello")) {
          ws.close(4401, "bad token");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (msg.type === "hello") this.acceptExtension(ws, msg, origin);
        else this.acceptPeer(ws, msg.version);
        return;
      }
      if (this.sockets.has(ws)) this.onExtensionMessage(msg);
      else if (this.peers.has(ws)) this.onPeerMessage(ws, msg);
    });

    // Without a listener, a socket error (e.g. a message over MAX_MESSAGE_BYTES) would be
    // an unhandled 'error' event and end the whole process. The socket closes afterwards.
    ws.on("error", (err: NodeJS.ErrnoException) => {
      if (this.sockets.has(ws)) this.rejectAll(describeSocketError(err, this.maxMessageBytes), ws);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      this.peers.delete(ws);
      if (this.sockets.delete(ws)) {
        if (this.preferred === ws) this.preferred = undefined;
        this.rejectAll("Browser extension disconnected", ws);
        this.updateExtensions();
        if (!this.sockets.size) clearInterval(this.keepAlive);
      }
    });
  }

  /**
   * Several browsers (or profiles) can be connected at once, one connection each. A
   * reconnect from the same one (same instance, or for older extensions the same origin
   * and browser) replaces its old connection. While our extension (fixed id) is
   * connected, copies with another id (e.g. an older one loaded from another folder) are
   * turned away, and connecting ours replaces them.
   */
  private acceptExtension(ws: WebSocket, msg: any, origin?: string) {
    const info: ExtensionInfo = {
      version: String(msg.version ?? "unknown"),
      browser: msg.browser,
      ...(origin ? { origin } : {}),
      ...(typeof msg.instance === "string" ? { instance: msg.instance } : {}),
    };
    const ours = origin === TRUSTED_EXTENSION_ORIGIN;
    const others = [...this.sockets].filter(([s]) => s !== ws);
    if (!ours && others.some(([, i]) => i.origin === TRUSTED_EXTENSION_ORIGIN)) {
      ws.close(4409, "another copy of the extension is connected");
      return;
    }
    const key = (i: ExtensionInfo) => i.instance ?? `${i.origin}|${i.browser}`;
    for (const [s, i] of others) {
      if (key(i) === key(info) || (ours && i.origin !== TRUSTED_EXTENSION_ORIGIN) || (!ours && !i.instance)) {
        s.close(4000, "replaced");
        // Its close event comes later and no longer finds it, so fail its calls now.
        this.sockets.delete(s);
        this.rejectAll("Browser extension reconnected; try again.", s);
        if (this.preferred === s) this.preferred = undefined;
      }
    }
    this.sockets.set(ws, info);
    ws.send(JSON.stringify({ type: "welcome", serverVersion: this.serverVersion }));
    this.startKeepAlive(ws);
    this.updateExtensions();
  }

  /** Refreshes `extension`/`extensions` after a change and tells the peers. */
  private updateExtensions() {
    this.extensions = [...this.sockets.values()];
    this.extension = (this.preferred && this.sockets.get(this.preferred)) ?? this.extensions.at(-1);
    this.broadcastState();
  }

  /**
   * The extension a call goes to: the only one, the one that answered last, or else the
   * one whose browser has Teams signed in (then: has a Teams tab, then: newest).
   */
  private async pickExtension(): Promise<WebSocket | undefined> {
    const open = [...this.sockets.keys()].filter((s) => s.readyState === WebSocket.OPEN);
    if (open.length <= 1) return open[0];
    if (this.preferred && open.includes(this.preferred)) return this.preferred;
    type Status = { teamsTabs?: number; sessions?: { sessionCaptured?: boolean }[] };
    const statuses = await Promise.all(
      open.map((s) => this.send<Status>(s, "status", {}, PICK_STATUS_TIMEOUT_MS).catch(() => null)),
    );
    const score = (st: Status | null) =>
      !st ? -1 : st.sessions?.some((x) => x.sessionCaptured) ? 2 : (st.teamsTabs ?? 0) > 0 ? 1 : 0;
    let best = open.length - 1; // newest first among equals
    for (let i = open.length - 1; i >= 0; i--) if (score(statuses[i]) > score(statuses[best])) best = i;
    return open[best];
  }

  private acceptPeer(ws: WebSocket, peerVersion: unknown) {
    this.peers.add(ws);
    ws.send(
      JSON.stringify({ type: "peer-welcome", serverVersion: this.serverVersion, extension: this.extension ?? null, extensions: this.extensions }),
    );
    // A newer server joined: hand the port to it, so its fixes (and what the newer
    // extension expects) take effect without restarting this AI session.
    if (isNewer(peerVersion, this.serverVersion)) void this.stepDown(String(peerVersion));
  }

  /**
   * Hub: stops serving (after this server's own calls finish) and joins again as a peer.
   * Peers see the hub close and race for the port, retrying after 0.1–0.5 s; this one
   * waits longer, so a peer takes over. If an older peer wins, the newer one steps it
   * down in turn when it joins.
   */
  private async stepDown(newer: string) {
    if (this.steppingDown || this.role !== "hub") return;
    this.steppingDown = true;
    const end = Date.now() + STEP_DOWN_MAX_WAIT_MS;
    while (this.pending.size && Date.now() < end && !this.closed) await new Promise((r) => setTimeout(r, 500));
    if (this.closed || this.role !== "hub") return void (this.steppingDown = false);
    console.error(`[mcp-teams ${this.serverVersion}] handing the bridge to mcp-teams ${newer}`);
    this.restartHub("mcp-teams was updated; try again in a few seconds.", RETRY_MS);
    this.steppingDown = false;
  }

  /** Hub: closes the server and every connection, then becomes a hub or peer again. */
  private restartHub(reason: string, delayMs = 100 + Math.random() * 400) {
    const wss = this.wss;
    this.wss = undefined;
    this.role = "none";
    clearInterval(this.keepAlive);
    this.rejectAll(reason);
    for (const s of this.sockets.keys()) s.close(1012, "restarting");
    for (const peer of this.peers) peer.close(1012, "restarting");
    this.sockets.clear();
    this.peers.clear();
    this.preferred = undefined;
    this.extension = undefined;
    this.extensions = [];
    wss?.close();
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), delayMs);
    this.retry.unref();
  }

  private onExtensionMessage(msg: any) {
    if (msg.type === "response" && typeof msg.id === "string") this.settle(msg);
  }

  /** Runs a peer's call against the extension and sends back the outcome. */
  private onPeerMessage(ws: WebSocket, msg: any) {
    if (msg.type !== "request" || typeof msg.id !== "string") return;
    const reply = (body: object) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: msg.id, ...body }));
      } catch (err) {
        console.error(`[mcp-teams] could not answer a peer: ${(err as Error).message}`);
      }
    };
    this.call(String(msg.method), msg.params ?? {}, Number(msg.timeoutMs) || undefined).then(
      (result) => reply({ ok: true, result }),
      (err: Error) => reply({ ok: false, error: err.message }),
    );
  }

  private broadcastState() {
    const state = JSON.stringify({ type: "ext-state", extension: this.extension ?? null, extensions: this.extensions });
    for (const peer of this.peers) if (peer.readyState === WebSocket.OPEN) peer.send(state);
  }

  /**
   * Pings keep the MV3 service worker alive while connected. A connection that didn't
   * answer the previous WebSocket ping (a suspended or crashed browser) is dropped.
   */
  private startKeepAlive(ws?: WebSocket) {
    if (ws) {
      this.alive.add(ws);
      ws.on("pong", () => this.alive.add(ws));
    }
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      for (const s of this.sockets.keys()) {
        if (s.readyState !== WebSocket.OPEN) continue;
        if (!this.alive.has(s)) {
          s.terminate();
          continue;
        }
        this.alive.delete(s);
        s.ping();
        s.send(JSON.stringify({ type: "ping" }));
      }
    }, 20_000);
    this.keepAlive.unref();
  }

  // ------------------------------------------------------------------ peer

  private join(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: this.maxMessageBytes });
      let joined = false;
      const timer = setTimeout(() => ws.terminate(), JOIN_TIMEOUT_MS);
      ws.on("open", () => ws.send(JSON.stringify({ type: "peer-hello", token: this.token, version: this.serverVersion })));
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "peer-welcome" && !joined) {
          joined = true;
          clearTimeout(timer);
          this.hub = ws;
          this.hubVersion = String(msg.serverVersion ?? "unknown");
          this.extension = msg.extension ?? undefined;
          this.extensions = msg.extensions ?? (msg.extension ? [msg.extension] : []);
          resolve(true);
        } else if (msg.type === "ext-state") {
          this.extension = msg.extension ?? undefined;
          this.extensions = msg.extensions ?? (msg.extension ? [msg.extension] : []);
        } else if (msg.type === "response" && typeof msg.id === "string") {
          this.settle(msg);
        }
      });
      ws.on("error", (err: NodeJS.ErrnoException) => {
        if (joined && this.hub === ws) this.rejectAll(describeSocketError(err, this.maxMessageBytes));
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        if (!joined) {
          this.listenError =
            code === 4401
              ? `The mcp-teams server on port ${this.port} rejected this server's token.`
              : `Port ${this.port} is in use by another program.`;
          return resolve(false);
        }
        if (this.hub !== ws) return;
        // The hub went away: take over the port or join whoever did.
        this.hub = undefined;
        this.hubVersion = undefined;
        this.extension = undefined;
        this.extensions = [];
        this.role = "none";
        this.rejectAll("The mcp-teams hub restarted; try again in a few seconds.");
        if (!this.closed) {
          clearTimeout(this.retry);
          this.retry = setTimeout(() => void this.start(), 100 + Math.random() * 400);
          this.retry.unref();
        }
      });
    });
  }

  // ------------------------------------------------------------------ calls

  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (method === "reloadAll" && this.role === "hub") return this.reloadAll(timeoutMs) as Promise<T>;
    const target = this.role === "hub" ? await this.pickExtension() : this.role === "peer" ? this.hub : undefined;
    if (!this.connected || !target) {
      const reason =
        this.role === "none"
          ? (this.listenError ?? "Connecting to the mcp-teams bridge; try again in a few seconds.")
          : "Browser extension is not connected. Open Chrome or Edge with the mcp-teams extension installed (run `mcp-teams setup`).";
      throw new Error(reason);
    }
    const result = await this.send<T>(target, method, params, timeoutMs);
    if (this.role === "hub" && this.preferred !== target && this.sockets.has(target)) {
      this.preferred = target;
      this.updateExtensions();
    }
    return result;
  }

  /** Hub: asks every connected browser's extension to reload itself. */
  private async reloadAll(timeoutMs: number) {
    const open = [...this.sockets.keys()].filter((s) => s.readyState === WebSocket.OPEN);
    if (!open.length) throw new Error("Browser extension is not connected.");
    const results = await Promise.allSettled(open.map((s) => this.send(s, "reload", {}, timeoutMs)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === results.length) throw failed[0].reason;
    return { reloading: results.length - failed.length };
  }

  /** Sends one request on a connection (an extension for the hub, the hub for a peer). */
  private send<T>(target: WebSocket, method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = randomUUID();
    // A peer waits a little longer than the hub, so the hub's own timeout message wins.
    const wait = this.role === "peer" ? timeoutMs + 5_000 : timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension call '${method}' timed out`));
      }, wait);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, socket: this.role === "hub" ? target : undefined });
      target.send(JSON.stringify({ type: "request", id, method, params, timeoutMs }));
    });
  }

  /**
   * Has the extension reload itself from disk, then waits until it is connected again.
   * Returns its version before and after.
   */
  async reloadExtension(timeoutMs = 30_000): Promise<{ before: string | null; after: string }> {
    const before = this.extension?.version ?? null;
    await this.call("reloadAll");
    // The extensions reload 250 ms after answering; wait for the old connections to go,
    // then for every browser to be back. Copies with another id are turned away (4409)
    // once ours is back, so only ours count when ours is connected.
    const ours = this.extensions.filter((e) => e.origin === TRUSTED_EXTENSION_ORIGIN).length;
    const count = Math.max(1, ours || this.extensions.length);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(1_000);
    const end = Date.now() + timeoutMs;
    for (; Date.now() < end; await sleep(250)) {
      if (this.connected && this.extension && this.extensions.length >= count) return { before, after: this.extension.version };
    }
    if (this.connected && this.extension) return { before, after: this.extension.version };
    throw new Error(`The extension did not reconnect within ${timeoutMs / 1000} s. Check chrome://extensions for errors.`);
  }

  private settle(msg: { id: string; ok?: boolean; result?: unknown; error?: string }) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "extension error"));
  }

  /** Fails the pending calls (only those sent on `socket`, when given). */
  private rejectAll(reason: string, socket?: WebSocket) {
    for (const [id, p] of this.pending) {
      if (socket && p.socket !== socket) continue;
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.keepAlive);
    this.rejectAll("mcp-teams is shutting down");
    this.hub?.close();
    for (const s of this.sockets.keys()) s.close();
    for (const peer of this.peers) peer.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }
}
