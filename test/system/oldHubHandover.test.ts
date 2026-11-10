// #123 decision 8: a server from before the native host (here the real, published
// mcp-teams@0.3.52) holds the TCP port as the hub. The native host joins it as a peer of a newer
// version, so that old hub's own stepDown hands the port over; the host then holds the port, for
// peers only, and the old server comes back as its peer there.
//
// It installs mcp-teams@0.3.52 from npm into a temporary folder (with --ignore-scripts), so it
// needs the network. Offline it skips (npmVerdict, test/helpers/offline.ts): when registry.npmjs.org
// doesn't resolve within 5 s, when npm fails with ENOTFOUND, EAI_AGAIN or ECONNREFUSED, or with
// ECONNRESET or ETIMEDOUT once the registry no longer resolves either. With CI set it fails instead.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../../src/config.js";
import { fakeExtension, TOKEN } from "../helpers/bridgeHarness.js";
import { nativeHarness } from "../helpers/nativeHost.js";
import { npmVerdict, registryResolves, type Verdict } from "../helpers/offline.js";
import { until } from "../helpers/timing.js";

const OLD = "0.3.52";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("#123 decision 8: an old TCP hub hands over to the native host", () => {
  it(`#123: the real mcp-teams@${OLD} on the port hands it to the host and joins it as a peer`, { timeout: 540_000 }, async (ctx) => {
    const ci = !!process.env.CI;
    const decide = (v: Verdict) => {
      if (v.verdict === "fail") throw new Error(v.reason);
      if (v.verdict === "skip") {
        console.warn(`skipped: ${v.reason}`);
        ctx.skip(v.reason);
      }
    };
    if (!(await registryResolves())) decide(npmVerdict(undefined, { ci, resolves: false }));
    const dir = mkdtempSync(join(tmpdir(), "mt-old-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // npm's own script next to this node when it is there (no shell needed for npm.cmd on Windows).
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const args = ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", "--prefix", dir, `mcp-teams@${OLD}`];
    const install = existsSync(npmCli)
      ? spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8", timeout: 420_000 })
      : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { encoding: "utf8", timeout: 420_000, shell: process.platform === "win32" });
    const run = { status: install.status, signal: install.signal, stderr: `${install.stderr ?? ""}${install.error?.message ?? ""}` };
    if (run.status !== 0) decide(npmVerdict(run, { ci, resolves: await registryResolves() }));

    // The old server, as an AI app starts it: its own home (pairing token, port 0), stdin open.
    const oldHome = join(dir, "home");
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, "config.json"), JSON.stringify({ token: TOKEN, port: 0 }));
    const old: ChildProcessWithoutNullStreams = spawn(process.execPath, [join(dir, "node_modules", "mcp-teams", "dist", "index.js")], {
      env: { ...process.env, TEAMS_MCP_HOME: oldHome, TEAMS_MCP_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const oldExited = new Promise((r) => old.once("exit", r));
    cleanups.push(async () => {
      old.stdin.end(); // the session ends: it drains (#112) and exits
      setTimeout(() => old.kill("SIGKILL"), 8_000).unref();
      await oldExited;
    });
    let stderr = "";
    old.stderr.on("data", (d) => (stderr += d));
    await until(() => /bridge listening on ws:\/\/127\.0\.0\.1:\d+/.test(stderr), 20_000, `mcp-teams ${OLD} listening`);
    expect(stderr).toContain(`[mcp-teams ${OLD}]`);
    const port = Number(/bridge listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)![1]);

    // The native host, configured for that port.
    const h = await nativeHarness();
    cleanups.push(() => h.cleanup());
    const ext = await h.host({ env: { TEAMS_MCP_PORT: String(port) } });
    expect(ext.welcome).toMatchObject({ type: "welcome", serverVersion: SERVER_VERSION });

    // The old hub's own handover (its stepDown(): it saw a newer peer) ...
    await until(() => stderr.includes(`handing the bridge to mcp-teams ${SERVER_VERSION}`), 10_000, "the old hub handing over");
    // ... frees the port, which the host takes ...
    expect(await h.hostPort()).toBe(port);
    expect(h.logText()).toMatch(new RegExp(` tcp handover=${OLD.replace(/\./g, "\\.")}`));
    // ... and the old server comes back as the host's peer there (after its 2 s retry).
    await until(() => new RegExp(` peer version=${OLD.replace(/\./g, "\\.")} via=tcp`).test(h.logText()), 15_000, `mcp-teams ${OLD} as the host's peer`);
    // An extension on the port is refused now: the host takes it only over native messaging.
    await expect(fakeExtension(port, { reconnect: false })).rejects.toThrow(/extension refused \(4403\)/);
    expect(ext.exitCode).toBeUndefined();
  });
});
