// The native host (dist/hub.js) as Chrome runs it (#123): a child process with the caller's origin
// as its first argument, and a fake extension speaking Chrome's framing (4-byte little-endian
// length + UTF-8 JSON) on its stdin and stdout. Servers join it as peers over a hub socket in a
// temporary folder (a named pipe named after it on Windows).
// Ported from mcp-newoutlook test/helpers/nativeHost.ts (commit ace7f02).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ExtensionBridge, type BridgeOptions } from "../../src/bridge.js";
import { EXTENSION_ORIGIN } from "../../src/extension.js";
import { FAST, TOKEN, type Handler, type Request } from "./bridgeHarness.js";
import { until } from "./timing.js";

export const HUB_JS = "dist/hub.js";

export interface NativeExtensionOptions {
  /** The caller origin Chrome passes (default: our extension's, with the trailing slash Chrome adds). */
  origin?: string;
  handle?: Handler;
  /** Methods it never answers. */
  silentFor?: string[];
  browser?: string;
  instance?: string;
  version?: string;
  /** How long the host keeps the hub socket after the extension goes (default: a short 30 s stand-in). */
  lingerMs?: number;
  /** Don't send hello (to look at a host before the extension says anything). */
  noHello?: boolean;
  /** Env on top of the harness's. */
  env?: Record<string, string>;
}

/** A host child process with a fake extension on its stdio. */
export function nativeExtension(home: string, socket: string, opts: NativeExtensionOptions = {}) {
  const {
    origin = `${EXTENSION_ORIGIN}/`,
    handle = () => ({ ok: true }),
    silentFor = [],
    browser = "Chrome",
    instance = "profile-1",
    version = "0.3.56",
    lingerMs = 30_000,
  } = opts;
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [HUB_JS, origin], {
    env: {
      ...process.env,
      TEAMS_MCP_HOME: home,
      TEAMS_MCP_HUB_SOCKET: socket,
      TEAMS_MCP_HUB_LINGER_MS: String(lingerMs),
      TEAMS_MCP_HUB_KEEPALIVE_MS: String(FAST.keepAliveMs),
      ...opts.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let exitCode: number | null | undefined;
  void exited.then((c) => (exitCode = c));

  /** Every message after chunks are joined, in order. */
  const received: any[] = [];
  /** The size of every frame the host wrote (payload bytes). */
  const frameSizes: number[] = [];
  /** Chunk messages, as they came. */
  const chunks: any[] = [];
  const parts = new Map<string, string[]>();
  let buf = Buffer.alloc(0);

  const write = (msg: unknown) => {
    if (!child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([head, body]));
  };

  const onMessage = async (msg: any) => {
    if (msg.type === "chunk") {
      chunks.push(msg);
      const list = parts.get(msg.id) ?? [];
      list[msg.seq] = msg.data;
      parts.set(msg.id, list);
      if (msg.last) {
        parts.delete(msg.id);
        await onMessage(JSON.parse(list.join("")));
      }
      return;
    }
    received.push(msg);
    if (msg.type !== "request" || silentFor.includes(msg.method)) return;
    let reply;
    try {
      reply = { type: "response", id: msg.id, ok: true, result: await handle(msg) };
    } catch (err) {
      reply = { type: "response", id: msg.id, ok: false, error: (err as Error).message };
    }
    write(reply);
  };

  child.stdout.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      frameSizes.push(len);
      // Anything on stdout that isn't a frame of JSON fails here: stdout is the native-messaging channel.
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      void onMessage(msg);
    }
  });

  if (!opts.noHello) write({ type: "hello", version, browser, instance, capabilities: { maxMessageBytes: 256 * 1024 * 1024, features: [] } });

  return {
    child,
    received,
    frameSizes,
    chunks,
    exited,
    get exitCode() {
      return exitCode;
    },
    get stderr() {
      return stderr;
    },
    get welcome() {
      return received.find((m) => m.type === "welcome");
    },
    requests: () => received.filter((m) => m.type === "request") as Request[],
    send: write,
    /** Chrome closing the port: the host's stdin ends. */
    disconnect: () => child.stdin.end(),
    kill: () => {
      if (exitCode === undefined) child.kill("SIGKILL");
      return exited;
    },
  };
}

export type NativeExtension = ReturnType<typeof nativeExtension>;

/**
 * A temporary home (config.json with the pairing token, port 0 and the native host on; the hub
 * socket; hub.log), hosts with fake extensions, and servers that join the hub socket. Call
 * cleanup() from afterEach.
 */
export async function nativeHarness(options: BridgeOptions = FAST, config: object = {}) {
  // Short: a Unix socket path is limited to about 100 bytes.
  const home = mkdtempSync(join(tmpdir(), "mt-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: TOKEN, port: 0, nativeHost: true, ...config }), { mode: 0o600 });
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\${basename(home)}` : join(home, "hub.sock");
  const log = join(home, "hub.log");
  const hosts: NativeExtension[] = [];
  const bridges: ExtensionBridge[] = [];
  const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return {
    home,
    socket,
    log,
    logText,
    /** The TCP port the serving host got for its peers (it listens on port 0), from hub.log. */
    async hostPort(): Promise<number> {
      await until(() => / tcp port=\d+/.test(logText()), 5_000, "the host's TCP port in hub.log");
      return Number(/ tcp port=(\d+)/.exec(logText())![1]);
    },
    /** Starts a host with a fake extension; resolves once the extension has its welcome (unless noHello or it exits). */
    async host(opts: NativeExtensionOptions = {}, waitForWelcome = !opts.noHello) {
      const ext = nativeExtension(home, socket, opts);
      hosts.push(ext);
      if (waitForWelcome) await until(() => !!ext.welcome || ext.exitCode !== undefined, 8_000, "welcome from the host");
      return ext;
    },
    /** A server's bridge with the native host on: it tries the hub socket first, then TCP on `port` (0: a free one). */
    async server(version = "0.3.56", extra: BridgeOptions = {}, port = 0) {
      const b = new ExtensionBridge(port, TOKEN, version, { ...options, hubSocket: socket, hubPollMs: 200, ...extra });
      bridges.push(b);
      await b.start();
      return b;
    },
    socketExists: () => existsSync(socket),
    async cleanup() {
      await Promise.all(bridges.map((b) => b.close().catch(() => {})));
      await Promise.all(hosts.map((h) => h.kill()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
