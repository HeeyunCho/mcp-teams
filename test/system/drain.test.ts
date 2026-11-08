// #112, with the built server (dist/): when the hub's AI session closes its stdin, a call another
// session's server is running through it still completes, and the hub exits within its bound.
// A signal still closes at once. Shapes from mcp-newoutlook test/system/drain.test.ts (PR #108
// there), with its loosened start timings for slow Windows boxes (241a573, 570368f).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { until } from "../helpers/timing.js";

const VERSION: string = JSON.parse(readFileSync("package.json", "utf8")).version;
/**
 * How long the hub may take to say it listens: 15 s, because a cold start takes about 5 s on a
 * busy Windows box and varies a lot. This wait only catches a hub that never listens.
 */
const HUB_LISTEN_MS = 15_000;
const CONVERSATION = "19:contoso-launch@thread.v2";

let hub: ChildProcess | undefined;
let peer: Client | undefined;
let ext: WebSocket | undefined;
afterEach(async () => {
  ext?.close();
  await peer?.close().catch(() => {});
  hub?.kill("SIGKILL");
  hub = peer = ext = undefined;
});

/** A config folder whose port is 0: the hub listens on a free port and keeps it. */
function home(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-teams-drain-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "tok", port: 0 }));
  return { ...process.env, TEAMS_MCP_HOME: dir, ...extraEnv } as Record<string, string>;
}

/** The hub: a server whose stdin the test closes, as an AI app does when its session ends. */
async function startHub(env: Record<string, string>) {
  const p = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "ignore", "pipe"] });
  let log = "";
  p.stderr!.on("data", (d) => (log += d));
  await until(() => /bridge listening on ws:\/\/127\.0\.0\.1:\d+/.test(log), HUB_LISTEN_MS, "the hub to listen");
  const port = Number(/bridge listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)![1]);
  return { p, port };
}

/** A fake extension that answers readMessages after delayMs (never, when null). */
function connectExtension(port: number, delayMs: number | null) {
  return new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://fake" });
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") ws.send(JSON.stringify({ type: "hello", token: "tok", version: VERSION, browser: "Chrome" }));
      if (msg.type === "welcome") resolve(ws);
      if (msg.type !== "request") return;
      if (msg.method !== "status" && delayMs === null) return;
      const result =
        msg.method === "status"
          ? { extensionVersion: VERSION, teamsTabs: 1 }
          : await new Promise((r) =>
              setTimeout(() => r({ conversation: { id: CONVERSATION, kind: "chat", title: "Launch" }, count: 1, messages: [{ id: "1", text: "Northwind offer" }] }), delayMs!),
            );
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
    });
  });
}

/** Another session's server, joined to the hub on `port` as a peer. */
async function startPeer(env: Record<string, string>, port: number) {
  const c = new Client({ name: "peer", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...env, TEAMS_MCP_PORT: String(port) }, stderr: "ignore" }));
  const role = async () => JSON.parse(((await c.callTool({ name: "get_version", arguments: {} })) as any).content[0].text).role;
  for (let i = 0; i < 100; i++) {
    if ((await role()) === "peer") return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the second server didn't join as a peer");
}

const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once("exit", (code) => r(code))));
const readMessages = (c: Client) => c.callTool({ name: "read_messages", arguments: { conversation: CONVERSATION } }) as Promise<any>;

// The hub's start, plus 25 s for a peer's start and the drain.
describe("#112: closing the hub's session", { timeout: HUB_LISTEN_MS + 25_000 }, () => {
  it("#112: a peer server's call in flight still completes, and the hub exits after it", async () => {
    const env = home();
    const started = await startHub(env);
    hub = started.p;
    ext = await connectExtension(started.port, 800);
    peer = await startPeer(env, started.port);

    const read = readMessages(peer);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    hub.stdin!.end();
    const r = await read;
    expect(r.isError ?? false, r.content?.[0]?.text).toBe(false);
    expect(JSON.parse(r.content[0].text).messages[0].text).toBe("Northwind offer");
    expect(await exited(hub)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("#112: a hub with nothing in flight exits at once", async () => {
    const started = await startHub(home());
    hub = started.p;
    const t0 = Date.now();
    hub.stdin!.end();
    expect(await exited(hub)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("#112: TEAMS_MCP_DRAIN_MS bounds the wait for a call that doesn't end", async () => {
    const env = home({ TEAMS_MCP_DRAIN_MS: "500" });
    const started = await startHub(env);
    hub = started.p;
    ext = await connectExtension(started.port, null);
    peer = await startPeer(env, started.port);

    const read = readMessages(peer);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    hub.stdin!.end();
    expect(await exited(hub)).toBe(0);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(400);
    expect(took).toBeLessThan(3_000);
    const r = await read;
    expect(r.isError).toBe(true);
  });

  it("#112: SIGTERM still closes the hub at once, with a call in flight", async () => {
    const env = home();
    const started = await startHub(env);
    hub = started.p;
    ext = await connectExtension(started.port, null);
    peer = await startPeer(env, started.port);

    void readMessages(peer).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    hub.kill("SIGTERM");
    await exited(hub);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
