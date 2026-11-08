// #111: after a server updates the extension's folder, its reload request is retried while the
// hub changes hands, but an extension that got the request is never reloaded again (each reload
// clears its captured Teams sessions).
import { describe, expect, it, vi } from "vitest";
import { reloadUntilUpdated, type Reloadable } from "../../src/extensionUpdate.js";

/** A bridge whose reloads go as `outcomes` says: a version it comes back as, or an Error. */
function bridge(outcomes: (string | Error)[], { connected = true, version = "0.3.46" } = {}) {
  const b = {
    connected,
    extension: { version },
    reloadExtension: vi.fn(async () => {
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      const before = b.extension.version;
      b.extension = { version: next ?? before };
      return { before, after: b.extension.version };
    }),
  };
  return b satisfies Reloadable;
}

/** Fake time: sleep moves the clock on. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("reloadUntilUpdated (#111)", () => {
  it("reloads once when the first request gets through", async () => {
    const b = bridge(["0.3.47"]);
    expect(await reloadUntilUpdated(b, "0.3.47", clock())).toEqual({ ok: true, before: "0.3.46", after: "0.3.47" });
    expect(b.reloadExtension).toHaveBeenCalledTimes(1);
  });

  it("asks again after a request failed while the hub changed hands", async () => {
    const b = bridge([new Error("The mcp-teams hub restarted; try again in a few seconds."), "0.3.47"]);
    expect(await reloadUntilUpdated(b, "0.3.47", clock())).toEqual({ ok: true, before: "0.3.46", after: "0.3.47" });
    expect(b.reloadExtension).toHaveBeenCalledTimes(2);
  });

  it("never reloads again an extension that came back older (loaded from another folder): one reload, as before", async () => {
    const b = bridge(["0.3.46", "0.3.46"]);
    expect(await reloadUntilUpdated(b, "0.3.47", clock())).toEqual({ ok: true, before: "0.3.46", after: "0.3.46" });
    expect(b.reloadExtension).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask again when a failed request reached the extension after all", async () => {
    const b = bridge([]);
    b.reloadExtension.mockImplementationOnce(async () => {
      b.extension = { version: "0.3.47" };
      throw new Error("The extension did not reconnect within 30 s. Check chrome://extensions for errors.");
    });
    expect(await reloadUntilUpdated(b, "0.3.47", clock())).toEqual({ ok: true, before: null, after: "0.3.47" });
    expect(b.reloadExtension).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 failed requests and says why", async () => {
    const b = bridge([new Error("a"), new Error("b"), new Error("c"), "0.3.47"]);
    expect(await reloadUntilUpdated(b, "0.3.47", clock())).toEqual({ ok: false, error: "c" });
    expect(b.reloadExtension).toHaveBeenCalledTimes(3);
  });

  it("gives up at the deadline when the extension never connects", async () => {
    const b = bridge([], { connected: false });
    expect(await reloadUntilUpdated(b, "0.3.47", { ...clock(), deadlineMs: 20_000 })).toEqual({ ok: false, error: "the extension never connected" });
    expect(b.reloadExtension).not.toHaveBeenCalled();
  });
});
