/**
 * The native host's log (#123 decision 6): ~/.mcp-teams/hub.log, 0600 in a 0700 folder, moved to
 * hub.log.1 once it passes 1 MB. Metadata only: the type, method, ok, size and timing of each
 * message, never its text (no chat ids, message bodies, error texts or tokens).
 *
 * Ported from mcp-newoutlook src/hub.ts log() and traffic() (commit 127715c), as functions of
 * their own so the rotation and what a line holds can be tested without a host process.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** hub.log moves to hub.log.1 once it is larger than this. */
export const HUB_LOG_MAX_BYTES = 1024 * 1024;

export type LogFields = Record<string, string | number | undefined>;
export type Log = (event: string, fields?: LogFields) => void;

/** A logger appending to `file`. Logging never throws: a log it can't write must not stop the host. */
export function hubLog(file: string, maxBytes = HUB_LOG_MAX_BYTES): Log {
  return (event, fields = {}) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
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
