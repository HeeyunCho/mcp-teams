/**
 * Every server's diagnostic log (#143): ~/.mcp-teams/server.log, 0600 in a 0700 folder, moved to
 * server.log.1 once it passes 1 MB (hubLog's rotation, which is safe with many processes appending
 * at once). It is what is left to trace an outage after a restart: when the server started and
 * stopped, its role, the extension coming and going, the Teams state it reported, failed and slow
 * tool calls, and crashes.
 *
 * Metadata only: event names and values this code chose, versions as version characters, errors by
 * name and code. Never message text, names, tokens, chat ids, regions or the signed-in account (only
 * whether it changed). Every value is cut to a few safe characters, so nothing can forge a line.
 * States are logged when they change, not on every status read. Logging never throws.
 */
import { join } from "node:path";
import { isLostCall } from "./bridge.js";
import { CONFIG_DIR } from "./config.js";
import { errorFields, hubLog, logVersion, type Log, type LogFields } from "./hubLog.js";
import type { RestartState } from "./buildInfo.js";
import { IDLE_MS, isMissingSession } from "./sessionNote.js";

/** Where every server logs: next to config.json (TEAMS_MCP_HOME moves both, for tests). */
export const SERVER_LOG_FILE = join(CONFIG_DIR, "server.log");

/** A tool call that takes longer than this is logged even when it succeeds. */
export const SLOW_TOOL_MS = 20_000;

export interface DiagnosticLog {
  start(fields?: LogFields): void;
  exit(reason: string, code?: number): void;
  /** The bridge's events (BridgeOptions.diagnose): role, handover, extension, extension-closed, hub-closed. */
  bridge(event: string, fields?: LogFields): void;
  /** A status the extension answered (null or {error} when it couldn't be read; `failure` says why, else unreadable). */
  teamsStatus(status: unknown, failure?: "aborted"): void;
  /** A tool call that ended: logged when it failed (err) or took longer than slowToolMs. */
  toolCall(name: string, ms: number, err?: unknown): void;
  restartNeeded(onDiskVersion: string): void;
  /** An uncaught exception or unhandled rejection, by its name and code only. */
  crash(kind: "uncaught-exception" | "unhandled-rejection", err: unknown): void;
}

export interface DiagnosticLogOptions {
  file?: string;
  version: string;
  /** The server's role now, written on every line. */
  role: () => string;
  slowToolMs?: number;
  maxBytes?: number;
}

/** A value as server.log writes it: word characters and `.,:-` only, at most 48. */
const safe = (v: string | number) => String(v).replace(/[^\w.,:-]/g, "").slice(0, 48) || "-";

/** A version, or "unknown": x.y.z with at most a short suffix, so no other text passes as one. */
const strictVersion = (v: unknown) => (/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-.][\w]{1,12})?$/.test(logVersion(v)) ? logVersion(v) : "unknown");

/** Field → how its value is checked. A field not listed is never written: callers can't add free text. */
const WORD = (v: string) => (/^[a-z][\w-]{0,31}$/i.test(v) ? v : "-");
const FIELDS: Record<string, (v: string) => string> = {
  role: WORD,
  via: WORD,
  transport: (v) => (/^[a-z][a-z,]{0,47}$/.test(v) ? v : "-"), // one, or several joined by commas
  reason: WORD,
  command: WORD,
  kind: WORD,
  status: WORD,
  captured: WORD,
  account: WORD,
  ok: WORD,
  slow: WORD,
  name: WORD, // a tool's name, from this code's own list
  services: (v) => (/^[a-z,]{1,64}$/.test(v) ? v : "-"),
  node: (v) => (/^v\d+\.\d+\.\d+$/.test(v) ? v : "-"),
  stale: WORD,
  ext: strictVersion, // the extension's version, for version skew (#96, #111)
  hub: strictVersion,
  to: strictVersion,
  onDisk: strictVersion,
  version: strictVersion,
  code: (v) => (/^(?:\d{1,5}|[A-Z][A-Z0-9_]{1,31})$/.test(v) ? v : "-"),
  error: (v) => (/^(?:[A-Za-z]{0,24}(?:Error|Exception)|string|number|object|undefined|boolean|symbol|bigint|function)$/.test(v) ? v : "other"),
  ms: (v) => (/^\d{1,9}$/.test(v) ? v : "-"),
  tabs: (v) => (/^\d{1,4}$/.test(v) ? v : "-"),
  count: (v) => (/^\d{1,4}$/.test(v) ? v : "-"),
};

/** Teams services the extension captures sessions for (extension/background.js). */
const SERVICES = new Set(["chatsvc", "csa", "mt", "substrate", "sharepoint"]);

/** An event name: lowercase words joined by dashes (anything else is written as "other"). */
const EVENT = /^[a-z][a-z-]{0,31}$/;

/** Tools whose long calls wait for the user, not for Teams: never logged as slow. */
const WAITS_FOR_USER = new Set(["send_message"]);

/**
 * Whether the Teams session looks stale (yes/no), as get_version's note judges "stuck at sign-in"
 * (sessionNote.ts): the tab keeps calling but made no signed-in call for IDLE_MS. captured=yes
 * survives an expired token, so this is the sign that it went bad. Unknown (left out) for an
 * extension from before #103, which reports no calls.
 */
function staleOf(st: any): "yes" | "no" | undefined {
  if (!("lastTeamsCall" in st)) return undefined;
  const last = Date.parse(st.lastTeamsCall?.at);
  const signedIn = Date.parse(st.lastSignedInCall?.at);
  if (!Number.isFinite(last)) return "no";
  return !Number.isFinite(signedIn) || last - signedIn > IDLE_MS ? "yes" : "no";
}

