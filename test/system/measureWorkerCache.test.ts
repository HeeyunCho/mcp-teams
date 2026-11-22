import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

// #190: scripts/measure-worker-cache.mjs is run by hand, not in CI. This runs it with small
// sizes, so it stays quick, and checks that it loads the worker, fills its transcript cache and
// prints one table row with numbers.
const run = (args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--expose-gc", "scripts/measure-worker-cache.mjs", ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe("#190: measure-worker-cache script", () => {
  it("#190: reads transcripts into the real worker's cache and prints the heap it holds against its count", async () => {
    const r = await run(["--transcripts", "2", "--entries", "50", "--runs", "1"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^2 transcripts of 50 entries \([\d.]+ MB of response text\); 1 runs; node v/m);
    // | heap held | spread | count | heap / count | heap per entry | count per entry | beyond strings |
    const row = /^\| ([\d.]+) \| ([\d.]+)-([\d.]+) \| ([\d.]+) \| ([\d.]+) \| (\d+) \| (\d+) \| (-?\d+) \|$/m.exec(r.stdout);
    expect(row).not.toBeNull();
    const [heapPerEntry, countPerEntry] = [Number(row![6]), Number(row![7])];
    expect(heapPerEntry).toBeGreaterThan(0);
    expect(countPerEntry).toBeGreaterThan(128); // the per-entry cost plus the strings
  }, 70_000);

  it("#190: a flag without a value is refused", async () => {
    const r = await run(["--entries"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--entries needs a value/);
  });
});
