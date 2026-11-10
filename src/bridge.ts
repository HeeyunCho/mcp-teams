import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { EXTENSION_ORIGIN as TRUSTED_EXTENSION_ORIGIN } from "./extension.js";
import { FairQueue } from "./fairqueue.js";
import { errorFields, logVersion } from "./hubLog.js";

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
 *
 * On the native host's hub socket (#123) the proofs carry their own labels, "client:socket" and
 * "server:socket", so a proof made on the TCP port never counts there. Otherwise a program holding
 * the port could pass the pipe's challenge to a server (or the native host) joining what it takes
 * for a hub on the port, and hand the answer to the pipe.
 */

/** Which proof: by whom, and on the hub socket (":socket") or the TCP port. */
export type ProofRole = "client" | "server" | "client:socket" | "server:socket";

/** HMAC-SHA256 of `${role}:${nonce}` with the pairing token, base64url. The extension computes the same (teams.js) for the TCP port. */
export function proof(token: string, role: ProofRole, nonce: string): string {
  return createHmac("sha256", token).update(`${role}:${nonce}`).digest("base64url");
}

/** The proof role for `side` on a connection of kind `via`: its socket label on the hub socket. */
function proofRole(side: "client" | "server", via: Via): ProofRole {
  return via === "socket" ? `${side}:socket` : side;
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
  /** What it declared in hello (#115); no features for an extension from before #115. Hubs before #115 send none to peers. */
  capabilities?: Capabilities;
}

/**
 * What one side of the bridge tells the other it can do (#115), in hello, peer-hello, welcome and
 * peer-welcome, so newer behaviour is only used with a side that declares it. Ported from
 * mcp-newoutlook src/bridge.ts (Capabilities, SERVER_FEATURES, featuresOf; commit 693e827).
 */
export interface Capabilities {
  /** Protocol features beyond the original request/response (see SERVER_FEATURES). */
  features: string[];
  /** The largest message this side accepts; null when it didn't say (a side from before #115). */
  maxMessageBytes: number | null;
}

/**
 * Protocol features this server supports, sent in welcome, peer-hello and peer-welcome.
 * - "checksSend": as the hub, it checks the browser it picks for a send (#22).
 * The native host adds "native" (NativeHostOptions.features, #123). Reserved, declared once it
 * ships (ADR 0001): "hostSwitch" (the hub can hand over to a newer build).
 */
export const SERVER_FEATURES: readonly string[] = Object.freeze(["checksSend"]);

/** The string features of a message's capabilities; none for a side too old to send them. */
const featuresOf = (msg: any): string[] =>
  Array.isArray(msg?.capabilities?.features) ? msg.capabilities.features.filter((f: unknown): f is string => typeof f === "string") : [];

/** What a hello or welcome declares; no features (and no known limit) for a side too old to send any. */
function capabilitiesOf(msg: any): Capabilities {
  const max = Number(msg?.capabilities?.maxMessageBytes);
  return { features: featuresOf(msg), maxMessageBytes: Number.isFinite(max) && max > 0 ? max : null };
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
  socket?: BridgeSocket;
  /** Hub: the turn a queued call holds, given back while it waits out a throttle. */
  turn?: Turn;
}

/** Hub: a queued call's turn on an extension. */
interface Turn {
  queue: FairQueue<BridgeSocket | null>;
  session: BridgeSocket | null;
  /** When the call stops waiting (its time limit or deadline). */
  end: number;
  held: boolean;
  /** While it waits for its turn back: leaves that line. */
  rejoin?: AbortController;
  /** The call is over: a turn handed to it now goes straight back. */
  done?: boolean;
}

const EXTENSION_ORIGIN = /^(chrome-extension|extension):\/\/[a-z0-9]+$/i;
/** Largest message accepted on the bridge. Attachments travel one per message as base64 (+33%). */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/** Sizes and timings of the bridge. Tests shorten them; the server uses the defaults. */
export interface BridgeTimings {
  /** Largest message accepted on the bridge. */
  maxMessageBytes?: number;
  /** How often the hub pings each extension (also keeps the MV3 service worker alive) and each peer. */
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
  /**
   * Hub: a peer with more than this waiting in its send buffer at two keep-alive ticks in a row
   * isn't reading its answers and is closed (1013); over 4x this, at once.
   */
  maxPeerBufferedBytes?: number;
  /**
   * Hub: calls that run at once on each extension; the rest wait their turn, shared fairly
   * between sessions (the hub's own calls are one session, each peer another; see FairQueue).
   */
  maxConcurrentCalls?: number;
  /** A server on TCP with a hubSocket: how often it checks the hub socket for the native host (watchHost). */
  hubPollMs?: number;
  /** The native host: how often it tries again to get the TCP port while another server holds it (#123 decision 7). */
  tcpRetryMs?: number;
}

/**
 * Where a bridge meets the native host (#123, ADR 0001). None of these set: TCP only, as before.
 * Ported from mcp-newoutlook src/bridge.ts BridgeOptions (listenPath, hubSocket, socketNeedsToken,
 * features, onExtensionsChange; commit eb9d32f).
 */
export interface NativeHostOptions {
  /**
   * A server whose config enables the native host: the host's hub socket. start() joins the host
   * there first, and otherwise runs the TCP logic as before; a server on TCP then checks the
   * socket every hubPollMs and moves to the host once the host has the extension (watchHost).
   */
  hubSocket?: string;
  /**
   * The native host (dist/hub.js): the hub on this hub socket (Unix socket path or Windows named
   * pipe), with the extension's native port attached (attachExtension). It also listens on the TCP
   * port, for peers only (ADR decision 4): servers from before the host know only the port. It
   * never joins another hub and never hands over to a newer server.
   */
  hostSocket?: string;
  /** Peers on the hub socket must prove the pairing token (default: on Windows, see socketNeedsProof in native.ts). */
  socketNeedsProof?: boolean;
  /** Protocol features declared besides SERVER_FEATURES (the host: "native"). */
  features?: string[];
  /** Called whenever the connected extensions change (the host's linger timer). */
  onExtensionsChange?: (extensions: ExtensionInfo[]) => void;
  /** Metadata about the hub's connections, for the host's hub.log: never message text. */
  onEvent?: (event: string, fields?: Record<string, string | number | undefined>) => void;
}

type Timings = Required<BridgeTimings>;

/** Sizes and timings, and where it meets the native host. */
export interface BridgeOptions extends BridgeTimings, NativeHostOptions {}

export const DEFAULT_BRIDGE_OPTIONS: Readonly<Timings> = Object.freeze({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  keepAliveMs: 20_000,
  retryMs: 2_000,
  joinTimeoutMs: 3_000,
  authTimeoutMs: 5_000,
  pickStatusTimeoutMs: 3_000,
  stepDownMaxWaitMs: 5 * 60_000,
  cancelGraceMs: 2_000,
  maxPeerBufferedBytes: 64 * 1024 * 1024,
  maxConcurrentCalls: 4,
  hubPollMs: 5_000,
  tcpRetryMs: 5_000,
});

/**
 * Calls that never wait for a turn: the connection's own (status, reload) answer at once, and a
 * send waits for the user's click (up to minutes), so it must not hold a turn others wait for.
 */
const UNQUEUED = new Set(["status", "reload", "reloadAll", "requestSend"]);
/** Calls the extension fails without a Teams tab open (requireTeamsTab in extension/background.js). */
const NEEDS_TEAMS_TAB = new Set(["listTeams", "listChats"]);

/** The oldest extension that closes a send's confirmation window on {type:"cancel"} (1.2). Sends need it. */
export const MIN_SEND_EXTENSION = "0.2.13";

/**
 * What a call fails with when it was never sent (it waited for a turn, or was refused before it
 * reached the extension): nothing reached Teams, so none of these is a lost call (isLostCall is
 * false for each).
 */