/** What a failed tool call's error was, from a fixed set: its message is never logged. */
function errorKind(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (isLostCall(message)) return "lost-call";
  if (isMissingSession(message)) return "no-session";
  if (/extension is not connected/i.test(message)) return "not-connected";
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "other";
}

export function diagnosticLog(options: DiagnosticLogOptions): DiagnosticLog {
  const append: Log = hubLog(options.file ?? SERVER_LOG_FILE, options.maxBytes);
  const version = logVersion(options.version);
  const slowToolMs = options.slowToolMs ?? SLOW_TOOL_MS;
  const write = (event: string, fields: LogFields = {}) => {
    try {
      const out: LogFields = { v: version, role: safe(options.role()) };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && Object.hasOwn(FIELDS, k)) out[k] = FIELDS[k](safe(v));
      append(EVENT.test(event) ? event : "other", out);
    } catch {
      // logging must never stop the server
    }
  };
  const last = new Map<string, string>(); // event → its last fields, to log a state only when it changes
  const onChange = (event: string, fields: LogFields) => {
    const key = JSON.stringify(fields);
    if (last.get(event) === key) return;
    last.set(event, key);
    write(event, fields);
  };
  let account: { known: boolean; id?: string } = { known: false };
  let restartSeen = false;
  const fieldsOf = (err: unknown) => {
    try {
      return errorFields(err);
    } catch {
      return { name: "unreadable", code: undefined }; // a getter that throws must not reach an exception handler
    }
  };
  const kindOf = (err: unknown) => {
    try {
      return errorKind(err);
    } catch {
      return "other";
    }
  };

  return {
    start: (fields = {}) => write("start", { ...fields, node: process.version }),
    exit: (reason, code) => write("exit", { reason, code }),
    bridge(event, fields = {}) {
      if (event === "role" || event === "extensions") return onChange(event, fields);
      // An extension with a bad token retries every 30 s: its refusal is logged when it changes,
      // and again after something connected.
      if (event === "handshake-closed") return onChange(event, fields);
      if (event === "extension-connected") last.delete("handshake-closed");
      write(event, fields);
    },
    teamsStatus(status, failure) {
      try {
        const st = status as any;
        if (!st || typeof st !== "object" || "error" in st) return onChange("teams", { status: failure ?? "unreadable" });
        const services = st.services && typeof st.services === "object" ? Object.keys(st.services).filter((k) => SERVICES.has(k) && st.services[k]) : [];
        const id = typeof st.signedInAs === "string" && st.signedInAs ? st.signedInAs : undefined;
        // The account itself stays in memory: the log says only whether it changed.
        const accountField = !id ? "none" : !account.known ? "first" : account.id === id ? "same" : "changed";
        const state = {
          tabs: Number.isFinite(Number(st.teamsTabs)) ? Number(st.teamsTabs) : "-",
          captured: Array.isArray(st.sessions) && st.sessions.some((x: any) => x?.sessionCaptured) ? "yes" : "no",
          services: services.length ? services.join(",") : "none",
          stale: staleOf(st),
        };
        const changedAccount = !account.known || account.id !== id;
        const key = JSON.stringify(state);
        account = { known: true, id };
        if (last.get("teams") === key && !changedAccount) return;
        last.set("teams", key);
        write("teams", { ...state, account: accountField });
      } catch {
        // a status of an unexpected shape is not worth a crash
      }
    },
    toolCall(name, ms, err) {
      // send_message waits for the user's click in its confirmation window: a long wait isn't slow.
      const slow = ms > slowToolMs && !WAITS_FOR_USER.has(name);
      if (err === undefined && !slow) return;
      const e = err === undefined ? undefined : fieldsOf(err);
      write("tool", { name, ok: err === undefined ? "yes" : "no", ms: Math.round(ms), error: e?.name, code: e?.code, kind: err === undefined ? undefined : kindOf(err), slow: slow ? "yes" : undefined });
    },
    restartNeeded(onDiskVersion) {
      if (restartSeen) return;
      restartSeen = true;
      write("restart-needed", { onDisk: logVersion(onDiskVersion) });
    },
    crash(kind, err) {
      const e = fieldsOf(err);
      write(kind, { error: e.name, code: e.code });
    },
  };
}

/** How often the background watch reads the Teams state and the build on disk. */
export const WATCH_MS = 60_000;
/** How long the background watch waits for the extension's status. */
const WATCH_STATUS_TIMEOUT_MS = 5_000;

export interface WatchStateOptions {
  bridge: { readonly role: string; readonly connected: boolean; backgroundStatus(timeoutMs: number): Promise<unknown> };
  diagnostics: DiagnosticLog;
  /** Whether the code on disk is newer than the running one (restartCheck). */
  onDisk: () => RestartState;
  everyMs?: number;
}

/**
 * Keeps server.log current while no tool is called (#143: the overnight outage had no calls, so
 * nothing read the Teams state). Every period, the hub with an extension reads its status (logged
 * when it changed), and any server checks the build on disk (restart-needed, once). The timer is
 * unref'd, a read never overlaps the last one, and nothing here throws. Returns a stop function.
 */
export function watchState({ bridge, diagnostics, onDisk, everyMs = WATCH_MS }: WatchStateOptions): () => void {
  let reading = false;
  const tick = () => {
    try {
      const state = onDisk();
      if (state.restartNeeded) diagnostics.restartNeeded(state.onDisk.version);
    } catch {
      // a build.json it can't read is no reason to stop watching
    }
    if (reading || bridge.role !== "hub" || !bridge.connected) return;
    reading = true;
    bridge
      .backgroundStatus(WATCH_STATUS_TIMEOUT_MS)
      .then(
        (st) => diagnostics.teamsStatus(st),
        () => diagnostics.teamsStatus(null),
      )
      .catch(() => {})
      .finally(() => (reading = false));
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
