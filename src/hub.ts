#!/usr/bin/env node
/**
 * The native host (#123, ADR 0001): Chrome or Edge starts it through
 * chrome.runtime.connectNative("com.mcp_teams.hub") and talks to it on stdin/stdout, in Chrome's
 * framing (src/native.ts).
 *
 * - As the serving host (the first to bind the hub socket) it is the hub: an ExtensionBridge with
 *   the native port as its extension, serving the sessions' servers (peers) on the hub socket, and
 *   on the TCP port for peers only.
 * - When another native host (another browser's, or one this extension started earlier) already
 *   holds the hub socket, it is a relaying host: it passes its extension's messages to that serving
 *   host, and takes the socket over (becoming the serving host) if it goes away.
 * - When stdin closes it lingers 30 s for the extension to come back (a relaying host counts), then
 *   drains as a TCP hub does when its session ends (#112) and exits (decision 5).
 * - It runs only while config.json says "nativeHost": true (off until PR 5 of #123); otherwise it
 *   exits at once and the extension stays on TCP.
 *
 * stdout is the native-messaging channel: nothing else may be written to it. The log is hub.log
 * (src/hubLog.ts): metadata only.
 *
 * Ported from mcp-newoutlook src/hub.ts (commit 127715c). Teams' relaying host answers the serving
 * host's challenge with a proof of the pairing token (Outlook sends the token itself), and there
 * is no late-answer log or build-mismatch line yet.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { DEFAULT_BRIDGE_OPTIONS, ExtensionBridge, MAX_MESSAGE_BYTES, proof, socketTransport, type BridgeSocket } from "./bridge.js";
import { CONFIG_DIR, SERVER_VERSION, loadConfig } from "./config.js";
import { EXTENSION_ORIGIN } from "./extension.js";
import { errorFields, hubLog, trafficLogger } from "./hubLog.js";
import { FrameDecoder, NativePort, hubSocketPath, msFromEnv, socketNeedsProof } from "./native.js";

const envMs = (name: string) => msFromEnv(process.env[name]);
/** How long the host keeps serving once no extension is connected (tests set it shorter). */
const LINGER_MS = envMs("TEAMS_MCP_HUB_LINGER_MS") ?? 30_000;
/** Ping period towards the extension and the peers (tests set it shorter). */
const KEEP_ALIVE_MS = envMs("TEAMS_MCP_HUB_KEEPALIVE_MS");
/**
 * How long a connection has to prove the token: the serving host's authTimeoutMs, and a relaying
 * host's limit for the hub socket's holder to send its challenge and then its proven welcome
 * (tests set it shorter).
 */
const AUTH_TIMEOUT_MS = envMs("TEAMS_MCP_HUB_AUTH_TIMEOUT_MS") ?? DEFAULT_BRIDGE_OPTIONS.authTimeoutMs;
/**
 * The most of the extension's frames a relaying host holds before the hub socket's holder has
 * proved itself, and their bytes. The extension sends its hello and waits for the welcome (it
 * answers requests, and none can come before), so a handful is already generous; past this the
 * host exits rather than grow its memory, and the extension connects again. Dropping instead would
 * lose answers without a word. 1 MB is Chrome's own limit for one message to the extension.
 */
const MAX_HELD_FRAMES = 64;
const MAX_HELD_BYTES = 1024 * 1024;

const log = hubLog(join(CONFIG_DIR, "hub.log"));
const traffic = trafficLogger(log);

process.on("unhandledRejection", (err) => log("error", { what: "unhandled-rejection", ...errorFields(err) }));
process.on("uncaughtException", (err) => log("error", { what: "uncaught-exception", ...errorFields(err) }));

// Chrome passes the caller's origin first ("chrome-extension://<id>/"; on Windows a
// --parent-window argument follows). Only our extension may use this host.
const origin = (process.argv[2] ?? "").replace(/\/+$/, "");
if (origin !== EXTENSION_ORIGIN) {
  log("refused", { reason: "unknown caller origin" });
  process.stderr.write("mcp-teams hub: refused: only the mcp-teams extension may start this host.\n");
  process.exit(1);
}

const config = loadConfig();
if (!config.nativeHost) {
  // Off (the default until #123's PR 5): the port closes before any welcome, so the extension uses TCP.
  log("disabled", { reason: "nativeHost is off" });
  process.stderr.write('mcp-teams hub: the native host is off ("nativeHost" in config.json).\n');
  process.exit(1);
}
const socketPath = hubSocketPath();

