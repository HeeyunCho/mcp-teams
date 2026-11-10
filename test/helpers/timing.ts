// Timing helpers for tests that wait on real timers: polling for a condition and stalling the
// whole process.

/**
 * Polls until cond holds (default 3 s). The timeout runs on performance.now(), not Date, so it
 * still ends under a frozen fake Date (vi.useFakeTimers with toFake: ["Date"]).
 */
export async function until(cond: () => boolean, timeoutMs = 3_000, what = "condition"): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Blocks this whole process (hubs, peers, the worker and fake extensions alike) for `ms`: a
 * stalled event loop, as a busy machine or a long GC causes. Shows that a liveness check (a hub
 * tick, a watchdog) that runs late skips its verdict, since a ping or pong may wait unread.
 */
export function stall(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}
