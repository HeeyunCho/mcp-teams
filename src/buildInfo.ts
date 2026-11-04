import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Which build of mcp-teams this is: written to dist/build.json by `npm run build` (scripts/write-build-info.mjs). */
export interface BuildInfo {
  version: string;
  /**
   * A hash of the code this build runs and ships (dist/**\/*.js and extension/); null when the build didn't
   * record one (then no restart is ever reported).
   */
  buildId: string | null;
}

/**
 * The build in `dir` (a dist/ folder): its build.json, written when it was built. Without a readable one,
 * the version of the package.json next to it (`dir/..`) and no build id.
 */
export function readBuildInfo(dir: string): BuildInfo {
  try {
    const info = JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
    if (typeof info?.version === "string" && typeof info.buildId === "string") return { version: info.version, buildId: info.buildId };
  } catch {
    // Missing or half written: fall back below.
  }
  const pkg = JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf8")) as { version: string };
  return { version: pkg.version, buildId: null };
}

/** Whether the build on disk differs from the running one, and if so, which it is (as get_version shows it). */
export type RestartState = { restartNeeded: false } | { restartNeeded: true; onDisk: { version: string; build: string } };

/** The line added to every tool error while a restart is needed; null when none is. */
export function restartHint(running: BuildInfo, state: RestartState): string | null {
  if (!state.restartNeeded) return null;
  return `mcp-teams was updated on disk (running ${running.version} ${running.buildId}, on disk ${state.onDisk.version} ${state.onDisk.build}): reconnect it with /mcp, then reload the extension.`;
}

/** How long a read of the build on disk is reused. */
export const BUILD_CHECK_CACHE_MS = 5_000;

/**
 * Compares the running build with the one in `dir` on disk, read again when asked but at most once per
 * BUILD_CHECK_CACHE_MS (by `now`). A restart is needed when the two build ids differ (not "newer": any
 * other build) or their versions do (every release bumps it, #100), never when either has no id.
 */
export function restartCheck(running: BuildInfo, dir: string, now: () => number = Date.now): () => RestartState {
  let last: { at: number; state: RestartState } | undefined;
  const read = (): RestartState => {
    if (!running.buildId) return { restartNeeded: false };
    let onDisk: BuildInfo;
    try {
      onDisk = readBuildInfo(dir);
    } catch {
      return { restartNeeded: false };
    }
    return onDisk.buildId && (onDisk.buildId !== running.buildId || onDisk.version !== running.version)
      ? { restartNeeded: true, onDisk: { version: onDisk.version, build: onDisk.buildId } }
      : { restartNeeded: false };
  };
  return () => {
    const at = now();
    if (!last || at - last.at >= BUILD_CHECK_CACHE_MS) last = { at, state: read() };
    return last.state;
  };
}