export const NOT_SENT = Object.freeze({
  cancelled: "Cancelled while it waited for its turn; it was not sent.",
  waitedOut: (running: number) =>
    `Busy: this call waited its whole time limit for a turn (${running} calls at once run on the Teams tab, shared between AI sessions) and was not sent; try again shortly.`,
  gone: "The connection to the browser extension closed before this call's turn came; it was not sent. Try again.",
  /**
   * A call that came while the hub drains before it closes (#112), or one a peer still had on its
   * way to a hub that said it had answered everything it accepted (its {type:"drained"} note).
   */
  hubClosing: "The mcp-teams hub is closing (the AI session that ran it ended); this call was not sent. Try again in a few seconds.",
  /** A send on an extension that can't close its confirmation window when the send is withdrawn. */
  extensionTooOld: (version: unknown) =>
    `Nothing was sent: the browser extension (${String(version)}) is older than ${MIN_SEND_EXTENSION} and can't close its confirmation window when the AI stops waiting, so a late click could still post. Update it with reload_extension (it loads the version mcp-teams put in its folder), or run \`npx mcp-teams setup\` if it was loaded from another folder, then send again.`,
});

/** True when an extension of `version` closes its confirmation window on a cancel (an unreadable version doesn't). */
export function closesSendWindow(version: unknown): boolean {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) && !isNewer(MIN_SEND_EXTENSION, version);
}

/** The version to name when a send is refused: of the extensions that can't close the window, the oldest (an unreadable one first). */
function oldestTooOld(extensions: ExtensionInfo[]): string {
  const tooOld = extensions.map((e) => e.version).filter((v) => !closesSendWindow(v));
  const unreadable = tooOld.find((v) => !/^\d+\.\d+\.\d+$/.test(v));
  return unreadable ?? tooOld.reduce<string | undefined>((a, v) => (a === undefined || isNewer(a, v) ? v : a), undefined) ?? "unknown";
}

/**
 * How long a hub whose AI session ended (its stdin closed) keeps serving the calls in flight before
 * it closes (#112). Ported from mcp-newoutlook src/bridge.ts DRAIN_MAX_WAIT_MS (PR #108 there, #68b).
 * The AI app may kill the process soon after, so this stays short, and is not made longer for a
 * send waiting for the user's click: that one is withdrawn at the end, as on any close.
 */
export const DRAIN_MAX_WAIT_MS = 5_000;

/** A peer's watchdog never waits less for its hub's ping: a busy machine runs timers late. */
const MIN_HUB_SILENCE_MS = 2_000;

/**
 * A liveness check (the hub's ticks, a peer's watchdog) that runs later than this fraction of
 * its own wait after it was due (a tick: one period; the watchdog: its whole wait) finds its
 * process stalled (a busy machine, a long GC or parse, a suspend).
 * Overdue timers run before the I/O that arrived meanwhile is read, so a verdict taken then
 * would blame the other side for a ping or pong waiting unread: the check skips its verdict.
 * At most once in a row, so on a loop that runs late all the time a frozen peer, extension or
 * hub is still dropped, at the second late check.
 */
const STALL_SLACK = 0.5;

/** Whether a check that waited `waitMs` and was due at `due` ran late (see STALL_SLACK). */
function ranLate(due: number, waitMs: number): boolean {
  return Date.now() - due > waitMs * STALL_SLACK;
}

/**
 * For a check every `periodMs` (setInterval): call the result at each tick; true when this
 * tick ran late and the one before didn't skip, so this one skips its verdicts.
 */
function lateTicks(periodMs: number): () => boolean {
  let lastTickAt = Date.now();
  let skipped = false;
  return () => {
    const due = lastTickAt + periodMs;
    lastTickAt = Date.now();
    skipped = !skipped && ranLate(due, periodMs);
    return skipped;
  };
}

/** Hub: a peer with more than this many times maxPeerBufferedBytes waiting is closed at once. */
const PEER_BUFFER_HARD_CAP = 4;

/**
 * What a call fails with when the bridge lost it after sending it, so its outcome is unknown (a
 * send may have been posted). A hub relays them to its peers word for word. src/tools.ts tells
 * the AI to check before sending again on exactly these (isLostCall), so add any new one here.
 */
export const LOST_CALL = Object.freeze({
  timedOut: (method: string) => `Extension call '${method}' timed out`,
  withdrawn: "Cancelled: the request was withdrawn.",
  disconnected: "Browser extension disconnected",
  reconnected: "Browser extension reconnected; try again.",
  hubRestarted: "The mcp-teams hub restarted; try again in a few seconds.",
  hubSilent: "The mcp-teams hub stopped responding; try again in a few seconds.",
  updated: "mcp-teams was updated; try again in a few seconds.",
  shuttingDown: "mcp-teams is shutting down",
  serverError: (detail: string) => `bridge server error: ${detail}`,
  socketError: (detail: string) => `Bridge connection error: ${detail}`,
  tooLarge: (limitMb: number) => `The response was too large (over ${limitMb} MB) and was dropped. The connection is re-established automatically.`,
});

// Each LOST_CALL message as a pattern: its text, with anything in the place of a value.
const SLOT = "\u0000";
const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOST_CALL_PATTERNS = Object.values(LOST_CALL).map((m) => {
  const text = typeof m === "string" ? m : (m as (value: string) => string)(SLOT);
  return new RegExp(`^${text.split(SLOT).map(escapeRegExp).join(".*")}`, "s");
});

/** True when `message` is one of LOST_CALL's: the call was sent, and its outcome is unknown. */
export function isLostCall(message: string): boolean {
  return LOST_CALL_PATTERNS.some((p) => p.test(message));
}

const cancelledError = () => new Error(LOST_CALL.withdrawn);

/** True when version a is newer than b (x.y.z; anything else never counts as newer). */
export function isNewer(a: unknown, b: unknown): boolean {
  const parse = (v: unknown) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// ------------------------------------------------------------------ transport

/**
 * One connection of the bridge: an extension or a peer (seen by the hub), or the hub (seen by a
 * peer). Shaped like a ws WebSocket, which is the only transport so far; a native-messaging port
 * or a hub socket (ADR 0001, #123) is wrapped to this shape. Ported from mcp-newoutlook
 * src/bridge.ts BridgeSocket (commit 7ef8ac9), without its binary sends (Teams has no binary path).
 *
 * Events, as the ws WebSocket emits them: "message" (one whole message: Buffer or string),
 * "close" (code), "error" (err; the connection closes afterwards), "ping" (the other side's
 * heartbeat, which a peer watches) and "pong" (the answer to ping()).
 */
export interface BridgeSocket {
  /** OPEN while messages can be sent. */
  readonly readyState: number;
  /** Bytes sent but not written out yet. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drops the connection at once. */
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

/** BridgeSocket.readyState of an open connection (as WebSocket.OPEN). */
export const OPEN = WebSocket.OPEN;

/**
 * Where a connection came from (#123): the TCP port, the native host's hub socket, or the
 * extension's native-messaging port. The hub decides on it who must prove the token, and that an
 * extension on the native host's TCP port is refused.
 */
export type Via = "tcp" | "socket" | "native";

/** Where a hub listens, once it listens. */
export interface BridgeListener {
  /** The TCP port it got (the free one, when asked for port 0); none for a listener without a port. */
  readonly port?: number;
  /** Stops listening; resolves once it has stopped. */
  close(): Promise<void>;
}

/** What a listener tells the hub. */
export interface ListenHandlers {
  /**
   * A new connection, not yet authenticated. `via`: the kind of listener that took it. `origin`:
   * the Origin it sent (none: a local process).
   */
  connection(conn: BridgeSocket, from: { via: Via; origin?: string }): void;
  /** The listener failed after it started listening. */
  error(err: Error): void;
}

/** How a bridge listens as the hub and connects as a peer. */
export interface BridgeTransport {
  /** "tcp": the WebSocket on the port; "socket": the native host's hub socket. */
  readonly kind: "tcp" | "socket";
  /** Starts listening. Rejects with the listen error, whose code is EADDRINUSE when another server holds the address. */
  listen(handlers: ListenHandlers): Promise<BridgeListener>;
  /** Connects to the hub listening there. */
  connect(): BridgeSocket;
}

/**
 * The bridge's WebSocket on 127.0.0.1:`port`. Only loopback, and never from a web page: browsers
 * always send an Origin header, so a connection must come from an extension origin or from a
 * local process (no Origin).
 */
export function webSocketTransport({ port, maxMessageBytes }: { port: number; maxMessageBytes: number }): BridgeTransport {
  return {
    kind: "tcp",
    listen: (handlers) =>
      new Promise((resolve, reject) => {
        const wss = new WebSocketServer({
          host: "127.0.0.1",
          port,
          maxPayload: maxMessageBytes,
          verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => !origin || EXTENSION_ORIGIN.test(origin),
        });
        let listening = false;
        wss.once("listening", () => {
          listening = true;
          resolve({
            port: (wss.address() as { port: number }).port,
            close: () => new Promise<void>((r) => wss.close(() => r())),
          });
        });
        wss.on("error", (err: NodeJS.ErrnoException) => {
          if (listening) return handlers.error(err);
          wss.close();
          reject(err);
        });
        wss.on("connection", (ws, req) => handlers.connection(ws, { via: "tcp", origin: req.headers.origin }));
      }),
    connect: () => new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: maxMessageBytes }),
  };
}

