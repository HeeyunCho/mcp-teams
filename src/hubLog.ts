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
import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** hub.log moves to hub.log.1 once it is larger than this. */
export const HUB_LOG_MAX_BYTES = 1024 * 1024;

export type LogFields = Record<string, string | number | undefined>;
export type Log = (event: string, fields?: LogFields) => void;

/** A rotation lock older than this was left by a process that died while rotating. */
const STALE_LOCK_MS = 30_000;

/**
 * Moves `file` to `file`.1 once it is larger than maxBytes, safely while other processes append
 * and rotate too (#143: about ten servers share server.log). Renaming straight to .1 could, when
 * two processes saw the big file at once, move the other's fresh small file over the rotated one
 * and lose it. So only the process that created `<file>.lock` (exclusively) rotates, and only when
 * the file is still big under the lock; one that finds the lock taken skips rotating for this line
 * (a later line tries again). Nothing is copied back or deleted: a line another process writes
 * late, through the log it opened before the move, lands in the moved file and is kept (#152:
 * setting a small file aside, appending it back and deleting it lost such lines).
 *
 * When .1 can't be replaced (on Windows, another program such as a virus scanner or a viewer holds
 * it open), the big log moves aside as `<file>.<pid>-<random>.rotating` instead, and the live log
 * starts afresh. Such a file is an older part of the log, safe to read or delete. A lock left by a
 * process that died while rotating is removed once it is STALE_LOCK_MS old.
 *
 * `seenSize`: the size this process saw (tests: one seen just before another process rotated).
 */
export function rotate(file: string, maxBytes: number, seenSize?: number) {
  try {
    if ((seenSize ?? statSync(file).size) <= maxBytes) return;
  } catch {
    return; // no log yet
  }
  const lock = `${file}.lock`;
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    // Another process is rotating, or one died doing so.
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
    } catch {
      // gone already, or can't be removed now: a later line tries again
    }
    return;
  }
  try {
    if (statSync(file).size <= maxBytes) return; // another process rotated first
    try {
      renameSync(file, `${file}.1`);
    } catch {
      renameSync(file, `${file}.${process.pid}-${randomBytes(4).toString("hex")}.rotating`); // .1 is held
    }
  } catch {
    // can't move it now: it keeps growing until a later line can
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // removed once it is stale
    }
  }
}

/** A logger checks the log's real size at least once every this many lines, to notice other processes' lines. */
const STAT_EVERY_LINES = 50;

/**
 * A logger appending to `file`. Logging never throws: a log it can't write must not stop the host.
 *
 * #170: a line is one blocking file call, not three. The folder is made on the first line, and
 * again only after an append finds it gone. The log's size is kept in memory (the size last read
 * plus this logger's own bytes since), and read again only once that passes maxBytes or every
 * STAT_EVERY_LINES lines, so lines other processes appended are noticed too. The estimate only
 * saves a stat: rotate() still re-checks the real size under the lock (#152/#163).
 */
export function hubLog(file: string, maxBytes = HUB_LOG_MAX_BYTES): Log {
  let dirMade = false;
  let size = 0; // estimated
  let linesSinceStat = STAT_EVERY_LINES; // read the size on the first line
  const realSize = () => {
    linesSinceStat = 0;
    try {
      return statSync(file).size;
    } catch {
      return 0; // no log yet, or moved by another process
    }
  };
  const makeDir = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    dirMade = true;
  };
  return (event, fields = {}) => {
    try {
      if (!dirMade) makeDir();
      if (size > maxBytes || linesSinceStat >= STAT_EVERY_LINES) {
        size = realSize();
        if (size > maxBytes) {
          rotate(file, maxBytes, size);
          size = realSize();
        }
      }
      const extra = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const line = `${new Date().toISOString()} pid=${process.pid} ${event}${extra ? ` ${extra}` : ""}\n`;
      try {
        appendFileSync(file, line, { mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        makeDir(); // the folder was removed since
        appendFileSync(file, line, { mode: 0o600 });
      }
      size += Buffer.byteLength(line);
      linesSinceStat++;
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
