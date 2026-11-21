// mcp-newoutlook #288, with the built server (dist/): a server whose session is gone ends within
// 5 s however it went (its parent exited, its stdin closed, its stdout broke, a signal), and
// server.log says which. Before, orphans kept running under PID 1 and ignored SIGTERM.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processExists } from "../../src/lifecycle.js";
import { until } from "../helpers/timing.js";

/** As in drain.test.ts: a cold start can take about 5 s on a busy Windows box. */
const LISTEN_MS = 15_000;
const LISTENING = /bridge listening on ws:\/\/127\.0\.0\.1:\d+/;

const dirs: string[] = [];
const procs: ChildProcess[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const pid of pids.splice(0)) if (processExists(pid)) process.kill(pid, "SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A config folder whose port is 0, and its server.log's exit line once there is one. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "mt-gone-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "tok", port: 0 }));
  const log = join(dir, "server.log");
  const exit = () => (existsSync(log) ? (readFileSync(log, "utf8").split("\n").find((l) => / exit /.test(l)) ?? null) : null);
  return { env: { ...process.env, TEAMS_MCP_HOME: dir } as Record<string, string>, exit };
}

/**
 * The server, with its stdin, stdout and stderr piped to this test, once it answers a ping: it then
 * takes MCP calls and has its signal handlers.
 */
async function startServer(env: Record<string, string>) {
  const p = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p);
  let stderr = "";
  let stdout = "";
  p.stderr!.on("data", (d) => (stderr += d));
  p.stdout!.on("data", (d) => (stdout += d));
  await until(() => LISTENING.test(stderr), LISTEN_MS, "the server to listen");
  p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) + "\n");
  await until(() => /"id":0/.test(stdout), 5_000, "the server to answer a ping");
  return { p, stderr: () => stderr };
}

/**
 * A stand-in for the AI app (the client, which the test kills): it starts the server, directly or
 * through a stand-in for `npm exec` that ends when its child does. A second child of the client
 * holds the write end of the server's stdin, so the server never sees EOF there. The server's
 * stderr goes to a file: the client's pipe breaks when it is killed.
 */
async function underClient(env: Record<string, string>, throughNpmExec: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "mt-gone-chain-"));
  dirs.push(dir);
  const errFile = join(dir, "stderr.txt");
  const pidFile = join(dir, "server.pid");
  const server = JSON.stringify(resolve("dist/index.js"));
  const wrapper = `
    const c = require("node:child_process").spawn(process.execPath, [${server}], { stdio: "inherit" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
    c.on("exit", (code) => process.exit(code ?? 1));
  `;
  const client = `
    const { spawn } = require("node:child_process");
    const errFd = require("node:fs").openSync(${JSON.stringify(errFile)}, "a");
    const c = spawn(process.execPath, ${throughNpmExec ? `["-e", ${JSON.stringify(wrapper)}]` : `[${server}]`}, { stdio: ["pipe", "ignore", errFd] });
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore", c.stdin] });
    process.stderr.write("child=" + c.pid + " holder=" + holder.pid + "\\n");
  `;
  const p = spawn(process.execPath, ["-e", client], { env, stdio: ["ignore", "ignore", "pipe"] });
  procs.push(p);
  let stderr = "";
  p.stderr!.on("data", (d) => (stderr += d));
  const serverErr = () => (existsSync(errFile) ? readFileSync(errFile, "utf8") : "");
  await until(() => LISTENING.test(serverErr()) && /holder=\d+/.test(stderr), LISTEN_MS, "the server to listen");
  const [, child, holder] = /child=(\d+) holder=(\d+)/.exec(stderr)!.map(Number);
  const serverPid = throughNpmExec ? Number(readFileSync(pidFile, "utf8")) : child;
  pids.push(serverPid, child, holder);
  return { client: p, server: serverPid, holder, wrapper: throughNpmExec ? child : undefined };
}

const exited =(p: ChildProcess) =>
  new Promise<{ code: number | null; signal: string | null }>((r) =>
    p.exitCode !== null || p.signalCode !== null ? r({ code: p.exitCode, signal: p.signalCode }) : p.once("exit", (code, signal) => r({ code, signal })),
  );

describe("mcp-newoutlook #288: a server whose session is gone", { timeout: LISTEN_MS + 15_000 }, () => {
  it("is gone within 5 s once its parent exits, though its stdin stays open", async () => {
    const { env, exit } = home();
    const { client, server, holder } = await underClient(env, false);
    const t0 = Date.now();
    client.kill("SIGKILL");
    await until(() => !processExists(server), 5_000, "the orphaned server to exit");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(processExists(holder)).toBe(true); // its stdin never closed
    await until(() => exit() !== null, 2_000, "the exit in server.log");
    expect(exit()).toMatch(/ reason=parent-gone code=0$/);
  });

  // Under `npx -y mcp-teams@latest`, npm exec sits between the AI app and the server, and outlives
  // a killed AI app under PID 1 with the server still under it. (Windows doesn't reparent: there the
  // parent's PID going away is what counts.)
  it.skipIf(process.platform === "win32")("is gone within 5 s once the AI app above npm exec is killed, though npm exec still runs", async () => {
    const { env, exit } = home();
    const { client, server, holder, wrapper } = await underClient(env, true);
    const t0 = Date.now();
    client.kill("SIGKILL");
    await until(() => !processExists(server), 5_000, "the server under the orphaned npm exec to exit");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(processExists(holder)).toBe(true); // its stdin never closed
    await until(() => exit() !== null, 2_000, "the exit in server.log");
    expect(exit()).toMatch(/ reason=parent-gone code=0$/);
    await until(() => !processExists(wrapper!), 2_000, "npm exec to exit after its child");
  });

  it("is gone within 5 s once its stdin closes", async () => {
    const { env, exit } = home();
    const { p } = await startServer(env);
    const t0 = Date.now();
    p.stdin!.end();
    expect((await exited(p)).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(exit()).toMatch(/ reason=stdin-closed code=0$/);
  });

  it("exits once its stdout breaks, instead of logging every failed write as an uncaught exception", async () => {
    const { env, exit } = home();
    const { p, stderr } = await startServer(env);
    p.stdout!.destroy();
    // A request the server answers on stdout, which now fails with EPIPE.
    const t0 = Date.now();
    for (let id = 1; id <= 20; id++) p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");
    expect((await exited(p)).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(stderr()).not.toMatch(/uncaught exception/);
    expect(exit()).toMatch(/ reason=stdout-(epipe|error) code=0$/);
  });
});

// Windows has no SIGTERM or SIGHUP to catch: kill() there ends the process outright.
describe.skipIf(process.platform === "win32")("mcp-newoutlook #288: a signal", { timeout: LISTEN_MS + 15_000 }, () => {
  it.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)("%s exits with 0 within 5 s and says so in server.log", async (signal) => {
    const { env, exit } = home();
    const { p } = await startServer(env);
    const t0 = Date.now();
    p.kill(signal);
    expect(await exited(p)).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(exit()).toMatch(new RegExp(` reason=${signal} code=0$`));
  });
});