/** True when something accepts connections on a local socket path. */
function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (alive: boolean) => (s.destroy(), resolve(alive));
    s.setTimeout(1_000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * The native host's hub socket (#123): the same WebSocket protocol on a local socket, a Unix socket
 * file or a Windows named pipe. On macOS and Linux the socket is 0600 in a 0700 folder, and a
 * socket file that a crashed host left (nobody listens on it) is replaced. Only local processes
 * connect: any Origin header (a browser page) is refused. Ported from mcp-newoutlook src/bridge.ts
 * listenOnPath, socketAlive and join({ path }) (commit eb9d32f).
 */
export function socketTransport({ path, maxMessageBytes }: { path: string; maxMessageBytes: number }): BridgeTransport {
  const unix = process.platform !== "win32";
  const listen = (handlers: ListenHandlers, retried: boolean): Promise<BridgeListener> => {
    if (unix) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        chmodSync(dirname(path), 0o700);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      const server = createHttpServer((_req, res) => res.writeHead(426).end());
      const wss = new WebSocketServer({
        server,
        maxPayload: maxMessageBytes,
        verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => !origin,
      });
      let listening = false;
      server.once("listening", () => {
        listening = true;
        try {
          if (unix) chmodSync(path, 0o600);
        } catch {
          // gone again already; the folder is owner-only either way
        }
        const closeWss = () => new Promise<void>((r) => wss.close(() => r()));
        const closeServer = () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          });
        resolve({ close: () => closeWss().then(closeServer) });
      });
      server.on("error", async (err: NodeJS.ErrnoException) => {
        if (listening) return handlers.error(err);
        wss.close();
        server.close();
        if (err.code === "EADDRINUSE" && unix && !retried && !(await socketAlive(path))) {
          // A socket file nobody listens on (a host that crashed): take it over.
          try {
            unlinkSync(path);
          } catch {
            // another host was quicker
          }
          return listen(handlers, true).then(resolve, reject);
        }
        reject(err);
      });
      wss.on("error", () => {}); // the server's own errors come through `server`
      wss.on("connection", (ws, req) => handlers.connection(ws, { via: "socket", origin: req.headers.origin }));
      server.listen(path);
    });
  };
  return {
    kind: "socket",
    listen: (handlers) => listen(handlers, false),
    connect: () => new WebSocket("ws://localhost/", { maxPayload: maxMessageBytes, createConnection: () => connect(path) }),
  };
}

