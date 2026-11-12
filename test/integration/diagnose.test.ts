// #143: what the bridge tells server.log (BridgeOptions.diagnose): its role and how it got it, the
// hand-over to a newer server, the extensions coming and going (with the close code), and, as a
// peer, the hub closing. Real sockets, the harness's FAST timings. And (#153) what get_version's
// status read writes to server.log, against a scripted bridge.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { proof } from "../../src/bridge.js";
import { EXTENSION_ORIGIN } from "../../src/extension.js";
import { diagnosticLog } from "../../src/serverLog.js";
import { registerTools } from "../../src/tools.js";
import { bridgeHarness, TOKEN, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

type Event = { event: string; fields: Record<string, unknown> };
let h: BridgeHarness;
afterEach(() => h?.cleanup());

const recorder = () => {
  const events: Event[] = [];
  const diagnose = (event: string, fields: Record<string, unknown> = {}) =>
    events.push({ event, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  return { events, diagnose };
};

describe("#143: the bridge's diagnostic events", () => {
  it("reports the hub's role, the extension connecting and closing with its code, and its transport", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose });
    const ext = await h.extension({ version: "0.3.62" });
    await until(() => events.some((e) => e.event === "extensions" && e.fields.count === 1), 3_000, "the extension's arrival");
    await ext.close();
    await until(() => events.some((e) => e.event === "extension-closed"), 3_000, "the extension's close");
    expect(events).toEqual([
      { event: "role", fields: { role: "hub", via: "tcp" } },
      { event: "extension-connected", fields: { ext: "0.3.62", transport: "websocket" } },
      { event: "extensions", fields: { count: 1, transport: "websocket" } },
      { event: "extension-closed", fields: { code: 1005, transport: "websocket" } },
      { event: "extensions", fields: { count: 0 } },
    ]);
  });

  it("reports every connect with the extension's version, also a reconnect that changes no count", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose });
    const first = await h.extension({ version: "0.3.61", instance: "profile-1", reconnect: false });
    await h.extension({ version: "0.3.62", instance: "profile-1", reconnect: false }); // replaces the first
    await until(() => events.filter((e) => e.event === "extension-connected").length === 2, 3_000, "both connects");
    expect(events.filter((e) => e.event.startsWith("extension-"))).toEqual([
      { event: "extension-connected", fields: { ext: "0.3.61", transport: "websocket" } },
      { event: "extension-closed", fields: { code: 4000, transport: "websocket" } },
      { event: "extension-connected", fields: { ext: "0.3.62", transport: "websocket" } },
    ]);
    void first;
  });

  it("reports a handshake the hub turned away, with its code, before any extension was accepted", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose });
    await expect(h.extension({ token: "not-the-token", reconnect: false })).rejects.toThrow(/4401/);
    await until(() => events.some((e) => e.event === "handshake-closed"), 3_000, "the refused handshake");
    expect(events.find((e) => e.event === "handshake-closed")).toMatchObject({ event: "handshake-closed", fields: { code: 4401, reason: "bad token", via: "tcp", hello: "hello" } });
    expect(events.some((e) => e.event === "extension-closed")).toBe(false);
  });

  it("reports an extension the hub dropped for not answering its pings as dropped, not by a close code", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose });
    await h.extension({ pong: false, reconnect: false });
    await until(() => events.some((e) => e.event === "extension-dropped"), 3_000, "the drop");
    expect(events.find((e) => e.event === "extension-dropped")).toEqual({ event: "extension-dropped", fields: { reason: "no-pong", transport: "websocket" } });
    expect(events.some((e) => e.event === "extension-closed")).toBe(false);
  });

  it("reads a background status from the extension calls go to, without moving calls to another browser", async () => {
    h = await bridgeHarness();
    const hub = await h.session("1.0.0");
    const status = (captured: boolean) => () => ({ teamsTabs: 1, sessions: [{ sessionCaptured: captured }] });
    await h.extension({ instance: "with-session", handle: status(true) });
    await h.extension({ instance: "without", handle: status(false) });
    await until(() => hub.extensions.length === 2, 3_000, "both browsers");
    const before = hub.extension;
    expect(before?.instance).toBe("without"); // the newest, until a call picks one
    expect(await hub.backgroundStatus(1_000)).toEqual({ teamsTabs: 1, sessions: [{ sessionCaptured: false }] });
    expect(hub.extension?.instance).toBe("without");
    // A real call still picks the browser with the session.
    expect(await hub.call("status", {})).toEqual({ teamsTabs: 1, sessions: [{ sessionCaptured: true }] });
  });

  it("reports a peer's role with its hub's version, the hand-over to a newer server, and the hub closing", async () => {
    h = await bridgeHarness();
    const old = recorder();
    const peer = recorder();
    await h.session("1.0.0", { diagnose: old.diagnose });
    await h.session("1.0.0", { diagnose: peer.diagnose });
    expect(peer.events.find((e) => e.event === "role")).toEqual({ event: "role", fields: { role: "peer", via: "tcp", hub: "1.0.0" } });
    await h.session("2.0.0");
    await until(() => old.events.some((e) => e.event === "handover"), 5_000, "the old hub's hand-over");
    expect(old.events.find((e) => e.event === "handover")).toEqual({ event: "handover", fields: { to: "2.0.0" } });
    // The old hub let go: it becomes none, then a peer of whoever took the port (or the hub again,
    // if it won the race, until the newer server steps it down in turn).
    await until(() => old.events.filter((e) => e.event === "role").length >= 3, 5_000, "the old hub's next role");
    expect(old.events.filter((e) => e.event === "role").map((e) => e.fields.role).slice(0, 2)).toEqual(["hub", "none"]);
    await until(() => peer.events.some((e) => e.event === "hub-closed"), 5_000, "the peer seeing the hub close");
    expect(peer.events.find((e) => e.event === "hub-closed")?.fields.code).toEqual(expect.any(Number));
  });

  it("keeps working when the log throws", async () => {
    h = await bridgeHarness();
    const hub = await h.session("1.0.0", {
      diagnose: () => {
        throw new Error("disk full");
      },
    });
    await h.extension({ handle: () => ({ ok: 1 }) });
    await until(() => hub.connected, 3_000, "the extension");
    expect(await hub.call("status", {})).toEqual({ ok: 1 });
  });
});

