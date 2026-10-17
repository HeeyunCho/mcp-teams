import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
 * a local process (no Origin). Both sides prove they know the pairing token without
 * sending it: the server opens with a challenge, the client (extension or peer) answers
 * with proof(token, "client", challenge) and its own nonce, and the welcome carries
 * proof(token, "server", nonce). So neither a program posing as the extension (any
 * local process can send any Origin) nor one holding the port while no AI app runs
 * gets anything. The extension reads the token from pairing.json, which setup writes
 * into its installed folder.
 */

/** HMAC-SHA256 of `${role}:${nonce}` with the pairing token, base64url. The extension computes the same (teams.js). */
export function proof(token: string, role: "client" | "server", nonce: string): string {
  return createHmac("sha256", token).update(`${role}:${nonce}`).digest("base64url");
}

function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const newNonce = () => randomBytes(24).toString("base64url");

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
  /** Told the other side to drop it ({type:"cancel"}); its answer still counts for a moment. */
  withdrawn?: boolean;
  /** A send: after it is withdrawn its answer still counts for cancelGraceMs (the user may have clicked). */
  grace?: boolean;
  /** Hub: the extension connection the request went to. */
  socket?: WebSocket;
}

const EXTENSION_ORIGIN = /^(chrome-extension|extension):\/\/[a-z0-9]+$/i;
/** Largest message accepted on the bridge. Attachments travel one per message as base64 (+33%). */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/** Sizes and timings of the bridge. Tests shorten them; the server uses the defaults. */
export interface BridgeOptions {
  /** Largest message accepted on the bridge. */
  maxMessageBytes?: number;
  /** How often the hub pings each extension (also keeps the MV3 service worker alive). */
  keepAliveMs?: number;
  /** How long a server that is neither hub nor peer waits before trying again. */
  retryMs?: number;
  /** How long joining an existing hub may take. */
  joinTimeoutMs?: number;
  /** How long a new connection has to prove the token. */
  authTimeoutMs?: number;
  /** How long the hub trusts what it learned about which browser has Teams signed in. */
  pickStatusTimeoutMs?: number;
  /** A hub handing over to a newer server waits this long for its own calls to finish. */
  stepDownMaxWaitMs?: number;
  /** After a call is withdrawn (timeout or cancel), how long its answer still counts. */
  cancelGraceMs?: number;
}

export const DEFAULT_BRIDGE_OPTIONS: Readonly<Required<BridgeOptions>> = Object.freeze({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  keepAliveMs: 20_000,
  retryMs: 2_000,
  joinTimeoutMs: 3_000,
  authTimeoutMs: 5_000,
  pickStatusTimeoutMs: 3_000,
  stepDownMaxWaitMs: 5 * 60_000,
  cancelGraceMs: 2_000,
});

