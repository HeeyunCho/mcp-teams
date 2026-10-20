import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 3.5: scripts/measure-memory.mjs is run by hand (`npm run measure-memory`), not in CI. This
// runs it with small sizes, so it stays quick, and checks that it does the reads and prints
// one table row per scenario and process, with numbers.
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["scripts/measure-memory.mjs", ...args], { env, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe("3.5: measure-memory script", () => {
  it("3.5: reads a long transcript and a paged history through hub, peer and extension processes and prints their peaks", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-teams-measure-"));
    const r = await run(["--lines", "2000", "--messages", "200", "--page", "50"], { ...process.env, HOME: home, USERPROFILE: home });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);

    // The reads it measured, done in full.
    expect(r.stdout).toMatch(/^transcript: 2000 lines in \d+ pages\b/m);
    expect(r.stdout).toMatch(/^history: 200 messages in 4 pages\b/m);

    // | scenario | process | peak RSS (MB) | peak heapUsed (MB) |
    const rows = [...r.stdout.matchAll(/^\| (transcript|history) \| (hub|peer|extension) \| ([\d.]+) \| ([\d.]+) \|$/gm)];
    const seen = rows.map((m) => `${m[1]}/${m[2]}`).sort();
    expect(seen).toEqual(["history/extension", "history/hub", "history/peer", "transcript/extension", "transcript/hub", "transcript/peer"]);
    for (const m of rows) {
      const [rss, heap] = [Number(m[3]), Number(m[4])];
      expect(rss).toBeGreaterThan(0);
      expect(heap).toBeGreaterThan(0);
      expect(heap).toBeLessThan(rss);
    }

    // The run used its own token and port: nothing under the user's home.
    expect(existsSync(join(home, ".mcp-teams"))).toBe(false);
  }, 70_000);
});
