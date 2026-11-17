// #182: the server's event-loop delay and utilisation, so server.log can show whether a slow or
// timed-out status read waited on the extension or on this process's own blocked loop.
import { describe, expect, it } from "vitest";
import { loopDelayMonitor } from "../../src/loopDelay.js";
import { stall } from "../helpers/timing.js";

/** A histogram as monitorEventLoopDelay gives one: values in ns. */
const fakeHistogram = () => {
  const h = { p99: 0, max: 0, resets: 0, enabled: false, percentile: (_p: number) => h.p99, enable: () => void (h.enabled = true), reset: () => void h.resets++ };
  return h;
};

/** performance.eventLoopUtilization's shape: with a baseline, the share of time since it that the loop was busy. */
const fakeElu = () => {
  const clock = { active: 0, idle: 0, calls: [] as unknown[] };
  const elu = (prev?: { active: number; idle: number }) => {
    clock.calls.push(prev);
    const active = clock.active - (prev?.active ?? 0);
    const idle = clock.idle - (prev?.idle ?? 0);
    return { active, idle, utilization: active + idle ? active / (active + idle) : 0 };
  };
  return { clock, elu };
};

describe("#182: loopDelayMonitor", () => {
  it("reads the window's p99 and max delay as whole ms and utilisation as a whole percent", () => {
    const h = fakeHistogram();
    const { clock, elu } = fakeElu();
    const monitor = loopDelayMonitor({ histogram: () => h, eventLoopUtilization: elu });
    expect(h.enabled).toBe(true);
    h.p99 = 21_495_807; // ns
    h.max = 1_342_177_279;
    clock.active = 900;
    clock.idle = 100;
    expect(monitor.read()).toEqual({ p99Ms: 21, maxMs: 1342, elu: 90 });
  });

  it("starts a new window on reset: the histogram is cleared and utilisation counts from then", () => {
    const h = fakeHistogram();
    const { clock, elu } = fakeElu();
    const monitor = loopDelayMonitor({ histogram: () => h, eventLoopUtilization: elu });
    clock.active = 1_000; // busy before the reset
    monitor.reset();
    expect(h.resets).toBe(1);
    clock.active += 50;
    clock.idle += 150;
    expect(monitor.read().elu).toBe(25);
  });

  it("with the real monitor, a stalled loop shows as a large max delay and a busy loop", async () => {
    const monitor = loopDelayMonitor();
    // The histogram measures between two turns of its own timer, and a reset forgets the last one:
    // let it take a turn first, as it has long done in a running server.
    monitor.reset();
    await new Promise((r) => setTimeout(r, 60));
    stall(300);
    await new Promise((r) => setTimeout(r, 60)); // the histogram's timer records the late turn
    const r = monitor.read();
    expect(r.maxMs).toBeGreaterThanOrEqual(250);
    expect(r.p99Ms).toBeLessThanOrEqual(r.maxMs);
    expect(r.elu).toBeGreaterThanOrEqual(20); // 300 ms busy in about 420 ms; a loaded machine stretches the waits
  });
});
