// How a server ends (#234, found as mcp-newoutlook #288): a signal always exits within its bound, and a session
// that is gone (stdin closed, parent gone, stdout broken) ends the server through the #112 drain.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_EXIT_MS, serverEnding, watchParent, watchStdout } from "../../src/lifecycle.js";

const never = () => new Promise<void>(() => {});

/** A serverEnding whose exits and reasons the test reads. */
function ending(over: Partial<Parameters<typeof serverEnding>[0]> = {}) {
  const exits: number[] = [];
  let reason = "unknown";
  const e = serverEnding({
    close: async () => {},
    drain: async () => {},
    drainMs: 5_000,
    exit: (code) => void exits.push(code),
    setReason: (r) => void (reason = r),
    ...over,
  });
  return { e, exits, reason: () => reason };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("#234: a signal", () => {
  it("exits with 0 within its bound even when closing the bridge never ends", async () => {
    const { e, exits, reason } = ending({ close: never });
    void e.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(SIGNAL_EXIT_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([0]);
    expect(reason()).toBe("SIGTERM");
    expect(SIGNAL_EXIT_MS).toBeLessThanOrEqual(3_000);
  });
  it("ends once: a later signal or a session gone keeps its reason, closes nothing again and starts no drain", async () => {
    const close = vi.fn(async () => {});
    const drain = vi.fn(async () => {});
    const { e, exits, reason } = ending({ close, drain });
    void e.signal("SIGTERM");
    void e.sessionGone("stdin-closed");
    void e.signal("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGNAL_EXIT_MS + 2_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(drain).not.toHaveBeenCalled();
    expect(reason()).toBe("SIGTERM");
    expect(exits[0]).toBe(0);
  });
});

describe("#234: a session that is gone", () => {
  it("drains once and exits with the first reason, however often it is reported", async () => {
    const drain = vi.fn(async () => {});
    const { e, exits, reason } = ending({ drain });
    void e.sessionGone("stdout-closed");
    void e.sessionGone("stdout-closed");
    void e.sessionGone("parent-gone");
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
    expect(reason()).toBe("stdout-closed");
  });

  it("#112: exits 2 s after the drain's bound when the drain never ends, as drain-timeout", async () => {
    const { e, exits, reason } = ending({ drain: never, drainMs: 500 });
    void e.sessionGone("parent-gone");
    await vi.advanceTimersByTimeAsync(2_499);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([0]);
    expect(reason()).toBe("drain-timeout");
  });

  it("a signal during the drain still exits within the signal's bound", async () => {
    const { e, exits, reason } = ending({ drain: never, close: never, drainMs: 5_000 });
    void e.sessionGone("stdin-closed");
    await vi.advanceTimersByTimeAsync(100);
    void e.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(SIGNAL_EXIT_MS);
    expect(exits).toEqual([0]);
    expect(reason()).toBe("SIGTERM");
  });
});

describe("#234: watchParent", () => {
  /** A parent the test can end: as reparenting does, ppid turns to 1, or the PID stops existing. */
  const parent = (pid = 4242) => {
    const p = { ppid: pid, alive: true };
    return { p, ppid: () => p.ppid, alive: (n: number) => n === pid && p.alive };
  };

  it("reports the parent gone once, within its period, when the process is reparented", async () => {
    const { p, ppid, alive } = parent();
    const onGone = vi.fn();
    watchParent({ onGone, ppid, alive, everyMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onGone).not.toHaveBeenCalled();
    p.ppid = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("reports the parent gone when its PID no longer exists though ppid is unchanged (Windows doesn't reparent)", async () => {
    const { p, ppid, alive } = parent();
    const onGone = vi.fn();
    watchParent({ onGone, ppid, alive, everyMs: 1_000 });
    p.alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("doesn't watch a server started under PID 1, which has no parent to lose", async () => {
    const onGone = vi.fn();
    watchParent({ onGone, ppid: () => 1, alive: () => true, everyMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it("watches the parent recorded when the process started, though it was gone before watching began", async () => {
    // The AI app exited while the server was still starting: by the time the server watches, its ppid is already 1.
    const onGone = vi.fn();
    watchParent({ onGone, parent: 4242, ppid: () => 1, alive: () => false, everyMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  describe("under npx (the AI app → npm exec → this server)", () => {
    /** npm exec (4242), whose own parent, the AI app (777), the test can end: npm exec is then reparented to 1. */
    const npmExec = () => {
      const app = { pid: 777 };
      return { app, parentOf: vi.fn(async (pid: number) => (pid === 4242 ? app.pid : null)) };
    };

    it("reports the parent gone once npm exec itself is orphaned, though it still runs", async () => {
      const { app, parentOf } = npmExec();
      const onGone = vi.fn();
      watchParent({ onGone, ppid: () => 4242, alive: () => true, parentOf, underNpx: true, everyMs: 1_000, ancestorEveryMs: 3_000 });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(onGone).not.toHaveBeenCalled();
      app.pid = 1;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onGone).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(onGone).toHaveBeenCalledTimes(1);
    });

    it("looks up the grandparent at most once per ancestorEveryMs", async () => {
      const { parentOf } = npmExec();
      watchParent({ onGone: () => {}, ppid: () => 4242, alive: () => true, parentOf, underNpx: true, everyMs: 1_000, ancestorEveryMs: 3_000 });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(parentOf.mock.calls.length).toBeLessThanOrEqual(4); // the first at start, then every 3 s
    });

    it("doesn't look up the grandparent when not started by npx: the AI app's own launcher may exit while it runs", async () => {
      const { app, parentOf } = npmExec();
      const onGone = vi.fn();
      watchParent({ onGone, ppid: () => 4242, alive: () => true, parentOf, underNpx: false, everyMs: 1_000, ancestorEveryMs: 3_000 });
      app.pid = 1;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(onGone).not.toHaveBeenCalled();
      expect(parentOf).not.toHaveBeenCalled();
    });

    it("doesn't watch the grandparent when the parent was already under PID 1 at start", async () => {
      const onGone = vi.fn();
      watchParent({ onGone, ppid: () => 4242, alive: () => true, parentOf: async () => 1, underNpx: true, everyMs: 1_000, ancestorEveryMs: 1_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onGone).not.toHaveBeenCalled();
    });
  });
});

describe("#215: watchStdout", () => {
  const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  it("reports a closed stdout once as stdout-closed, and takes the errors after it without throwing", () => {
    const stdout = new EventEmitter();
    const onGone = vi.fn();
    watchStdout(stdout, onGone, () => {});
    for (let i = 0; i < 2_000; i++) stdout.emit("error", epipe());
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith("stdout-closed");
  });

  it("reports a destroyed stdout as stdout-closed too", () => {
    const stdout = new EventEmitter();
    const onGone = vi.fn();
    watchStdout(stdout, onGone, () => {});
    stdout.emit("error", Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" }));
    expect(onGone).toHaveBeenCalledWith("stdout-closed");
  });

  it("passes another write error on without ending the session, as it was logged before", () => {
    const stdout = new EventEmitter();
    const onGone = vi.fn();
    const onOther = vi.fn();
    watchStdout(stdout, onGone, onOther);
    const eio = Object.assign(new Error("write EIO"), { code: "EIO" });
    stdout.emit("error", eio);
    expect(onGone).not.toHaveBeenCalled();
    expect(onOther).toHaveBeenCalledWith(eio);
  });
});
