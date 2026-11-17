/**
 * This server's event-loop delay and utilisation (#182), for server.log: whether a slow or
 * timed-out status read waited on the extension and Teams, or on this process's own loop.
 *
 * A large delay with high utilisation: JavaScript ran the whole time (our own work blocked the loop).
 * A large delay with low utilisation: the process didn't run at all (Windows efficiency throttling,
 * sleep, suspension). A low delay: the loop was free, so the wait was elsewhere.
 *
 * Node's histogram samples on a timer every resolutionMs (unref'd by Node), which adds that much to
 * every value: fine for finding stalls of a second or more.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

/** One window's figures, since the monitor started or was last reset. */
export interface LoopDelay {
  /** The 99th percentile of the loop's delay, in whole ms. */
  p99Ms: number;
  /** The longest delay, in whole ms. */
  maxMs: number;
  /** How much of the window the loop was busy, as a whole percent. */
  elu: number;
}

export interface LoopDelayMonitor {
  read(): LoopDelay;
  reset(): void;
}

/** What the monitor needs of monitorEventLoopDelay's histogram (values in ns). */
export interface DelayHistogram {
  readonly max: number;
  percentile(p: number): number;
  enable(): void;
  reset(): void;
}

export interface LoopDelayOptions {
  resolutionMs?: number;
  /** Tests pass a fake; the default is perf_hooks' monitorEventLoopDelay. */
  histogram?: (resolutionMs: number) => DelayHistogram;
  /** Tests pass a fake; the default is performance.eventLoopUtilization. */
  eventLoopUtilization?: (prev?: EventLoopUtilization) => EventLoopUtilization;
}

const nsToMs = (ns: number) => (Number.isFinite(ns) ? Math.max(0, Math.round(ns / 1e6)) : 0);

export function loopDelayMonitor({
  resolutionMs = 20,
  histogram = (resolution) => monitorEventLoopDelay({ resolution }),
  eventLoopUtilization = (prev) => performance.eventLoopUtilization(prev),
}: LoopDelayOptions = {}): LoopDelayMonitor {
  const h = histogram(resolutionMs);
  h.enable();
  let since = eventLoopUtilization();
  return {
    read() {
      const u = eventLoopUtilization(since).utilization;
      return { p99Ms: nsToMs(h.percentile(99)), maxMs: nsToMs(h.max), elu: Number.isFinite(u) ? Math.round(u * 100) : 0 };
    },
    /** Starts a new window. Node also forgets its last sample, so the turn running now isn't counted. */
    reset() {
      h.reset();
      since = eventLoopUtilization();
    },
  };
}