function describeSocketError(err: NodeJS.ErrnoException, limit: number): string {
  return err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? LOST_CALL.tooLarge(Math.round(limit / 1024 / 1024)) : LOST_CALL.socketError(err.message);
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
  /** Peer only: what that hub declared in peer-welcome (#115); no features for a hub from before #115. */
  hubCapabilities?: Capabilities;
  /**
   * Peer only: whether that hub checks the browser it picks for a send (#22); hubs before it don't.
   * Its "checksSend" feature, or the bare checksSend: true of hubs before #115.
   */
  hubChecksSend = false;

  /** Hub: where extensions and peers connect; the native host has its hub socket and its TCP listener (#123). */
  private listeners: BridgeListener[] = [];
  private tcpListener?: BridgeListener; // the native host: its TCP listener, for peers only
  private tcpRetry?: NodeJS.Timeout; // the native host: its next try for the TCP port
  private nudging?: BridgeSocket; // the native host: its connection to an older TCP hub, which hands over to it
  private hubOnSocket = false; // peer: the hub is the native host, reached on its hub socket
  private hostWatch?: NodeJS.Timeout; // a server on TCP with a hubSocket: checks it for the host
  private checkingHost = false;
  private sockets = new Map<BridgeSocket, ExtensionInfo>(); // hub: the extensions
  private preferred?: BridgeSocket; // hub: the extension that last answered a call
  private hub?: BridgeSocket; // peer: the hub
  private peers = new Set<BridgeSocket>();
  private peerCalls = new Map<BridgeSocket, Map<string, AbortController>>(); // hub: each peer's calls, by the peer's id
  /** Hub: per extension connection, its turns (keyed by session: null for the hub's own calls, else the peer) and who waits. */
  private turns = new Map<BridgeSocket, { queue: FairQueue<BridgeSocket | null>; waiting: Set<(err: Error) => void> }>();
  private pending = new Map<string, Pending>();
  private keepAlive?: NodeJS.Timeout;
  private peerBeat?: NodeJS.Timeout; // hub: pings the peers
  private retry?: NodeJS.Timeout;
  private closed = false;
  private steppingDown = false;
  /** Hub: its session ended and it drains before closing (#112); it starts no new call. */
  private draining = false;
  /** Hub: calls being run (from run() until they settle), the hub's own and its peers'. */
  private active = 0;
  private alive = new WeakSet<BridgeSocket>(); // hub: extensions and peers that answered the last ping
  private backlogged = new WeakSet<BridgeSocket>(); // hub: peers over maxPeerBufferedBytes at the last tick
  private legacyReloaded = false; // hub: an extension of 0.2.0 or older was told to reload
  private readonly opts: Timings;
  private readonly native: NativeHostOptions;
  private boundPort?: number; // the port it got when it first listened (port 0 picks a free one); kept for later takeovers

  /** The 4th argument is the options, or (as before) just the largest message size. */
  constructor(
    private readonly requestedPort: number,
    private readonly token: string,
    private readonly serverVersion: string,
    options: BridgeOptions | number = {},
  ) {
    const given: BridgeOptions = typeof options === "number" ? { maxMessageBytes: options } : options;
    const { hubSocket, hostSocket, socketNeedsProof, features, onExtensionsChange, onEvent, ...timings } = given;
    // A key given as undefined keeps its default (spreading it would overwrite the default).
    const defined = Object.fromEntries(Object.entries(timings).filter(([, v]) => v !== undefined));
    this.opts = { ...DEFAULT_BRIDGE_OPTIONS, ...defined };
    this.native = { hubSocket: hostSocket ? undefined : hubSocket, hostSocket, socketNeedsProof, features, onExtensionsChange, onEvent };
  }

  /** The native host (#123): the hub on its hub socket, never a peer. */
  private get isHost(): boolean {
    return !!this.native.hostSocket;
  }

  /** Peer only: true when the hub is the native host, reached on its hub socket; false for another session's TCP hub. */
  get hubIsHost(): boolean {
    return this.role === "peer" && this.hubOnSocket;
  }

  /**
   * The native host: takes the extension's native-messaging port as an extension connection.
   * Chrome only starts the host for the extension ids in its manifest's allowed_origins, and
   * dist/hub.js checks the origin it was given, so it is trusted as our extension (no proof).
   */
  attachExtension(conn: BridgeSocket) {
    this.onConnection(conn, { via: "native", origin: TRUSTED_EXTENSION_ORIGIN });
  }

  /**
   * The bridge's port: the one it was given, or with port 0 the free one it got when it first
   * listened. It keeps that port when it hands over, so its peers and a newer server find it.
   */
  get port(): number {
    return this.boundPort ?? this.requestedPort;
  }

  private get maxMessageBytes(): number {
    return this.opts.maxMessageBytes;
  }

  /** What this server tells extensions, peers and the hub it can do (#115). */
  get capabilities(): Capabilities {
    const extra = (this.native.features ?? []).filter((f) => !SERVER_FEATURES.includes(f));
    return { features: [...SERVER_FEATURES, ...extra], maxMessageBytes: this.maxMessageBytes };
  }

  /** Read-only, for tests: calls waiting for an answer, and (hub) peers' calls being run. */
  get inFlight(): { pending: number; peerCalls: number } {
    let peerCalls = 0;
    for (const calls of this.peerCalls.values()) peerCalls += calls.size;
    return { pending: this.pending.size, peerCalls };
  }

  /** Read-only, for tests: hub calls waiting for a turn on an extension (not sent yet). */
  get queued(): number {
    let n = 0;
    for (const t of this.turns.values()) n += t.queue.waiting;
    return n;
  }

  /** Hub: anything accepted and not answered yet: calls being run, sent, or waiting for a turn. */
  private get busy(): boolean {
    const { pending, peerCalls } = this.inFlight;
    return !!(this.active || pending || peerCalls || this.queued);
  }

  /** Becomes the hub, or a peer of the existing hub. Keeps retrying in the background if neither works. */
  async start(): Promise<void> {
    if (this.closed) return;
    const socket = this.socketTransport;
    if (this.isHost) {
      // The native host: the hub on its socket, or nothing (dist/hub.js then relays to the host there).
      if (await this.listen(socket!)) {
        this.setRole("hub");
        this.native.onEvent?.("host", { socket: "listening" });
        return void this.holdTcp();
      }
      this.role = "none";
      return;
    }
    // The native host serves the extension: join it (#123). Otherwise TCP, as before.
    if (socket && (await this.join(socket))) return this.setRole("peer");
    if (await this.listen(this.tcpTransport)) return (this.setRole("hub"), this.watchHost());
    if (await this.join(this.tcpTransport)) return (this.setRole("peer"), this.watchHost());
    this.role = "none";
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), this.opts.retryMs);
    this.retry.unref();
  }

  get connected(): boolean {
    if (this.role === "hub") return [...this.sockets.keys()].some((s) => s.readyState === OPEN);
    if (this.role === "peer") return this.hub?.readyState === OPEN && !!this.extension;
    return false;
  }

  private setRole(role: BridgeRole) {
    this.role = role;
    this.listenError = undefined;
  }

  // ------------------------------------------------------------------ hub

  /** The WebSocket on its port. */
  private get tcpTransport(): BridgeTransport {
    return webSocketTransport({ port: this.port, maxMessageBytes: this.maxMessageBytes });
  }

  /** The native host's hub socket (#123): where the host listens, or where a server looks for it. */
  private get socketTransport(): BridgeTransport | undefined {
    const path = this.native.hostSocket ?? this.native.hubSocket;
    return path ? socketTransport({ path, maxMessageBytes: this.maxMessageBytes }) : undefined;
  }

  /** Peers on the hub socket must prove the token only where the socket isn't owner-only (a Windows pipe). */
  private get socketNeedsProof(): boolean {
    return this.native.socketNeedsProof ?? process.platform === "win32";
  }

  /** Listens on `transport` as the hub; false when the address is taken (or failed: listenError). */
  private listen(transport: BridgeTransport): Promise<boolean> {
    return this.listenOn(transport, (err) => this.restartHub(LOST_CALL.serverError(err.message))).then(
      (listener) => !!listener,
      (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") this.listenError = err.message;
        return false;
      },
    );
  }

  private async listenOn(transport: BridgeTransport, onError: (err: Error) => void): Promise<BridgeListener> {
    const listener = await transport.listen({
      connection: (conn, from) => this.onConnection(conn, from),
      error: onError,
    });
    this.listeners.push(listener);
    if (transport.kind === "tcp") this.boundPort = listener.port ?? this.boundPort;
    return listener;
  }

  /**
   * The native host: listens on the TCP port too, for peers only (ADR decision 4). While another
   * server holds the port it tries again every tcpRetryMs (#123 decision 7). A TCP hub older than
   * this host is joined as a newer peer, so its stepDown hands the port over (decision 8); one as
   * new or newer moves to the host itself once the host has the extension (watchHost).
   */
  private async holdTcp() {
    clearTimeout(this.tcpRetry);
    if (this.closed || this.role !== "hub" || this.tcpListener) return;
    let again = this.opts.tcpRetryMs;
    try {
      const listener = await this.listenOn(this.tcpTransport, (err) => {
        // The TCP listener failed: the host stays the hub on its socket and listens again later.
        this.native.onEvent?.("tcp", { error: errorFields(err).name, code: errorFields(err).code });
        this.listeners = this.listeners.filter((l) => l !== listener);
        if (this.tcpListener === listener) this.tcpListener = undefined;
        void listener.close();
        this.scheduleTcp(this.opts.tcpRetryMs);
      });
      if (this.closed || this.role !== "hub") return void this.closeListener(listener);
      this.tcpListener = listener;
      this.native.onEvent?.("tcp", { port: listener.port });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && (await this.nudgeTcpHub())) again = 20;
    }
    this.scheduleTcp(again);
  }

  private scheduleTcp(ms: number) {
    if (this.closed || this.role !== "hub") return;
    clearTimeout(this.tcpRetry);
    this.tcpRetry = setTimeout(() => void this.holdTcp(), ms);
    this.tcpRetry.unref();
  }

  private closeListener(listener: BridgeListener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
    return listener.close();
  }

  /**
   * The native host: joins the TCP hub on the port as a peer of its own version. A hub older than
   * that hands over to it (its existing stepDown(), #123 decision 8); this waits until that hub has
   * closed and resolves true, so the port is tried again at once. Any other answer (a hub as new or
   * newer, another program, no answer) resolves false: try again later.
   */
  private nudgeTcpHub(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = this.tcpTransport.connect();
      this.nudging = ws;
      const nonce = newNonce();
      let challenged = false;
      let older = false;
      const timer = setTimeout(() => ws.terminate(), this.opts.joinTimeoutMs);
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg?.type === "challenge" && !challenged && typeof msg.nonce === "string") {
          challenged = true;
          ws.send(JSON.stringify({ type: "peer-hello", proof: proof(this.token, "client", msg.nonce), nonce, version: this.serverVersion, capabilities: this.capabilities }));
        } else if (msg?.type === "peer-welcome" && !older) {
          clearTimeout(timer);
          if (!challenged || !sameProof(msg.proof, proof(this.token, "server", nonce)) || !isNewer(this.serverVersion, msg.serverVersion)) return void ws.close(1000, "not now");
          // It hands over once its own calls are done; until then this stays its (idle) peer.
          older = true;
          this.native.onEvent?.("tcp", { handover: logVersion(msg.serverVersion) });
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearTimeout(timer);
        if (this.nudging === ws) this.nudging = undefined;
        resolve(older);
      });
    });
  }

  private onConnection(ws: BridgeSocket, { via, origin }: { via: Via; origin?: string }) {
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
        // The native host takes extensions only on native messaging (or relayed on its socket): on
        // its TCP port it serves peers only (ADR decision 4, #123 decision 9).
        if (via === "tcp" && this.isHost && msg.type === "hello") {
          this.native.onEvent?.("refused", { reason: "extension on the TCP port" });
          return void ws.close(4403, "extensions connect to the native host by native messaging");
        }
        if (via === "native" && msg.type !== "hello") return void ws.close(4401, "bad token");
        // Clients up to 0.2.0 send the token itself (peers, or an extension paired by hand).
        // Only on TCP: the bare token, and a proof without the socket label (see ProofRole).
        const proven =
          sameProof(msg.proof, proof(this.token, proofRole("client", via), challenge)) || (via === "tcp" && typeof msg.token === "string" && msg.token === this.token);
        // The native port is our extension (Chrome checked it); the hub socket is owner-only except on Windows.
        const trusted = via === "native" || (via === "socket" && !this.socketNeedsProof);
        if (!proven && !trusted) {
          // Our extension up to 0.2.0 says hello with neither; it is only told to reload.
          if (via === "tcp" && msg.type === "hello" && origin === TRUSTED_EXTENSION_ORIGIN && msg.token == null && msg.proof == null) return this.reloadLegacy(ws);
          return void ws.close(4401, "bad token");
        }
        authed = true;
        clearTimeout(authTimer);
        const welcome = typeof msg.nonce === "string" ? { proof: proof(this.token, proofRole("server", via), msg.nonce) } : {};
        // A hello on the hub socket is another browser's host relaying its extension, which that
        // host checked: ours, on native messaging.
        if (msg.type === "hello") this.acceptExtension(ws, msg, welcome, via === "tcp" ? origin : TRUSTED_EXTENSION_ORIGIN);
        else this.acceptPeer(ws, msg.version, welcome, via);
        return;
      }
      if (this.sockets.has(ws)) this.onExtensionMessage(ws, msg);
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
        this.dropTurns(ws);
        this.rejectAll(LOST_CALL.disconnected, ws);
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
  private acceptExtension(ws: BridgeSocket, msg: any, welcome: object, origin?: string) {
    const info: ExtensionInfo = {
      version: String(msg.version ?? "unknown"),
      browser: msg.browser,
      ...(origin ? { origin } : {}),
      ...(typeof msg.instance === "string" ? { instance: msg.instance } : {}),
      capabilities: capabilitiesOf(msg),
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
          if (p.socket !== s || s.readyState !== OPEN) continue;
          try {
            s.send(JSON.stringify({ type: "cancel", id }));
          } catch {
            // closing anyway
          }
        }
        s.close(4000, "replaced");
        // Its close event comes later and no longer finds it, so fail its calls now.
        this.sockets.delete(s);
        this.dropTurns(s);
        this.rejectAll(LOST_CALL.reconnected, s);
        if (this.preferred === s) this.preferred = undefined;
      }
    }
    this.sockets.set(ws, info);
    // heartbeatMs: this hub sends {type:"ping"} that often; the extension reconnects when they stop.
    ws.send(
      JSON.stringify({ type: "welcome", serverVersion: this.serverVersion, heartbeatMs: this.opts.keepAliveMs, capabilities: this.capabilities, ...welcome }),
    );
    this.startKeepAlive(ws);
    this.updateExtensions();
  }

  /** Refreshes `extension`/`extensions` after a change and tells the peers. */
  private updateExtensions() {
    this.extensions = [...this.sockets.values()];
    this.extension = (this.preferred && this.sockets.get(this.preferred)) ?? this.extensions.at(-1);
    this.broadcastState();
    this.native.onExtensionsChange?.(this.extensions);
  }

  /**
   * The extension a call goes to: the only one, the one that answered last, or else the
   * one whose browser has Teams signed in (then: has a Teams tab, then: newest).
   *
   * list_teams and list_chats fail in a browser without a Teams tab, so with several browsers
   * they go to one with a tab first: the one that answered last if it still has one, else the
   * best of those that do. The tab count is asked for each such call, never remembered: a tab
   * closed since the last call counts at once. A browser that doesn't answer counts as none.
   * Every browser is asked at once, so one that doesn't answer delays the call by one status
   * wait (pickStatusTimeoutMs) at most.
   */
  private async pickExtension(method: string): Promise<BridgeSocket | undefined> {
    const open = [...this.sockets.keys()].filter((s) => s.readyState === OPEN);
    if (open.length <= 1) return open[0];
    type Status = { teamsTabs?: number; sessions?: { sessionCaptured?: boolean }[] };
    const status = (s: BridgeSocket) => this.send<Status>(s, "status", {}, this.opts.pickStatusTimeoutMs).catch(() => null);
    const hasTab = (st: Status | null) => (st?.teamsTabs ?? 0) > 0;
    const needsTab = NEEDS_TEAMS_TAB.has(method);
    const preferred = this.preferred && open.includes(this.preferred) ? this.preferred : undefined;
    if (preferred && !needsTab) return preferred;
    // All at once, so a browser that doesn't answer costs one status wait, not one per browser.
    const asked = open.map(status);
    if (preferred && hasTab(await asked[open.indexOf(preferred)])) return preferred;
    const statuses = await Promise.all(asked);
    if (needsTab && preferred && !statuses.some(hasTab)) return preferred; // no tab anywhere: as before
    const score = (st: Status | null) =>
      (needsTab && hasTab(st) ? 3 : 0) +
      (!st ? -1 : st.sessions?.some((x) => x.sessionCaptured) ? 2 : (st.teamsTabs ?? 0) > 0 ? 1 : 0);
    let best = open.length - 1; // newest first among equals
    for (let i = open.length - 1; i >= 0; i--) if (score(statuses[i]) > score(statuses[best])) best = i;
    return open[best];
  }

  /**
   * Our extension up to 0.2.0 can't prove it knows the token, and anything can claim its
   * origin, so it gets no calls. It is asked once to reload, which loads the update this
   * server put in its folder, and the new version connects with a proof.
   */
  private reloadLegacy(ws: BridgeSocket) {
    if (!this.legacyReloaded) {
      this.legacyReloaded = true;
      ws.send(JSON.stringify({ type: "request", id: randomUUID(), method: "reload", params: {}, timeoutMs: 10_000 }));
    }
    setTimeout(() => ws.close(4426, "extension update required"), 1_000).unref();
  }

  private acceptPeer(ws: BridgeSocket, peerVersion: unknown, welcome: object, via: Via) {
    this.peers.add(ws);
    this.native.onEvent?.("peer", { version: logVersion(peerVersion), via });
    ws.on("close", () => this.native.onEvent?.("peer-left", { via }));
    // heartbeatMs: this hub pings the peer that often, so the peer can tell when it stops.
    ws.send(
      JSON.stringify({
        type: "peer-welcome",
        serverVersion: this.serverVersion,
        extension: this.extension ?? null,
        extensions: this.extensions,
        heartbeatMs: this.opts.keepAliveMs,
        capabilities: this.capabilities,
        // Peers from before #115 read this instead of the "checksSend" feature.
        checksSend: true,
        ...welcome,
      }),
    );
    this.startPeerBeat(ws);
    // A newer server joined: hand the port to it, so its fixes (and what the newer
    // extension expects) take effect without restarting this AI session.
    // The native host stays the hub: Chrome connects the extension to it, not to a server.
    if (!this.isHost && isNewer(peerVersion, this.serverVersion)) void this.stepDown(String(peerVersion));
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
    while ((this.pending.size || this.queued) && Date.now() < end && !this.closed) await new Promise((r) => setTimeout(r, 500));
    if (this.closed || this.role !== "hub") return void (this.steppingDown = false);
    console.error(`[mcp-teams ${this.serverVersion}] handing the bridge to mcp-teams ${newer}`);
    this.restartHub(LOST_CALL.updated, this.opts.retryMs);
    this.steppingDown = false;
  }

  /** Hub: closes the server and every connection, then becomes a hub or peer again. */
  private restartHub(reason: string, delayMs = 100 + Math.random() * 400) {
    this.stopServing(reason);
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), delayMs);
    this.retry.unref();
  }

  /** Hub: closes its listeners and every connection; their calls fail with `reason`. */
  private stopServing(reason: string) {
    const listeners = this.listeners;
    this.listeners = [];
    this.tcpListener = undefined;
    clearTimeout(this.tcpRetry);
    this.role = "none";
    clearInterval(this.keepAlive);
    this.stopPeerBeat();
    this.dropTurns();
    this.rejectAll(reason);
    for (const s of this.sockets.keys()) s.close(1012, "restarting");
    for (const peer of this.peers) peer.close(1012, "restarting");
    this.sockets.clear();
    this.peers.clear();
    this.preferred = undefined;
    this.extension = undefined;
    this.extensions = [];
    this.native.onExtensionsChange?.(this.extensions);
    for (const l of listeners) void l.close();
  }

  private onExtensionMessage(ws: BridgeSocket, msg: any) {
    if (typeof msg.id !== "string") return;
    if (msg.type === "response") return this.settle(msg);
    // A queued call waiting out a throttle (35): {type:"gate-wait"} gives its turn back to the
    // others, {type:"gate-open"} asks for one again, and {type:"turn"} says it may go on.
    const p = this.pending.get(msg.id);
    const turn = p?.socket === ws ? p.turn : undefined;
    if (!turn || turn.done) return;
    if (msg.type === "gate-wait" && turn.held) {
      turn.held = false;
      turn.queue.release(turn.session);
    } else if (msg.type === "gate-open" && !turn.held && !turn.rejoin) {
      const rejoin = (turn.rejoin = new AbortController());
      // Not given in time: the call's own timer withdraws it (it may have sent requests already).
      this.takeTurn(ws, turn.session, turn.end, rejoin.signal).then(
        () => {
          turn.rejoin = undefined;
          if (turn.done) return turn.queue.release(turn.session);
          turn.held = true;
          if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "turn", id: msg.id }));
        },
        () => (turn.rejoin = undefined),
      );
    }
  }

  /** Runs a peer's call against the extension and sends back the outcome; {type:"cancel", id} withdraws it. */
  private onPeerMessage(ws: BridgeSocket, msg: any) {
    if (msg.type === "cancel" && typeof msg.id === "string") return void this.peerCalls.get(ws)?.get(msg.id)?.abort();
    if (msg.type !== "request" || typeof msg.id !== "string") return;
    const reply = (body: object) => {
      try {
        this.sendToPeer(ws, JSON.stringify({ type: "response", id: msg.id, ...body }));
      } catch (err) {
        console.error(`[mcp-teams] could not answer a peer: ${(err as Error).message}`);
      }
    };
    // Draining (#112): never run, so the peer may say it was not sent.
    if (this.draining) return reply({ ok: false, error: NOT_SENT.hubClosing });
    let calls = this.peerCalls.get(ws);
    if (!calls) this.peerCalls.set(ws, (calls = new Map()));
    const ac = new AbortController();
    calls.set(msg.id, ac);
    // The peer's deadline stays the call's deadline: the extension must not go on after the peer gave up.
    this.run(ws, String(msg.method), msg.params ?? {}, Number(msg.timeoutMs) || undefined, ac.signal, Number(msg.deadline) || undefined)
      .then(
        (result) => reply({ ok: true, result }),
        (err: Error) => reply({ ok: false, error: err.message }),
      )
      .finally(() => calls.delete(msg.id));
  }

  private broadcastState() {
    const state = JSON.stringify({ type: "ext-state", extension: this.extension ?? null, extensions: this.extensions });
    for (const peer of this.peers) this.sendToPeer(peer, state);
  }

  /**
   * Hub: sends to a peer that is open and keeping up. One with over 4x maxPeerBufferedBytes
   * waiting is closed instead; a smaller backlog only when it lasts (see startPeerBeat), so a
   * burst of large answers doesn't drop a healthy peer.
   */
  private sendToPeer(ws: BridgeSocket, text: string) {
    if (ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > this.opts.maxPeerBufferedBytes * PEER_BUFFER_HARD_CAP) return this.closeSlowPeer(ws);
    ws.send(text);
  }

  /** Hub: closes a peer that isn't reading its answers (1013); its calls are withdrawn and it connects again. */
  private closeSlowPeer(ws: BridgeSocket) {
    console.error(`[mcp-teams] closing a peer that doesn't read its answers (${Math.round(ws.bufferedAmount / 1024 / 1024)} MB waiting)`);
    this.peers.delete(ws);
    // Its close may wait for the backlog; its calls are withdrawn now (as on close).
    for (const ac of this.peerCalls.get(ws)?.values() ?? []) ac.abort();
    this.peerCalls.delete(ws);
    ws.close(1013, "too slow");
  }

  /**
   * Pings keep the MV3 service worker alive while connected. A connection that didn't
   * answer the previous WebSocket ping (a suspended or crashed browser) is dropped.
   */
  private startKeepAlive(ws?: BridgeSocket) {
    if (ws) {
      this.alive.add(ws);
      ws.on("pong", () => this.alive.add(ws));
    }
    clearInterval(this.keepAlive);
    const late = lateTicks(this.opts.keepAliveMs);
    this.keepAlive = setInterval(() => {
      // After a stall a pong may wait unread: no drops at this tick (see STALL_SLACK).
      const stalled = late();
      for (const s of this.sockets.keys()) {
        if (s.readyState !== OPEN) continue;
        if (!stalled && !this.alive.has(s)) {
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

  /**
   * Hub: pings each peer every keepAliveMs; one that didn't answer the previous ping (a
   * suspended or hung session) is dropped, within 2 periods. The peers in turn drop a hub
   * that stops pinging them (see join). A peer over maxPeerBufferedBytes at this tick and the
   * previous one isn't draining its answers and is closed (1013).
   */
  private startPeerBeat(ws: BridgeSocket) {
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    if (this.peerBeat) return;
    const late = lateTicks(this.opts.keepAliveMs);
    this.peerBeat = setInterval(() => {
      if (!this.peers.size) return this.stopPeerBeat();
      const stalled = late();
      for (const p of this.peers) {
        if (p.readyState !== OPEN) continue;
        if (stalled) {
          // This hub stalled: a pong may wait unread, and its own writes didn't drain. Judge
          // nothing at this tick (see STALL_SLACK), and leave the backlog as the last tick saw
          // it; ping, and let the next tick decide.
          this.alive.delete(p);
          p.ping();
          continue;
        }
        const backlog = p.bufferedAmount > this.opts.maxPeerBufferedBytes;
        if (backlog && this.backlogged.has(p)) {
          this.closeSlowPeer(p);
          continue;
        }
        if (backlog) this.backlogged.add(p);
        else this.backlogged.delete(p);
        // With a backlog, the last ping may still wait behind the data, so a missing pong says
        // nothing: the next tick closes the peer if the backlog lasts. It is still pinged (the
        // ping queues behind the data), so a peer that drains it in time hears from its hub.
        if (!backlog && !this.alive.has(p)) {
          p.terminate();
          continue;
        }
        this.alive.delete(p);
        p.ping();
      }
    }, this.opts.keepAliveMs);
    this.peerBeat.unref();
  }

  private stopPeerBeat() {
    clearInterval(this.peerBeat);
    this.peerBeat = undefined;
  }

  // ------------------------------------------------------------------ peer

  /**
   * Joins the hub on `transport` as a peer: the TCP hub, or the native host on its hub socket.
   * adopt (a server on TCP checking for the host): decides on the peer-welcome whether to stay; when
   * it says yes, this server first leaves the TCP bridge (leaveTcp). Ported from mcp-newoutlook
   * src/bridge.ts join(target, adopt) (commit eb9d32f).
   */
  private join(transport: BridgeTransport, adopt?: (welcome: any) => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = transport.connect();
      const onSocket = transport.kind === "socket";
      let discarded = false;
      let joined = false;
      let challenged = false;
      let forged = false;
      const nonce = newNonce();
      const timer = setTimeout(() => ws.terminate(), this.opts.joinTimeoutMs);
      // A hub that declares heartbeatMs pings that often. When its pings stop for 2 periods, never
      // under 2 s (a busy machine runs timers late), the hub is suspended or hung: its calls fail
      // now and the takeover path runs, instead of them hanging until they time out. Hubs of
      // 0.2.13 and older never ping peers: no watchdog.
      let watchdog: NodeJS.Timeout | undefined;
      let heartbeatMs = 0;
      // The hub said it answered every call it accepted and runs no more (#112): whatever is still
      // pending here when it closes never ran, so it fails as not sent rather than as a lost call.
      let drained = false;
      // When the watchdog itself runs late, this peer stalled: the hub's ping may wait unread, so
      // it waits once more instead, but not twice in a row (see STALL_SLACK).
      const watch = (afterLate = false) => {
        clearTimeout(watchdog);
        const waitMs = Math.max(MIN_HUB_SILENCE_MS, 2 * heartbeatMs);
        const due = Date.now() + waitMs;
        watchdog = setTimeout(() => {
          if (this.hub !== ws) return;
          if (!afterLate && ranLate(due, waitMs)) return watch(true);
          this.rejectAll(LOST_CALL.hubSilent);
          ws.terminate();
        }, waitMs);
        watchdog.unref();
      };
      ws.on("ping", () => heartbeatMs && watch());
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
          ws.send(
            JSON.stringify({ type: "peer-hello", proof: proof(this.token, proofRole("client", transport.kind), msg.nonce), nonce, version: this.serverVersion, capabilities: this.capabilities }),
          );
        } else if (msg.type === "peer-welcome" && !joined && !discarded) {
          // Only the real hub can answer our nonce; never forward calls to anything else.
          if (!challenged || !sameProof(msg.proof, proof(this.token, proofRole("server", transport.kind), nonce))) {
            forged = true;
            return void ws.terminate();
          }
          if (adopt && (this.closed || !adopt(msg))) {
            discarded = true;
            clearTimeout(timer);
            ws.close(1000, "not now");
            return resolve(false);
          }
          if (adopt) this.leaveTcp();
          joined = true;
          clearTimeout(timer);
          this.hub = ws;
          this.hubOnSocket = onSocket;
          if (adopt) this.setRole("peer");
          this.hubVersion = String(msg.serverVersion ?? "unknown");
          this.hubCapabilities = capabilitiesOf(msg);
          this.hubChecksSend = this.hubCapabilities.features.includes("checksSend") || msg.checksSend === true;
          this.extension = msg.extension ?? undefined;
          this.extensions = msg.extensions ?? (msg.extension ? [msg.extension] : []);
          heartbeatMs = Number(msg.heartbeatMs) > 0 ? Number(msg.heartbeatMs) : 0;
          if (heartbeatMs) watch();
          resolve(true);
        } else if (msg.type === "drained" && joined && this.hub === ws) {
          drained = true;
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
        clearTimeout(watchdog);
        if (discarded) return;
        if (!joined) {
          if (onSocket) {
            // No native host there (or not ours): the TCP logic runs next. Only a refused proof is worth saying.
            if (code === 4401) this.listenError = "The mcp-teams native host on the hub socket rejected this server's token (run `npx mcp-teams setup` again).";
            return resolve(false);
          }
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
        this.hubOnSocket = false;
        this.hubVersion = undefined;
        this.hubCapabilities = undefined;
        this.hubChecksSend = false;
        this.extension = undefined;
        this.extensions = [];
        this.role = "none";
        this.rejectAll(drained ? NOT_SENT.hubClosing : LOST_CALL.hubRestarted);
        if (!this.closed) {
          clearTimeout(this.retry);
          this.retry = setTimeout(() => void this.start(), 100 + Math.random() * 400);
          this.retry.unref();
        }
      });
    });
  }

  /**
   * A server on TCP whose config enables the native host (#123 decision 7): checks the hub socket
   * every hubPollMs. When the host serves the extension there and this server's TCP bridge has none,
   * it moves to the host. Ported from mcp-newoutlook src/bridge.ts watchHost (commit eb9d32f).
   */
  private watchHost() {
    if (!this.native.hubSocket || this.hostWatch) return;
    this.hostWatch = setInterval(() => void this.checkHost(), this.opts.hubPollMs);
    this.hostWatch.unref();
  }

  private async checkHost() {
    const socket = this.socketTransport;
    const onTcp = () => !this.closed && !this.hubOnSocket && (this.role === "hub" || this.role === "peer") && !this.connected && !this.steppingDown && !this.draining;
    if (this.checkingHost || !socket || !onTcp()) return;
    this.checkingHost = true;
    try {
      await this.join(socket, (welcome) => onTcp() && !!welcome.extension);
    } finally {
      this.checkingHost = false;
    }
  }

  /**
   * Leaves the TCP bridge to join the native host, which has the extension. As the hub it closes
   * the port and its peers, which join the host too (or, servers that don't look for it, the host's
   * TCP listener once it has the port). Nothing reached an extension here (this server had none),
   * so whatever waits fails with "try again". Ported from mcp-newoutlook src/bridge.ts leaveTcp
   * (commit eb9d32f), without its handover note, which Teams' peers don't know.
   */
  private leaveTcp() {
    if (this.role === "hub") {
      console.error(`[mcp-teams ${this.serverVersion}] the extension is on the native host; joining it`);
      this.stopServing(LOST_CALL.hubRestarted);
    } else if (this.hub) {
      const old = this.hub;
      this.hub = undefined;
      this.extension = undefined;
      this.extensions = [];
      this.rejectAll(LOST_CALL.hubRestarted);
      old.close(1000, "moving to the native host");
    }
    this.role = "none";
  }

  // ------------------------------------------------------------------ calls

  /**
   * Calls the extension. Aborting `signal` withdraws the call (see withdraw). `deadline` (ms since
   * 1970) ends it earlier than timeoutMs, for a call relayed from a peer.
   */
  call<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number, signal?: AbortSignal, deadline?: number): Promise<T> {
    return this.run<T>(null, method, params, timeoutMs, signal, deadline);
  }

  /** A call from `session` (null: this server's own, else the peer it came from). */
  private async run<T>(session: BridgeSocket | null, method: string, params: unknown = {}, timeoutMs = 60_000, signal?: AbortSignal, deadline?: number): Promise<T> {
    // A hub that drains before it closes starts no new call (#112), its own session's included.
    if (this.draining) throw new Error(NOT_SENT.hubClosing);
    const counted = this.role === "hub";
    if (counted) this.active++;
    try {
      return await this.runCall<T>(session, method, params, timeoutMs, signal, deadline);
    } finally {
      if (counted) this.active--;
    }
  }

  private async runCall<T>(session: BridgeSocket | null, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, deadline?: number): Promise<T> {
    if (method === "reloadAll" && this.role === "hub") return this.reloadAll(timeoutMs) as Promise<T>;
    const target = this.role === "hub" ? await this.pickExtension(method) : this.role === "peer" ? this.hub : undefined;
    if (!this.connected || !target) {
      const reason =
        this.role === "none"
          ? (this.listenError ?? "Connecting to the mcp-teams bridge; try again in a few seconds.")
          : "Browser extension is not connected. Open Chrome or Edge with the mcp-teams extension installed (run `mcp-teams setup`).";
      throw new Error(reason);
    }
    // A send opens a window that must close once nobody waits for it: an extension that ignores
    // cancel would leave it open for a late click. The hub checks the extension it picked (for its
    // own sends and its peers'). A peer behind a hub that doesn't say it checks (one from before
    // #22) checks what that hub reported: it can't know which browser the hub will pick, so every
    // one must close the window.
    if (method === "requestSend") {
      if (this.role === "hub") {
        const version = this.sockets.get(target)?.version;
        if (!closesSendWindow(version)) throw new Error(NOT_SENT.extensionTooOld(version ?? "unknown"));
      } else if (!this.hubChecksSend && (!this.extensions.length || !this.extensions.every((e) => closesSendWindow(e.version)))) {
        throw new Error(NOT_SENT.extensionTooOld(oldestTooOld(this.extensions)));
      }
    }
    let result: T;
    if (this.role === "hub" && !UNQUEUED.has(method)) {
      // The call's time limit includes its wait for a turn.
      const end = Math.min(Date.now() + timeoutMs, deadline ?? Infinity);
      const turn: Turn = { queue: await this.takeTurn(target, session, end, signal), session, end, held: true };
      try {
        if (signal?.aborted) throw new Error(NOT_SENT.cancelled);
        result = await this.send<T>(target, method, params, timeoutMs, signal, end, turn);
      } finally {
        turn.done = true;
        turn.rejoin?.abort();
        if (turn.held) turn.queue.release(session); // handed to the next waiting call, if any
      }
    } else {
      result = await this.send<T>(target, method, params, timeoutMs, signal, deadline);
    }
    // A list call sent elsewhere for its Teams tab doesn't move the other calls with it.
    const forTab = NEEDS_TEAMS_TAB.has(method) && this.preferred !== undefined;
    if (this.role === "hub" && !forTab && this.preferred !== target && this.sockets.has(target)) {
      this.preferred = target;
      this.updateExtensions();
    }
    return result;
  }

  /**
   * Hub: waits for one of the extension's maxConcurrentCalls turns, fairly between sessions.
   * Cancelling or reaching `end` first leaves the line, and the call is never sent.
   */
  private takeTurn(target: BridgeSocket, session: BridgeSocket | null, end: number, signal?: AbortSignal): Promise<FairQueue<BridgeSocket | null>> {
    let turns = this.turns.get(target);
    if (!turns) this.turns.set(target, (turns = { queue: new FairQueue(this.opts.maxConcurrentCalls), waiting: new Set() }));
    const { queue, waiting } = turns;
    if (signal?.aborted) return Promise.reject(new Error(NOT_SENT.cancelled));
    if (queue.tryTake(session)) return Promise.resolve(queue);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiting.delete(leave);
      };
      const leaveLine = queue.wait(session, () => (done(), resolve(queue)));
      const leave = (err: Error) => {
        if (!leaveLine()) return; // already given its turn
        done();
        reject(err);
      };
      const onAbort = () => leave(new Error(NOT_SENT.cancelled));
      const timer = setTimeout(() => leave(new Error(NOT_SENT.waitedOut(queue.max))), Math.max(0, end - Date.now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.add(leave);
    });
  }

  /** Hub: fails the calls still waiting for a turn on `socket` (every socket when not given); they were never sent. */
  private dropTurns(socket?: BridgeSocket) {
    for (const [s, { waiting }] of this.turns) {
      if (socket && s !== socket) continue;
      this.turns.delete(s);
      for (const leave of [...waiting]) leave(new Error(NOT_SENT.gone));
    }
  }

  /** Hub: asks every connected browser's extension to reload itself. */
  private async reloadAll(timeoutMs: number) {
    const open = [...this.sockets.keys()].filter((s) => s.readyState === OPEN);
    if (!open.length) throw new Error("Browser extension is not connected.");
    const results = await Promise.allSettled(open.map((s) => this.send(s, "reload", {}, timeoutMs)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === results.length) throw failed[0].reason;
    return { reloading: results.length - failed.length };
  }

  /** Sends one request on a connection (an extension for the hub, the hub for a peer). */
  private send<T>(target: BridgeSocket, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, deadline?: number, turn?: Turn): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    const id = randomUUID();
    const now = Date.now();
    // Taken before the timer starts, so the timer never fires before it.
    const end = Math.min(now + timeoutMs, deadline ?? Infinity);
    // A peer waits a little longer than the hub, so the hub's own timeout message wins.
    const wait = Math.max(0, end - now) + (this.role === "peer" ? 5_000 : 0);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.withdraw(id, target, cancelledError());
      const done = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => this.withdraw(id, target, new Error(LOST_CALL.timedOut(method))), wait);
      this.pending.set(id, {
        resolve: (v) => (done(), resolve(v as T)),
        reject: (e) => (done(), reject(e)),
        timer,
        grace: method === "requestSend",
        socket: this.role === "hub" ? target : undefined,
        turn,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      // deadline: when this side stops waiting (same machine, same clock), so the extension
      // sends nothing to Teams after it, however long the request took to arrive. turn: it holds
      // a turn, which it gives back while it waits out a throttle (see onExtensionMessage).
      target.send(JSON.stringify({ type: "request", id, method, params, timeoutMs, deadline: end, ...(turn ? { turn: true } : {}) }));
    });
  }

  /**
   * Withdraws a call nobody waits for any more (timed out or cancelled): tells the other side
   * to drop it with {type:"cancel", id} (sides that don't know it ignore it). A send's answer
   * still counts for cancelGraceMs. So a send the user already clicked reports its real
   * outcome, and a confirmation window that closed reports "nothing was sent". Without an
   * answer by then, the call fails with `err`.
   */
  private withdraw(id: string, target: BridgeSocket, err: Error) {
    const p = this.pending.get(id);
    if (!p || p.withdrawn) return;
    p.withdrawn = true;
    clearTimeout(p.timer);
    const fail = () => {
      if (this.pending.get(id) !== p) return;
      this.pending.delete(id);
      p.reject(err);
    };
    if (target.readyState !== OPEN) return fail();
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
  private rejectAll(reason: string, socket?: BridgeSocket) {
    for (const [id, p] of this.pending) {
      if (socket && p.socket !== socket) continue;
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /**
   * Closes the bridge when this server's AI session ends (#112; ported from mcp-newoutlook
   * src/bridge.ts drainAndClose, PR #108 there). A hub with calls in flight (other sessions', a
   * confirmation window) first stops taking new ones: they fail as not sent (NOT_SENT.hubClosing).
   * It waits up to maxWaitMs for the running ones to be answered, then closes as close() does: a
   * call still running fails as on any close, and a send still waiting for a click is withdrawn
   * (its window closes). A peer, and a hub with nothing in flight, close at once.
   *
   * When nothing it accepted is left unanswered, it tells its peers ({type:"drained"}) just before
   * it closes: from then on it runs nothing, so a call still on its way to it never ran, and the
   * peer fails it as not sent instead of as a lost call. Peers from before #112 ignore the note.
   */
  async drainAndClose(maxWaitMs = DRAIN_MAX_WAIT_MS) {
    if (this.closed) return;
    if (this.role === "hub") {
      this.draining = true;
      const end = Date.now() + maxWaitMs;
      while (this.busy && Date.now() < end && !this.closed && this.role === "hub") await new Promise((r) => setTimeout(r, 25));
      if (this.closed) return;
      if (this.role === "hub") {
        if (!this.busy) {
          const note = JSON.stringify({ type: "drained" });
          for (const peer of this.peers) this.sendToPeer(peer, note);
        } else {
          // The bound ran out: have the extension drop what is still running first, so an open
          // confirmation window closes rather than posting on a click before it sees the close.
          for (const [id, p] of this.pending) {
            if (p.socket?.readyState !== OPEN) continue;
            try {
              p.socket.send(JSON.stringify({ type: "cancel", id }));
            } catch {
              // closing anyway
            }
          }
        }
      }
    }
    await this.close();
  }

  async close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.tcpRetry);
    clearInterval(this.hostWatch);
    this.nudging?.terminate();
    clearInterval(this.keepAlive);
    this.stopPeerBeat();
    this.dropTurns();
    this.rejectAll(LOST_CALL.shuttingDown);
    this.hub?.close();
    for (const s of this.sockets.keys()) s.close();
    for (const peer of this.peers) peer.close();
    const listeners = this.listeners;
    this.listeners = [];
    this.tcpListener = undefined;
    await Promise.all(listeners.map((l) => l.close()));
  }
}