/**
 * A raw client on the hub's port that answers the challenge with `hello` (when given) and sends
 * nothing else. Resolves, once the hub closed it, with the port it connected from and the code.
 */
function refusedClient(port: number, hello?: Record<string, unknown>, origin?: string) {
  return new Promise<{ port: number; code: number }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    let from = 0;
    socket.on("open", () => (from = (socket as any)._socket.localPort));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge" && hello) socket.send(JSON.stringify(hello));
    });
    socket.on("error", reject);
    socket.on("close", (code) => resolve({ port: from, code }));
  });
}

// #156: several refusals share 4401, so handshake-closed says which one it was (from the close
// reasons the bridge itself sends), how long the connection was open, and which hello it sent.
describe("#156: why a handshake was refused", () => {
  const AUTH_MS = 300;
  const closed = async (events: Event[]) => {
    await until(() => events.some((e) => e.event === "handshake-closed"), 5_000, "the refused handshake");
    return events.find((e) => e.event === "handshake-closed")!.fields;
  };

  it("says a client that sent no hello hit the auth timeout, after authTimeoutMs, and the port it came from", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose, authTimeoutMs: AUTH_MS });
    const client = await refusedClient(h.port, undefined, EXTENSION_ORIGIN);
    const fields = await closed(events);
    expect(client.code).toBe(4401);
    expect(fields).toMatchObject({ code: 4401, reason: "auth timeout", via: "tcp", hello: "none", port: client.port });
    expect(fields.ms).toBeGreaterThanOrEqual(AUTH_MS);
    expect(Object.keys(fields)).toEqual(["code", "reason", "via", "ms", "hello", "port"]);
  });

  it("says a hello with a wrong proof had a bad token, well before the auth timeout", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose, authTimeoutMs: 10_000 });
    await refusedClient(h.port, { type: "hello", proof: proof("not-the-token", "client", "x"), nonce: "n", version: "0.3.66" }, EXTENSION_ORIGIN);
    const fields = await closed(events);
    expect(fields).toMatchObject({ code: 4401, reason: "bad token", via: "tcp", hello: "hello" });
    expect(fields.ms).toBeLessThan(10_000);
  });

  it("says which hello it was: a peer-hello with a wrong proof", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose, authTimeoutMs: 10_000 });
    await refusedClient(h.port, { type: "peer-hello", proof: proof("not-the-token", "client", "x"), nonce: "n", version: "1.0.0" });
    const fields = await closed(events);
    expect(fields).toMatchObject({ code: 4401, reason: "bad token", via: "tcp", hello: "peer-hello" });
  });

  it("still names the auth timeout when the client never answers the close (a stalled worker)", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose, authTimeoutMs: AUTH_MS });
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}`, { origin: EXTENSION_ORIGIN });
    socket.on("error", () => {});
    // After the challenge, the next bytes are the hub's close frame: drop the connection without
    // sending a close back, so the hub's close event carries no code or reason of its own (1006).
    // ws has no public way to stop it answering a close, so this reaches into its socket.
    socket.once("message", () => {
      const raw = (socket as any)._socket;
      raw.removeAllListeners("data");
      raw.once("data", () => raw.destroy());
    });
    const fields = await closed(events);
    expect(fields).toMatchObject({ code: 4401, reason: "auth timeout", via: "tcp", hello: "none" });
  });

  it("logs reason other when the client closed first, even with one of the hub's own reasons", async () => {
    h = await bridgeHarness();
    const { events, diagnose } = recorder();
    await h.session("1.0.0", { diagnose, authTimeoutMs: 10_000 });
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}`, { origin: EXTENSION_ORIGIN });
    socket.on("error", () => {});
    socket.once("message", () => socket.close(4401, "bad token")); // the client's words, not the hub's
    const fields = await closed(events);
    expect(fields).toMatchObject({ code: 4401, reason: "other", via: "tcp", hello: "none" });
  });
});