// ------------------------------------------------------------------ the extension's port

const port = new NativePort(process.stdout, traffic);
port.on("error", () => {}); // stdout gone: Chrome closed the port, stdin ends too

const isHello = (frame: Buffer) => {
  if (frame.length > 64 * 1024) return false;
  try {
    return JSON.parse(frame.toString("utf8"))?.type === "hello";
  } catch {
    return false;
  }
};

/**
 * The extension's last hello, sent again when this native host moves (relaying host → serving host,
 * or relaying to another serving host).
 */
let hello: Buffer | undefined;
/** Frames waiting until this native host knows whether it is the serving host or a relaying host. */
let queue: Buffer[] = [];
let sink: (frame: Buffer) => void = (f) => queue.push(f);
let stdinClosed = false;

const decoder = new FrameDecoder(
  (frame) => {
    if (isHello(frame)) hello = frame;
    sink(frame);
  },
  MAX_MESSAGE_BYTES,
  (bytes) => {
    log("oversize", { bytes });
    // As on the WebSocket: the calls on this connection fail with a readable error.
    port.emit("error", Object.assign(new Error("message too large"), { code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" }));
  },
);
process.stdin.on("data", (d: Buffer) => decoder.push(d));
const onStdinEnd = () => {
  if (stdinClosed) return;
  stdinClosed = true;
  log("extension disconnected");
  port.close(1001, "extension disconnected");
  relaySocket?.close(1000, "extension disconnected");
};
process.stdin.on("end", onStdinEnd);
process.stdin.on("close", onStdinEnd);

// ------------------------------------------------------------------ serving host

let lingerTimer: NodeJS.Timeout | undefined;

async function becomeHost(replay: Buffer[]): Promise<boolean> {
  let bridge: ExtensionBridge;
  const linger = (count: number) => {
    if (count > 0) {
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
      return;
    }
    if (lingerTimer) return;
    lingerTimer = setTimeout(async () => {
      log("exit", { reason: "no extension", lingerMs: LINGER_MS });
      // As a TCP hub whose session ended (#112): calls in flight get the drain's few seconds, then
      // peers fail what is left with "try again" and fall back to TCP.
      await bridge.drainAndClose().catch(() => {});
      process.exit(0);
    }, LINGER_MS);
  };
  bridge = new ExtensionBridge(config.port, config.token, SERVER_VERSION, {
    hostSocket: socketPath,
    socketNeedsProof: socketNeedsProof(),
    features: ["native"],
    onExtensionsChange: (list) => linger(list.length),
    onEvent: (event, fields) => log(event, fields),
    authTimeoutMs: AUTH_TIMEOUT_MS,
    ...(KEEP_ALIVE_MS ? { keepAliveMs: KEEP_ALIVE_MS } : {}),
  });
  await bridge.start();
  if (bridge.role !== "hub") {
    await bridge.close();
    return false;
  }
  log("host", { version: SERVER_VERSION, role: "serving" });
  linger(0);
  if (!stdinClosed && port.readyState === WebSocket.OPEN) {
    bridge.attachExtension(port);
    sink = (f) => port.receive(f);
    for (const f of [...replay, ...queue.splice(0)]) port.receive(f);
  }
  // The bridge dropped the native port while Chrome still holds it (a restart after a server
  // error): exit, so the extension connects again to a fresh host.
  port.on("close", (code: number) => {
    if (!stdinClosed && code !== 4000) {
      log("exit", { reason: "port closed by the hub", code });
      setTimeout(() => process.exit(1), 100);
    }
  });
  return true;
}

// ------------------------------------------------------------------ relaying host

/** Compares a proof in constant time; false for anything but a string of the same length. */
function sameText(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

let relaySocket: BridgeSocket | undefined;

/**
 * Passes the extension's messages to the serving host on the hub socket and back; resolves with
 * the close code. Both sides prove the pairing token here, as a peer and its hub do:
 * - the serving host's challenge is answered with the extension's hello, a proof of the token
 *   ("client:socket") and this host's own nonce;
 * - nothing from the hub socket reaches the extension, and nothing of the extension's but that
 *   hello goes there, until the welcome carries proof(token, "server:socket", nonce). Anything
 *   else first (another user's program holding the Windows pipe while no host ran) ends this
 *   host: the extension's port closes and it connects again.
 * After that every message passes through unchanged.
 */
function relay(pending: Buffer[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = socketTransport({ path: socketPath, maxMessageBytes: MAX_MESSAGE_BYTES }).connect();
    relaySocket = ws;
    const nonce = randomBytes(24).toString("base64url");
    let challenge: string | undefined;
    let proven = false;
    const prepare = (f: Buffer) =>
      isHello(f) && challenge
        ? JSON.stringify({ ...JSON.parse(f.toString("utf8")), proof: proof(config.token, "client:socket", challenge), nonce })
        : f.toString("utf8");
    // Logged as the serving host's NativePort logs what it receives (the frame as the extension sent it, without the proof).
    const forward = (f: Buffer) => {
      traffic("in", f);
      ws.send(prepare(f));
    };
    const waiting = [...pending];
    let held = waiting.reduce((n, f) => n + f.length, 0); // bytes in `waiting`
    let helloSent = false;
    /** From now on the holder has AUTH_TIMEOUT_MS to send its proven welcome. */
    const awaitWelcome = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => refuse("the hub socket's holder sent no proven welcome in time"), AUTH_TIMEOUT_MS);
    };
    const sendHello = (f: Buffer) => {
      helloSent = true;
      forward(f);
      // The welcome must come as soon as the serving host has the hello, as it comes to any client.
      awaitWelcome();
    };
    sink = (f) => {
      if (proven && ws.readyState === WebSocket.OPEN) return forward(f);
      // A hello that comes after the challenge goes on at once; the rest waits for the welcome's proof.
      if (challenge && !helloSent && isHello(f)) return sendHello(f);
      waiting.push(f);
      held += f.length;
      // Not one buffer more for a holder that never proves itself (see MAX_HELD_FRAMES).
      if (waiting.length > MAX_HELD_FRAMES || held > MAX_HELD_BYTES) refuse("the extension sent too much before the hub socket's holder proved itself");
    };
    const refuse = (reason = "the hub socket's holder failed its proof") => {
      log("exit", { reason });
      ws.terminate();
      process.exit(1);
    };
    // A holder that keeps quiet gets no longer than a client gets from the serving host to prove itself.
    let deadline = setTimeout(() => refuse("the hub socket's holder sent no challenge in time"), AUTH_TIMEOUT_MS);
    ws.on("message", (raw: Buffer) => {
      if (proven) return port.send(raw.toString("utf8"));
      let msg: any;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return refuse();
      }
      if (!challenge) {
        if (msg?.type !== "challenge" || typeof msg.nonce !== "string") return refuse();
        challenge = msg.nonce;
        log("relay", { version: SERVER_VERSION });
        // The hello first, alone: the serving host takes nothing else before it. With no hello yet
        // the clock runs from the challenge (an extension that never says hello gets no longer);
        // a hello that comes later restarts it.
        const first = waiting.filter(isHello).at(-1) ?? hello;
        if (first) sendHello(first);
        else awaitWelcome();
        return;
      }
      if (msg?.type !== "welcome" || !sameText(msg.proof, proof(config.token, "server:socket", nonce))) return refuse();
      proven = true;
      clearTimeout(deadline);
      port.send(raw.toString("utf8"));
      for (const f of waiting.splice(0)) if (!isHello(f)) forward(f);
    });
    ws.on("error", () => {});
    ws.on("close", (code: number) => {
      clearTimeout(deadline);
      relaySocket = undefined;
      sink = (f) => queue.push(f);
      resolve(code);
    });
  });
}

// ------------------------------------------------------------------ start

void (async () => {
  let replay: Buffer[] = [];
  for (let attempt = 0; ; attempt++) {
    if (stdinClosed && attempt > 0) {
      log("exit", { reason: "extension disconnected" });
      process.exit(0);
    }
    if (await becomeHost(replay)) return;
    const code = await relay([...replay, ...queue.splice(0)]);
    if (code === 4401 || code === 4409) {
      log("exit", { reason: "refused by the host", code });
      process.exit(1);
    }
    // The serving host went away: take the hub socket over (or relay to the native host that did),
    // with only the hello sent again; requests that were on their way there fail at their callers.
    replay = hello ? [hello] : [];
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 250));
  }
})();
