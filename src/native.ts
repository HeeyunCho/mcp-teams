/**
 * Chrome's native messaging, as the native host (dist/hub.js) speaks it with the extension (#123,
 * ADR 0001): each message is a 4-byte little-endian length, then UTF-8 JSON. Chrome takes at most
 * 1 MB per message from the host, so larger ones are sent as `{type:"chunk", id, seq, last, data}`
 * slices that the extension joins. And where servers reach the native host: the hub socket.
 *
 * Ported from mcp-newoutlook src/native.ts (commit 7ef8ac9): encodeFrame, FrameDecoder,
 * toExtensionFrames and NativePort as there; the pipe name per decision 10 of #123 (Outlook's
 * collides for non-ASCII usernames, HeeyunCho/mcp-newoutlook#178).
 */
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { CONFIG_DIR } from "./config.js";
import type { BridgeSocket } from "./bridge.js";

/** Chrome's limit for one message from the host to the extension. */
export const MAX_TO_EXTENSION_BYTES = 1024 * 1024;
/** The largest `data` slice in one chunk (UTF-8 bytes). */
export const CHUNK_DATA_BYTES = 512 * 1024;

/** One message in Chrome's framing. */
export function encodeFrame(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Reads frames from a byte stream (the host's stdin). A frame over maxBytes is skipped as it
 * arrives, without being buffered, and reported through onOversize.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  /** Bytes of an oversized frame still to skip. */
  private skipping = 0;

  constructor(
    private readonly onFrame: (frame: Buffer) => void,
    private readonly maxBytes = Infinity,
    private readonly onOversize?: (bytes: number) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.skipping) {
      const n = Math.min(this.skipping, chunk.length);
      this.skipping -= n;
      chunk = chunk.subarray(n);
      if (!chunk.length) return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.maxBytes) {
        this.onOversize?.(len);
        const have = Math.min(len, this.buf.length - 4);
        this.skipping = len - have;
        this.buf = this.buf.subarray(4 + have);
        if (this.skipping) return;
        continue;
      }
      if (this.buf.length < 4 + len) return;
      const frame = Buffer.from(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      this.onFrame(frame);
    }
  }
}

/** Room for the chunk envelope around `data` within one frame. */
const CHUNK_ENVELOPE_BYTES = 256;

/**
 * The frames that carry one message to the extension: one frame up to 1 MB, else chunks.
 * Slices are cut between characters (never inside a surrogate pair), at most 512 KB each,
 * and small enough that the chunk frame, with `data` escaped as JSON, stays under 1 MB.
 */
export function toExtensionFrames(message: string | Buffer, id: string = randomUUID()): Buffer[] {
  const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.length;
  if (bytes <= MAX_TO_EXTENSION_BYTES) return [encodeFrame(message)];
  const text = typeof message === "string" ? message : message.toString("utf8");
  const frames: Buffer[] = [];
  const fits = (s: string) =>
    Buffer.byteLength(s) <= CHUNK_DATA_BYTES && Buffer.byteLength(JSON.stringify(s)) <= MAX_TO_EXTENSION_BYTES - CHUNK_ENVELOPE_BYTES;
  let seq = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + CHUNK_DATA_BYTES);
    while (!fits(text.slice(start, end))) end = start + Math.max(1, Math.floor((end - start) * 0.9));
    // Don't separate a surrogate pair.
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff && end - start > 1) end--;
    const data = text.slice(start, end);
    start = end;
    frames.push(encodeFrame(JSON.stringify({ type: "chunk", id, seq: seq++, last: start >= text.length, data })));
  }
  return frames;
}

const OPEN = 1;
const CLOSED = 3;

/**
 * The extension's native-messaging port, seen from the host: a BridgeSocket, like the WebSocket
 * the bridge uses for an extension. Frames read from stdin are passed in with receive(); what the
 * bridge sends is framed (and chunked) onto `out` (stdout).
 *
 * ping() answers at once with a synthetic "pong": the pipe itself shows that Chrome is there (a
 * closed port ends stdin), and without one the hub's keep-alive would drop the port at its
 * second tick. The hub's {type:"ping"} messages still reach the extension, whose watchdog needs them.
 */
export class NativePort extends EventEmitter implements BridgeSocket {
  readyState = OPEN;

  constructor(
    private readonly out: Writable,
    private readonly onTraffic?: (direction: "in" | "out", frame: Buffer | string) => void,
  ) {
    super();
    out.on("error", (err) => this.emit("error", err));
  }

  /** A message from the extension (one frame's payload). */
  receive(frame: Buffer): void {
    if (this.readyState !== OPEN) return;
    this.onTraffic?.("in", frame);
    this.emit("message", frame);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return;
    this.onTraffic?.("out", data);
    for (const frame of toExtensionFrames(data)) this.out.write(frame);
  }

  get bufferedAmount(): number {
    return this.out.writableLength;
  }

  ping(): void {
    queueMicrotask(() => this.readyState === OPEN && this.emit("pong"));
  }

  close(code = 1000, _reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", code);
  }

  terminate(): void {
    this.close(1006);
  }
}

/**
 * Where servers reach the native host (decision 10 of #123):
 * - macOS, Linux: ~/.mcp-teams/hub.sock (0600 in a 0700 folder);
 * - Windows: the named pipe `\\.\pipe\mcp-teams-<the username's ASCII letters, digits and ._->-<first
 *   8 hex of sha256(username)>`. The hash keeps two non-ASCII usernames apart (Outlook replaces
 *   them with `_`, so 홍길동 and 김철수 would meet on one pipe).
 * TEAMS_MCP_HUB_SOCKET moves it (tests).
 */
export function hubSocketPath({
  platform = process.platform,
  configDir = CONFIG_DIR,
  user,
  env = process.env,
}: { platform?: NodeJS.Platform; configDir?: string; user?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (env.TEAMS_MCP_HUB_SOCKET) return env.TEAMS_MCP_HUB_SOCKET;
  if (platform === "win32") {
    const name = user ?? safeUsername();
    const ascii = name.replace(/[^A-Za-z0-9._-]/g, "");
    const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\mcp-teams-${ascii}-${hash}`;
  }
  return join(configDir, "hub.sock");
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "user";
  }
}

/** Node's longest timer: a setTimeout over 2^31-1 ms fires at once (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A timing the host reads from its environment (TEAMS_MCP_HUB_*_MS, for tests): a whole number of
 * milliseconds above 0, written as plain digits (spaces around them are fine), clamped to Node's
 * longest timer however long it is. Anything else (missing, 0, a sign, a fraction, an exponent,
 * hex) is rejected: undefined, so the default applies.
 */
export function msFromEnv(raw: string | undefined): number | undefined {
  if (!raw || !/^\s*\d+\s*$/.test(raw)) return undefined;
  // Plain digits are a whole number, or Infinity when too long for a double: both clamp.
  const v = Number(raw);
  if (v <= 0) return undefined;
  return Math.min(v, MAX_TIMER_MS);
}

/**
 * Whether peers must prove the pairing token on the hub socket: only on Windows, where a named
 * pipe's default security lets every user open it and Node can't set a stricter one. A Unix
 * socket file is 0600 in a 0700 folder, so only the same user reaches it.
 */
export function socketNeedsProof(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