const cancelledError = () => new Error("Cancelled: the request was withdrawn.");

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
  private peerCalls = new Map<WebSocket, Map<string, AbortController>>(); // hub: each peer's calls, by the peer's id
  private pending = new Map<string, Pending>();
  private keepAlive?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private steppingDown = false;
  private alive = new WeakSet<WebSocket>(); // hub: extensions that answered the last ping
  private legacyReloaded = false; // hub: an extension of 0.2.0 or older was told to reload
  private readonly opts: Required<BridgeOptions>;
  private boundPort?: number; // hub: the port it listens on (port 0 picks a free one)

  /** The 4th argument is the options, or (as before) just the largest message size. */
  constructor(
    private readonly requestedPort: number,
    private readonly token: string,
    private readonly serverVersion: string,
    options: BridgeOptions | number = {},
  ) {
    const given: BridgeOptions = typeof options === "number" ? { maxMessageBytes: options } : options;
    // A key given as undefined keeps its default (spreading it would overwrite the default).
    const defined = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
    this.opts = { ...DEFAULT_BRIDGE_OPTIONS, ...defined };
  }

  /** The bridge's port: the one it listens on as the hub (port 0 picks a free one), else the one it was given. */
  get port(): number {
    return this.boundPort ?? this.requestedPort;
  }

  private get maxMessageBytes(): number {
    return this.opts.maxMessageBytes;
  }

  /** Read-only, for tests: calls waiting for an answer, and (hub) peers' calls being run. */
  get inFlight(): { pending: number; peerCalls: number } {
    let peerCalls = 0;
    for (const calls of this.peerCalls.values()) peerCalls += calls.size;
    return { pending: this.pending.size, peerCalls };
  }

  /** Becomes the hub, or a peer of the existing hub. Keeps retrying in the background if neither works. */
  async start(): Promise<void> {
    if (this.closed) return;
    if (await this.listen()) return this.setRole("hub");
    if (await this.join()) return this.setRole("peer");
    this.role = "none";
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), this.opts.retryMs);
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
        port: this.requestedPort,
        maxPayload: this.maxMessageBytes,
        verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => !origin || EXTENSION_ORIGIN.test(origin),
      });
      let listening = false;
      wss.once("listening", () => {
        listening = true;
        this.wss = wss;
        this.boundPort = (wss.address() as { port: number }).port;
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
    const authTimer = setTimeout(() => !authed && ws.close(4401, "auth timeout"), this.opts.authTimeoutMs);
    const challenge = newNonce();
    ws.send(JSON.stringify({ type: "challenge", nonce: challenge }));

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (!authed) {
        if (msg.type !== "hello" && msg.type !== "peer-hello") return void ws.close(4401, "bad token");
        // Clients up to 0.2.0 send the token itself (peers, or an extension paired by hand).
        const proven = sameProof(msg.proof, proof(this.token, "client", challenge)) || (typeof msg.token === "string" && msg.token === this.token);
        if (!proven) {
          // Our extension up to 0.2.0 says hello with neither; it is only told to reload.
          if (msg.type === "hello" && origin === TRUSTED_EXTENSION_ORIGIN && msg.token == null && msg.proof == null) return this.reloadLegacy(ws);
          return void ws.close(4401, "bad token");
        }
        authed = true;
        clearTimeout(authTimer);
        const welcome = typeof msg.nonce === "string" ? { proof: proof(this.token, "server", msg.nonce) } : {};
        if (msg.type === "hello") this.acceptExtension(ws, msg, welcome, origin);
        else this.acceptPeer(ws, msg.version, welcome);
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
      // A peer that went away can't be told the outcome of its calls: withdraw them.
      for (const ac of this.peerCalls.get(ws)?.values() ?? []) ac.abort();
      this.peerCalls.delete(ws);
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
  private acceptExtension(ws: WebSocket, msg: any, welcome: object, origin?: string) {
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
        // Its calls fail now (below), before it sees the close: have it drop them first, so an
        // open confirmation window closes instead of posting on a click in between.
        for (const [id, p] of this.pending) {
          if (p.socket !== s || s.readyState !== WebSocket.OPEN) continue;
          try {
            s.send(JSON.stringify({ type: "cancel", id }));
          } catch {
            // closing anyway
          }
        }
        s.close(4000, "replaced");
        // Its close event comes later and no longer finds it, so fail its calls now.
        this.sockets.delete(s);
        this.rejectAll("Browser extension reconnected; try again.", s);
        if (this.preferred === s) this.preferred = undefined;
      }
    }
    this.sockets.set(ws, info);
    ws.send(JSON.stringify({ type: "welcome", serverVersion: this.serverVersion, ...welcome }));
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
      open.map((s) => this.send<Status>(s, "status", {}, this.opts.pickStatusTimeoutMs).catch(() => null)),
    );
    const score = (st: Status | null) =>
      !st ? -1 : st.sessions?.some((x) => x.sessionCaptured) ? 2 : (st.teamsTabs ?? 0) > 0 ? 1 : 0;
    let best = open.length - 1; // newest first among equals
    for (let i = open.length - 1; i >= 0; i--) if (score(statuses[i]) > score(statuses[best])) best = i;
    return open[best];
  }

  /**
   * Our extension up to 0.2.0 can't prove it knows the token, and anything can claim its
   * origin, so it gets no calls. It is asked once to reload, which loads the update this
   * server put in its folder, and the new version connects with a proof.
   */
  private reloadLegacy(ws: WebSocket) {
    if (!this.legacyReloaded) {
      this.legacyReloaded = true;
      ws.send(JSON.stringify({ type: "request", id: randomUUID(), method: "reload", params: {}, timeoutMs: 10_000 }));
    }
    setTimeout(() => ws.close(4426, "extension update required"), 1_000).unref();
  }

  private acceptPeer(ws: WebSocket, peerVersion: unknown, welcome: object) {
    this.peers.add(ws);
    ws.send(
      JSON.stringify({ type: "peer-welcome", serverVersion: this.serverVersion, extension: this.extension ?? null, extensions: this.extensions, ...welcome }),
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
    const end = Date.now() + this.opts.stepDownMaxWaitMs;
    while (this.pending.size && Date.now() < end && !this.closed) await new Promise((r) => setTimeout(r, 500));
    if (this.closed || this.role !== "hub") return void (this.steppingDown = false);
    console.error(`[mcp-teams ${this.serverVersion}] handing the bridge to mcp-teams ${newer}`);
    this.restartHub("mcp-teams was updated; try again in a few seconds.", this.opts.retryMs);
    this.steppingDown = false;
  }

  /** Hub: closes the server and every connection, then becomes a hub or peer again. */
  private restartHub(reason: string, delayMs = 100 + Math.random() * 400) {
    const wss = this.wss;
    this.wss = undefined;
    this.boundPort = undefined;
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

  /** Runs a peer's call against the extension and sends back the outcome; {type:"cancel", id} withdraws it. */
  private onPeerMessage(ws: WebSocket, msg: any) {
    if (msg.type === "cancel" && typeof msg.id === "string") return void this.peerCalls.get(ws)?.get(msg.id)?.abort();
    if (msg.type !== "request" || typeof msg.id !== "string") return;
    const reply = (body: object) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: msg.id, ...body }));
      } catch (err) {
        console.error(`[mcp-teams] could not answer a peer: ${(err as Error).message}`);
      }
    };
    let calls = this.peerCalls.get(ws);
    if (!calls) this.peerCalls.set(ws, (calls = new Map()));
    const ac = new AbortController();
    calls.set(msg.id, ac);
    // The peer's deadline stays the call's deadline: the extension must not go on after the peer gave up.
    this.call(String(msg.method), msg.params ?? {}, Number(msg.timeoutMs) || undefined, ac.signal, Number(msg.deadline) || undefined)
      .then(
        (result) => reply({ ok: true, result }),
        (err: Error) => reply({ ok: false, error: err.message }),
      )
      .finally(() => calls.delete(msg.id));
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
    }, this.opts.keepAliveMs);
    this.keepAlive.unref();
  }

  // ------------------------------------------------------------------ peer

  private join(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: this.maxMessageBytes });
      let joined = false;
      let challenged = false;
      let forged = false;
      const nonce = newNonce();
      const timer = setTimeout(() => ws.terminate(), this.opts.joinTimeoutMs);
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "challenge" && !challenged && typeof msg.nonce === "string") {
          challenged = true;
          ws.send(JSON.stringify({ type: "peer-hello", proof: proof(this.token, "client", msg.nonce), nonce, version: this.serverVersion }));
        } else if (msg.type === "peer-welcome" && !joined) {
          // Only the real hub can answer our nonce; never forward calls to anything else.
          if (!challenged || !sameProof(msg.proof, proof(this.token, "server", nonce))) {
            forged = true;
            return void ws.terminate();
          }
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
              : forged || !challenged
                ? `Port ${this.port} is held by an mcp-teams of 0.2.0 or older (restart the other AI sessions, in Claude Code with /mcp) or by another program.`
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

  /**
   * Calls the extension. Aborting `signal` withdraws the call (see withdraw). `deadline` (ms since
   * 1970) ends it earlier than timeoutMs, for a call relayed from a peer.
   */
  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 60_000, signal?: AbortSignal, deadline?: number): Promise<T> {
    if (method === "reloadAll" && this.role === "hub") return this.reloadAll(timeoutMs) as Promise<T>;
    const target = this.role === "hub" ? await this.pickExtension() : this.role === "peer" ? this.hub : undefined;
    if (!this.connected || !target) {
      const reason =
        this.role === "none"
          ? (this.listenError ?? "Connecting to the mcp-teams bridge; try again in a few seconds.")
          : "Browser extension is not connected. Open Chrome or Edge with the mcp-teams extension installed (run `mcp-teams setup`).";
      throw new Error(reason);
    }
    const result = await this.send<T>(target, method, params, timeoutMs, signal, deadline);
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
  private send<T>(target: WebSocket, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, until?: number): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    const id = randomUUID();
    // Taken before the timer starts, so the timer never fires before this deadline.
    const now = Date.now();
    const deadline = Math.min(now + timeoutMs, until ?? Infinity);
    // A peer waits a little longer than the hub, so the hub's own timeout message wins.
    const wait = Math.max(0, deadline - now) + (this.role === "peer" ? 5_000 : 0);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.withdraw(id, target, cancelledError());
      const done = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => this.withdraw(id, target, new Error(`Extension call '${method}' timed out`)), wait);
      this.pending.set(id, {
        resolve: (v) => (done(), resolve(v as T)),
        reject: (e) => (done(), reject(e)),
        timer,
        grace: method === "requestSend",
        socket: this.role === "hub" ? target : undefined,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      // deadline: when this side stops waiting (same machine, same clock), so the extension
      // sends nothing to Teams after it, however long the request took to arrive.
      target.send(JSON.stringify({ type: "request", id, method, params, timeoutMs, deadline }));
    });
  }

  /**
   * Withdraws a call nobody waits for any more (timed out or cancelled): tells the other side
   * to drop it with {type:"cancel", id} (sides that don't know it ignore it). A send's answer
   * still counts for cancelGraceMs. So a send the user already clicked reports its real
   * outcome, and a confirmation window that closed reports "nothing was sent". Without an
   * answer by then, the call fails with `err`.
   */
  private withdraw(id: string, target: WebSocket, err: Error) {
    const p = this.pending.get(id);
    if (!p || p.withdrawn) return;
    p.withdrawn = true;
    clearTimeout(p.timer);
    const fail = () => {
      if (this.pending.get(id) !== p) return;
      this.pending.delete(id);
      p.reject(err);
    };
    if (target.readyState !== WebSocket.OPEN) return fail();
    try {
      target.send(JSON.stringify({ type: "cancel", id }));
    } catch {
      return fail();
    }
    if (!p.grace) return fail();
    p.timer = setTimeout(fail, this.opts.cancelGraceMs);
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
