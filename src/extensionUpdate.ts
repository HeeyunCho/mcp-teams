import { isNewer } from "./bridge.js";

/** What reloadUntilUpdated needs of the bridge. */
export interface Reloadable {
  readonly connected: boolean;
  readonly extension?: { version: string };
  reloadExtension(): Promise<{ before: string | null; after: string }>;
}

export interface ReloadRetryOptions {
  /** Reload requests at most (each one that throws counts). */
  tries?: number;
  /** Gives up after this long. */
  deadlineMs?: number;
  /** Waits this long between looks. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type ReloadOutcome = { ok: true; before: string | null; after: string } | { ok: false; error: string };

/**
 * #111: after a server updated the extension's folder to `wanted`, asks the extension to reload,
 * and asks again only when the request failed (it threw: right after an update the hub often
 * changes hands, and "The mcp-teams hub restarted" came back). A reload that got through ends it,
 * whatever version came back: an extension loaded from another folder never comes back as
 * `wanted`, and each reload clears its captured Teams sessions, so it is reloaded once, as before.
 * Before asking again, a failed request that reached the extension after all (it now runs
 * `wanted` or newer) also ends it.
 */
export async function reloadUntilUpdated(target: Reloadable, wanted: string, options: ReloadRetryOptions = {}): Promise<ReloadOutcome> {
  const { tries: maxTries = 3, deadlineMs = 180_000, waitMs = 5_000, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = "the extension never connected";
  for (let tries = 0, end = now() + deadlineMs; tries < maxTries && now() < end; await sleep(waitMs)) {
    if (!target.connected) continue;
    const current = target.extension?.version;
    if (tries > 0 && current !== undefined && !isNewer(wanted, current)) return { ok: true, before: null, after: current };
    tries++;
    try {
      return { ok: true, ...(await target.reloadExtension()) };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { ok: false, error: lastError };
}
