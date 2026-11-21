/**
 * How a server ends (found as mcp-newoutlook #288; the same held here): servers whose AI session
 * had exited kept running under PID 1 and ignored SIGTERM, because closing the bridge could hang
 * while a socket lingered and nothing else ended them.
 */
import { execFile } from "node:child_process";

/** How long a signal waits for the bridge to close before the process exits anyway. */
export const SIGNAL_EXIT_MS = 3_000;

export interface EndingOptions {
  /** Closes the bridge at once (a signal). */
  close: () => Promise<void>;
  /** Stops taking MCP calls and lets other sessions' running calls finish (#112). */
  drain: () => Promise<void>;
  /** The drain's bound; the process exits 2 s after it at the latest. */
  drainMs: number;
  exit: (code: number) => void;
  /** Records why the process ends (server.log's exit reason). */
  setReason: (reason: string) => void;
}

export function serverEnding(o: EndingOptions) {
  let gone = false;
  let signalled = false;
  return {
    /**
     * The session is gone (stdin closed, parent gone, stdout broken): the #112 drain, once, whichever
     * reports it first.
     */
    async sessionGone(reason: string): Promise<void> {
      if (gone || signalled) return;
      gone = true;
      o.setReason(reason);
      // the process exits soon after the bound even if a connection is slow to close
      setTimeout(() => (o.setReason("drain-timeout"), o.exit(0)), o.drainMs + 2_000).unref();
      await o.drain();
      o.exit(0);
    },
    /**
     * SIGINT, SIGTERM, SIGHUP: close at once, and exit within SIGNAL_EXIT_MS whatever the bridge does.
     * The first signal counts (#234): a later one, or the session going with it (stdin closes as the
     * AI app ends), keeps its reason and closes nothing again. A signal during a drain still ends it.
     */
    async signal(name: string): Promise<void> {
      if (signalled) return;
      signalled = true;
      o.setReason(name);
      setTimeout(() => o.exit(0), SIGNAL_EXIT_MS).unref();
      await o.close();
      o.exit(0);
    },
  };
}

export interface ParentWatch {
  /** Called once when the parent that started this process is gone. */
  onGone: () => void;
  /**
   * The parent PID recorded when the process started (default: ppid() now). Recorded early, an AI
   * app that exits while the server is still starting is still noticed.
   */
  parent?: number;
  /** The parent's own parent PID, looked up when the process started (default: parentOf(parent) now). */
  grandparent?: Promise<number | null>;
  ppid?: () => number;
  /** Whether a process with this PID exists. */
  alive?: (pid: number) => boolean;
  /** A process's parent PID, or null when unknown (no such process, or no way to tell). */
  parentOf?: (pid: number) => Promise<number | null>;
  everyMs?: number;
  /** How often the parent's own parent is looked up (a `ps` call), so less often than everyMs. */
  ancestorEveryMs?: number;
}

/**
 * Watches the parent that started this server so an orphan ends even when its stdin never reaches
 * EOF: gone once this process is reparented (ppid changes, often to 1), the parent's PID no longer
 * exists, or the parent is itself orphaned. Under npx the parent is `npm exec`, which outlives a
 * killed AI app under PID 1 and keeps this server with it, so its parent is watched too: gone once it
 * turns 1 when it wasn't at start. Returns a stop function.
 */
export function watchParent({
  onGone,
  ppid = () => process.ppid,
  parent = ppid(),
  alive = processExists,
  parentOf = parentOfProcess,
  grandparent = parentOf(parent),
  everyMs = 1_500,
  ancestorEveryMs = 3_000,
}: ParentWatch): () => void {
  // Started under PID 1 (a container's init, launchd): there is no parent to lose.
  if (parent <= 1) return () => {};
  let done = false;
  const timers: NodeJS.Timeout[] = [];
  const stop = () => timers.forEach((t) => clearInterval(t));
  const gone = () => {
    if (done) return;
    done = true;
    stop();
    onGone();
  };
  timers.push(
    setInterval(() => {
      if (ppid() !== parent || !alive(parent)) gone();
    }, everyMs),
  );
  void grandparent.then((first) => {
    // The parent already under PID 1 (or unknown) at start: nothing more to notice.
    if (done || first === null || first <= 1) return;
    let looking = false;
    const t = setInterval(async () => {
      if (looking) return;
      looking = true;
      const now = await parentOf(parent).catch(() => null);
      looking = false;
      if (now === 1) gone();
    }, ancestorEveryMs);
    t.unref();
    timers.push(t);
  }, () => {});
  timers[0].unref();
  return () => ((done = true), stop());
}

/**
 * A process's parent PID through `ps`, or null when there is no such process. Null on Windows, which
 * doesn't reparent: there a gone parent shows as its PID no longer existing.
 */
export function parentOfProcess(pid: number): Promise<number | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2_000 }, (err, stdout) => {
      const n = Number(String(stdout).trim());
      resolve(err || !Number.isInteger(n) || String(stdout).trim() === "" ? null : n);
    });
  });
}

/**
 * stdout is the MCP channel: once a write to it fails because it is closed (EPIPE, or a destroyed
 * stream: #215), nobody reads this server any more. Without a listener each failed write reached
 * uncaughtException, which logged and carried on (about 2,000 EPIPEs in 8 s). Reports the session
 * gone once, as stdout-closed; the listener stays to take the rest. Any other write error is passed
 * to onOther (logged as before) and doesn't end the session.
 */
export function watchStdout(
  stdout: { on(event: "error", fn: (err: Error) => void): unknown },
  onGone: (reason: "stdout-closed") => void,
  onOther: (err: Error) => void,
): void {
  let reported = false;
  stdout.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") return onOther(err);
    if (reported) return;
    reported = true;
    onGone("stdout-closed");
  });
}

/** Whether a process with this PID exists: signal 0 checks without sending; EPERM means it exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
