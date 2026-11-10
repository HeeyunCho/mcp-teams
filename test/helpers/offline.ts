// Whether a test that installs from npm (test/system/oldHubHandover.test.ts) runs, skips as
// offline, or fails. In CI (process.env.CI set) it never skips, so CI really checks it.
import { lookup } from "node:dns/promises";

export interface NpmRun {
  status: number | null;
  signal: string | null;
  stderr: string;
}

export type Verdict = { verdict: "run" } | { verdict: "skip"; reason: string } | { verdict: "fail"; reason: string };

/** npm error codes that mean this machine can't reach the registry at all. */
const UNREACHABLE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/;
/** Codes an online machine sees too (a flaky connection): offline only once the registry no longer resolves. */
const FLAKY = /\b(ECONNRESET|ETIMEDOUT)\b/;

/**
 * The verdict on an npm install. `run`: undefined when it didn't run (the registry didn't resolve
 * first). `resolves`: whether registry.npmjs.org resolves now. `ci`: in CI, never skip.
 */
export function npmVerdict(run: NpmRun | undefined, { ci, resolves }: { ci: boolean; resolves: boolean }): Verdict {
  const offline = (reason: string): Verdict => (ci ? { verdict: "fail", reason: `${reason} (in CI this test must run)` } : { verdict: "skip", reason: `offline: ${reason}` });
  if (!run) return offline("registry.npmjs.org does not resolve");
  if (run.status === 0) return { verdict: "run" };
  const last = run.stderr.trim().split("\n").at(-1) ?? "";
  if (run.signal) return { verdict: "fail", reason: `npm install ran past its time limit (${run.signal})` };
  if (UNREACHABLE.test(run.stderr) || (FLAKY.test(run.stderr) && !resolves)) return offline(`npm install failed (${last})`);
  return { verdict: "fail", reason: `npm install failed:\n${run.stderr}` };
}

/** True when registry.npmjs.org resolves within 5 s. */
export async function registryResolves(): Promise<boolean> {
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 5_000).unref());
  return Promise.race([lookup("registry.npmjs.org").then(() => true, () => false), timeout]);
}