// #153: get_version's status read (up to the bridge's default minute) is timed too, so an answer
// that took 5-20 s, which no tool line shows, is in server.log. The tools against a scripted bridge.
describe("#153: get_version's status read in server.log", () => {
  const dirs: string[] = [];
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** server.log's teams lines after one get_version whose status read is `read`. */
  async function teamsLines(read: () => Promise<unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "mt-diag-"));
    dirs.push(dir);
    const file = join(dir, "server.log");
    const diagnostics = diagnosticLog({ file, version: "0.3.65", role: () => "peer", slowStatusMs: 50 });
    const bridge = {
      connected: true,
      extension: { version: "0.3.65", browser: "Chrome" },
      extensions: [{ version: "0.3.65", browser: "Chrome" }],
      listenError: null,
      role: "peer",
      port: 0,
      hubVersion: "0.3.65",
      call: (method: string) => (method === "status" ? read() : Promise.reject(new Error(`unexpected ${method}`))),
    } as unknown as Parameters<typeof registerTools>[1];
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, bridge, { port: 0, token: TOKEN }, { diagnostics });
    client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "get_version", arguments: {} });
    return (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []).filter((l) => / teams /.test(l)).map((l) => l.replace(/^\S+ pid=\d+ /, ""));
  }
  const later = <T>(ms: number, value: () => T) => new Promise<T>((done) => setTimeout(() => done(value()), ms));

  it("logs a slow answer with its ms", async () => {
    const lines = await teamsLines(() => later(120, () => ({ teamsTabs: 1, sessions: [{ sessionCaptured: true }], services: { chatsvc: "2026-11-11T00:00:00Z" } })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^teams v=0\.3\.65 role=peer tabs=1 captured=yes services=chatsvc account=none ms=\d+ slow=yes$/);
    expect(Number(/ ms=(\d+)/.exec(lines[0])?.[1])).toBeGreaterThanOrEqual(100);
  });

  it("logs a failed read with its kind and ms, not its message", async () => {
    const lines = await teamsLines(() => later(60, () => 0).then(() => Promise.reject(new Error("Extension call 'status' timed out"))));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^teams v=0\.3\.65 role=peer status=unreadable kind=timeout ms=\d+ failures=1$/);
    expect(Number(/ ms=(\d+)/.exec(lines[0])?.[1])).toBeGreaterThanOrEqual(50);
  });
});
