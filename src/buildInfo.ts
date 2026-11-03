import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Which build of mcp-teams this is: written to dist/build.json by `npm run build` (scripts/write-build-info.mjs). */
export interface BuildInfo {
  version: string;
  /** A hash of the built code; null when the build didn't record one (then no restart is ever reported). */
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

/** Whether the build on disk differs from the running one, and if so, which it is. */
export type RestartState = { restartNeeded: false } | { restartNeeded: true; onDisk: BuildInfo };

/**
 * Compares the running build with the one in `dir` on disk, read again when asked. A restart is needed
 * when the two build ids differ (not "newer": any other build), never when either has no id.
 */
export function restartCheck(running: BuildInfo, dir: string): () => RestartState {
  return () => {
    let onDisk: BuildInfo;
    try {
      onDisk = readBuildInfo(dir);
    } catch {
      return { restartNeeded: false };
    }
    return running.buildId && onDisk.buildId && onDisk.buildId !== running.buildId ? { restartNeeded: true, onDisk } : { restartNeeded: false };
  };
}
