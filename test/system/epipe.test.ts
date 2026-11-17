// #215: a client that goes away must not make the server loop on EPIPE.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../helpers/timing.js";

const dirs: string[] = [];
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("#215: closed stdout", () => {
  it("logs at most one EPIPE crash and exits with a clear reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "mt-epipe-"));
    dirs.push(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", port: 0 }));
    const logFile = join(home, "server.log");
    const env = { ...process.env, TEAMS_MCP_HOME: home, TEAMS_MCP_DRAIN_MS: "0" } as Record<string, string>;
    const p = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
    child = p;
    let stderr = "";
    p.stderr!.on("data", (d) => (stderr += d.toString()));
    await until(() => /bridge listening on/.test(stderr), 15_000, "server to listen");

    // A real MCP initialize makes the server write a response to stdout.
    p.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 400));

    // The AI client disappears: its stdout pipe is destroyed.
    p.stdout!.destroy();
    // Another request would need a response the pipe can no longer take.
    p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");

    const exited = await Promise.race([
      new Promise<number | null>((done) => p.once("exit", (code) => done(code))),
      new Promise<null>((done) => setTimeout(() => done(null), 8_000)),
    ]);
    expect(exited).not.toBeNull();
    const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : [];
    const epipes = lines.filter((l) => /uncaught-exception/.test(l) && /EPIPE|ERR_STREAM_DESTROYED/.test(l));
    expect(epipes.length).toBeLessThanOrEqual(1);
    expect(lines.some((l) => /exit.*stdout-closed|exit.*EPIPE/.test(l))).toBe(true);
  }, 25_000);
});
