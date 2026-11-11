/**
 * The native host's log (#123 decision 6): ~/.mcp-teams/hub.log, 0600 in a 0700 folder, moved to
 * hub.log.1 once it passes 1 MB. Metadata only: the type, method, ok, size and timing of each
 * message, never its text (no chat ids, message bodies, error texts or tokens); errors by name and
 * code only (errorFields), and versions other programs sent as version characters only (logVersion).
 *
 * Ported from mcp-newoutlook src/hub.ts log() and traffic() (commit 127715c), as functions of
 * their own so the rotation and what a line holds can be tested without a host process.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** hub.log moves to hub.log.1 once it is larger than this. */
export const HUB_LOG_MAX_BYTES = 1024 * 1024;

export type LogFields = Record<string, string | number | undefined>;
export type Log = (event: string, fields?: LogFields) => void;

/**
 * Moves `file` to `file`.1 once it is larger than maxBytes, safely while other processes append
 * and rotate too (#143: about ten servers share server.log). Renaming straight to .1 could, when
 * two processes saw the big file at once, move the other's fresh small file over the rotated one
 * and lose it. So this first claims the file under a name of its own (only one rename of it can
 * succeed), and moves the claim to .1 only when it is the big file; a small one (another process
 * rotated first) goes back by appending it.
 *
 * When .1 can't be replaced (on Windows, another program such as a virus scanner or a viewer holds
 * it open), the big claim stays as `<file>.<pid>-<random>.rotating` rather than going back: copying
 * a megabyte back would make every following line read and write it again. Such a file is an older
 * part of the log, safe to read or delete.
 *
 * `seenSize`: the size this process saw (tests: one seen just before another process rotated).
 */
export function rotate(file: string, maxBytes: number, seenSize?: number) {
  try {
    if ((seenSize ?? statSync(file).size) <= maxBytes) return;
  } catch {
    return; // no log yet
  }
  const claim = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.rotating`;
  try {
    renameSync(file, claim);
  } catch {
    return; // another process moved it first
  }
  let big: boolean;
  try {
    big = statSync(claim).size > maxBytes;
  } catch {
    return; // can't tell: left as the .rotating file, nothing is lost
  }
  if (big) {
    try {
      renameSync(claim, `${file}.1`);
    } catch {
      // .1 is held: the claim stays aside (see above), and the live log starts afresh
    }
    return;
  }
  try {
    appendFileSync(file, readFileSync(claim), { mode: 0o600 });
    unlinkSync(claim);
  } catch {
    // left as the .rotating file: nothing is lost
  }
}

/** A logger appending to `file`. Logging never throws: a log it can't write must not stop the host. */
export function hubLog(file: string, maxBytes = HUB_LOG_MAX_BYTES): Log {
  return (event, fields = {}) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      rotate(file, maxBytes);
      const extra = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${event}${extra ? ` ${extra}` : ""}\n`, { mode: 0o600 });
    } catch {
      // logging must never stop the host
    }
  };
}

/**
 * An error as hub.log records it: its name and code, never its message (a JSON.parse message
 * quotes its input; a socket error may name a path). A thrown non-Error counts by its type.
 */
export function errorFields(err: unknown): { name: string; code: string | undefined } {
  const word = (v: unknown, keep: RegExp) => (typeof v === "string" ? v.replace(keep, "").slice(0, 32) || undefined : undefined);
  if (!(err instanceof Error)) return { name: typeof err, code: undefined };
  return { name: word(err.name, /[^\w]/g) ?? "Error", code: word((err as NodeJS.ErrnoException).code, /[^\w-]/g) };
}

/** A version another program sent, as hub.log records it: letters, digits, `.`, `_` and `-` only, at most 32. */
export function logVersion(v: unknown): string {
  return v == null ? "unknown" : String(v).replace(/[^\w.-]/g, "").slice(0, 32);
}

/**
 * Logs each message between the host and its extension: "to-extension" or "from-extension", with
 * its type, method (word characters only), ok (answers), size and, for an answer, the time since
 * its request went out. Only the head of the message is read, by pattern; ids are used to time
 * answers and never logged. Pings are skipped.
 */
export function trafficLogger(log: Log): (direction: "in" | "out", frame: Buffer | string) => void {
  const started = new Map<string, number>(); // request id → when it went to the extension
  return (direction, frame) => {
    const head = typeof frame === "string" ? frame.slice(0, 200) : frame.subarray(0, 200).toString("latin1");
    const type = /"type":"(\w+)"/.exec(head)?.[1];
    if (type === "ping") return;
    const id = /"id":"([\w-]{1,64})"/.exec(head)?.[1];
    const bytes = typeof frame === "string" ? Buffer.byteLength(frame) : frame.length;
    let ms: number | undefined;
    if (type === "request" && id) {
      started.set(id, Date.now());
      // An extension that never answers must not grow this without bound.
      if (started.size > 10_000) started.delete(started.keys().next().value!);
    }
    if (type === "response" && id && started.has(id)) {
      ms = Date.now() - started.get(id)!;
      started.delete(id);
    }
    // A response's ok (false: the call failed), never its error text.
    const ok = type === "response" ? /"ok":(true|false)/.exec(head)?.[1] : undefined;
    log(direction === "out" ? "to-extension" : "from-extension", { type, method: /"method":"(\w+)"/.exec(head)?.[1], ok, bytes, ms });
  };
}
