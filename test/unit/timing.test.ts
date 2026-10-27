// Self-tests of test/helpers/timing.ts: polling for a condition and stalling the event loop.
import { describe, expect, it } from "vitest";
import { stall, until } from "../helpers/timing.js";

describe("timing helpers", () => {
  it("until resolves once the condition holds", async () => {
    let ready = false;
    setTimeout(() => (ready = true), 30);
    await until(() => ready, 1_000, "ready");
    expect(ready).toBe(true);
  });

  it("until names what it waited for when it times out", async () => {
    await expect(until(() => false, 50, "the peer to join")).rejects.toThrow("timed out waiting for the peer to join");
  });

  it("stall holds back a due timer for at least the given time", async () => {
    const t0 = performance.now();
    const fired = new Promise<number>((r) => setTimeout(() => r(performance.now()), 0));
    stall(100);
    expect((await fired) - t0).toBeGreaterThanOrEqual(100);
  });
});
