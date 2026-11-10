// #123 (ADR 0001): the bridge as the native host, in-process. It is the hub on the hub socket
// (a Unix socket, or a named pipe on Windows) with the extension's native port attached, and
// listens on the TCP port for peers only. Servers whose config enables the native host
// (hubSocket) join it there first, and leave a TCP hub for it once it has the extension. The
// host process itself (dist/hub.js) is covered by test/system/nativeHost.test.ts.
// Ported from mcp-newoutlook test/integration/hubsocket.test.ts (commit aa0a7a5).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionBridge, proof, type BridgeOptions } from "../../src/bridge.js";
import { EXTENSION_ORIGIN } from "../../src/extension.js";
import { FrameDecoder, NativePort } from "../../src/native.js";
import { fakeExtension, FAST, TOKEN } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const unixOnly = it.skipIf(process.platform === "win32");

/** A hub socket of its own: a Unix socket in a temporary folder, or a named pipe named after it. */
function tempSocket() {
  const dir = mkdtempSync(join(tmpdir(), "mt-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, "hub.sock");
}

function bridge(port: number, version: string, extra: BridgeOptions = {}) {
  const b = new ExtensionBridge(port, TOKEN, version, { ...FAST, ...extra });
  cleanups.push(() => b.close());
  return b;
}

/** The native host's bridge: the hub on `hostSocket`, peers only on TCP `port` (0: a free one). */
async function host(hostSocket: string, extra: BridgeOptions = {}, port = 0, version = "1.0.0") {
  const b = bridge(port, version, { hostSocket, features: ["native"], socketNeedsProof: false, tcpRetryMs: 300, ...extra });
  await b.start();
  return b;
}

/** A server's bridge; with hubSocket it looks for the native host there (config nativeHost). */
async function server(port: number, version = "1.0.0", extra: BridgeOptions = {}) {
  const b = bridge(port, version, extra);
  await b.start();
  return b;
}

/** True when something accepts connections on the TCP port. */
const tcpListening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

/**
 * A raw client on the hub socket: answers the challenge with `hello` (plus a proof of `token`,
 * when given, made for the socket's label unless `role` says otherwise) and resolves with the
 * next message or the close code.
 */
function rawClient(path: string, hello: object, token?: string, role: "client" | "client:socket" = "client:socket"): Promise<{ msg?: any; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost/", { createConnection: () => connect(path) });
    cleanups.push(() => ws.close());
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") return ws.send(JSON.stringify({ ...hello, ...(token ? { proof: proof(token, role, msg.nonce) } : {}) }));
      resolve({ msg });
    });
    ws.on("close", (code) => resolve({ code }));
    ws.on("error", () => {});
  });
}

/** The extension attached as the host's native port, over in-memory pipes (Chrome's framing). */
function nativeExtension(b: ExtensionBridge, hello: object = { type: "hello", version: "0.3.56", browser: "Chrome", instance: "profile-1" }) {
  const toExtension = new PassThrough();
  const port = new NativePort(toExtension);
  const received: any[] = [];
  // Records every message, and answers every request (but "never") as Teams would, naming the method.
  const decoder = new FrameDecoder((f) => {
    const m = JSON.parse(f.toString("utf8"));
    received.push(m);
    if (m.type === "request" && m.method !== "never") port.receive(Buffer.from(JSON.stringify({ type: "response", id: m.id, ok: true, result: { via: "native", method: m.method } })));
  });
  toExtension.on("data", (d: Buffer) => decoder.push(d));
  b.attachExtension(port);
  port.receive(Buffer.from(JSON.stringify(hello)));
  cleanups.push(() => port.close());
  return { port, received };
}

/** A program that holds a TCP port and drops every connection (not an mcp-teams hub). */
async function rawHolder(): Promise<{ server: Server; port: number }> {
  const s = createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => (s.listening ? new Promise((r) => s.close(r)) : undefined));
  return { server: s, port: (s.address() as { port: number }).port };
}

describe("#123: the native host's hub socket", () => {
  it("#123: takes peers without a proof where the socket is owner-only (a Unix socket)", async () => {
    const path = tempSocket();
    const hub = await host(path, { socketNeedsProof: false });
    expect(hub.role).toBe("hub");
    const r = await rawClient(path, { type: "peer-hello", version: "1.0.0" });
    expect(r.msg).toMatchObject({ type: "peer-welcome", capabilities: { features: expect.arrayContaining(["native", "checksSend"]) } });
  });

  it("#123 decision 10: on a named pipe (anyone may open it), peers must prove the pairing token", async () => {
    const path = tempSocket();
    await host(path, { socketNeedsProof: true });
    expect(await rawClient(path, { type: "peer-hello", version: "1.0.0" })).toEqual({ code: 4401 });
    expect(await rawClient(path, { type: "peer-hello", version: "1.0.0" }, "another-token")).toEqual({ code: 4401 });
    expect((await rawClient(path, { type: "peer-hello", version: "1.0.0" }, TOKEN)).msg?.type).toBe("peer-welcome");
  });

  it("#123: a proof made for the TCP port doesn't count on the pipe, nor does the bare token", async () => {
    const path = tempSocket();
    await host(path, { socketNeedsProof: true });
    expect(await rawClient(path, { type: "peer-hello", version: "1.0.0" }, TOKEN, "client")).toEqual({ code: 4401 });
    expect(await rawClient(path, { type: "hello", version: "0.3.56", browser: "Edge", instance: "p" }, TOKEN, "client")).toEqual({ code: 4401 });
    expect(await rawClient(path, { type: "peer-hello", version: "1.0.0", token: TOKEN })).toEqual({ code: 4401 });
  });

  it("#123: a program squatting the TCP port can't relay the pipe's challenge to the host's own join and get in", async () => {
    const path = tempSocket();
    // The squatter: on every connection to the port (the host joining what it takes for an old
    // hub), it opens the pipe, takes the pipe's challenge nonce as its own, and relays the answer.
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => new Promise((r) => wss.close(r)));
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    const outcome: { code?: number; msg?: any; relayed?: boolean }[] = [];
    wss.on("connection", (victim) => {
      const pipe = new WebSocket("ws://localhost/", { createConnection: () => connect(path) });
      cleanups.push(() => pipe.close());
      const result: { code?: number; msg?: any; relayed?: boolean } = {};
      outcome.push(result);
      pipe.on("error", () => {});
      pipe.on("close", (code) => (result.code ??= code));
      pipe.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") return victim.send(JSON.stringify({ type: "challenge", nonce: msg.nonce }));
        result.msg ??= msg;
      });
      victim.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "peer-hello") return;
        result.relayed = true;
        pipe.send(JSON.stringify({ ...msg, version: "1.0.0" }));
      });
    });
    await host(path, { socketNeedsProof: true, tcpRetryMs: 200 }, port, "0.3.56");
    await until(() => outcome.some((o) => o.relayed && (o.code !== undefined || o.msg)), 5_000, "the relayed answer on the pipe");
    const tried = outcome.find((o) => o.relayed)!;
    expect(tried.msg?.type).not.toBe("peer-welcome");
    expect(tried.code).toBe(4401);
  });

  it("#123: a browser page can't reach the socket (any Origin header is refused)", async () => {
    const path = tempSocket();
    await host(path);
    const code = await new Promise<number | string>((resolve) => {
      const ws = new WebSocket("ws://localhost/", { createConnection: () => connect(path), origin: "https://contoso.example" });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve("open"));
      ws.on("error", () => {});
    });
    expect(code).toBe(401);
  });

  it("#123: a relaying host's hello on the socket is our extension (proven on a pipe)", async () => {
    const path = tempSocket();
    const hub = await host(path, { socketNeedsProof: true });
    expect(await rawClient(path, { type: "hello", version: "0.3.56", browser: "Edge", instance: "profile-2" })).toEqual({ code: 4401 });
    const r = await rawClient(path, { type: "hello", version: "0.3.56", browser: "Edge", instance: "profile-2" }, TOKEN);
    expect(r.msg).toMatchObject({ type: "welcome", capabilities: { features: expect.arrayContaining(["native"]) } });
    await until(() => hub.connected);
    expect(hub.extension).toMatchObject({ browser: "Edge", origin: EXTENSION_ORIGIN });
  });

  it("#123: the native port is the host's extension: welcome, calls, and the keep-alive keeps it (synthetic pong)", async () => {
    const path = tempSocket();
    const hub = await host(path);
    const ext = nativeExtension(hub);
    await until(() => hub.connected, 3_000, "the native extension");
    expect(ext.received.find((m) => m.type === "welcome")).toMatchObject({ type: "welcome", heartbeatMs: FAST.keepAliveMs, capabilities: { features: expect.arrayContaining(["native"]) } });
    expect(hub.extension).toMatchObject({ browser: "Chrome", origin: EXTENSION_ORIGIN });
    await expect(hub.call("listChats", {}, 2_000)).resolves.toEqual({ via: "native", method: "listChats" });
    // A port that never answered ping() would be dropped at the keep-alive's second tick. Wait
    // for four ticks (the extension sees each one's {type:"ping"}): it is still there.
    await until(() => ext.received.filter((m) => m.type === "ping").length >= 4, 5_000, "four keep-alive ticks");
    expect(hub.connected).toBe(true);
    expect(ext.port.readyState).toBe(WebSocket.OPEN);
  });

  unixOnly("#123: replaces a socket file nobody listens on (a host that crashed)", async () => {
    const path = tempSocket();
    writeFileSync(path, ""); // left behind; connecting to it fails
    const hub = await host(path);
    expect(hub.role).toBe("hub");
    expect((await rawClient(path, { type: "peer-hello", version: "1.0.0" })).msg?.type).toBe("peer-welcome");
  });

  it("#123: a second host finds the socket taken and is neither hub nor peer (dist/hub.js then relays)", async () => {
    const path = tempSocket();
    await host(path);
    const second = await host(path);
    expect(second.role).toBe("none");
  });
});

describe("#123: the native host on the TCP port, for peers only (ADR decision 4)", () => {
  it("#123 decision 9: refuses an extension on the TCP port, and takes peers there as today", async () => {
    const path = tempSocket();
    const hub = await host(path);
    await until(() => hub.port > 0, 3_000, "the TCP listener");
    await expect(fakeExtension(hub.port, { reconnect: false })).rejects.toThrow(/extension refused \(4403\)/);
    expect(hub.connected).toBe(false);
    const old = await server(hub.port, "0.3.52");
    expect(old.role).toBe("peer");
    expect(old.hubCapabilities?.features).toContain("native");
  });

  it("#123: never hands the hub to a newer server (Chrome connects the extension to the host, not to a server)", async () => {
    const path = tempSocket();
    const hub = await host(path);
    nativeExtension(hub);
    await until(() => hub.port > 0 && hub.connected, 3_000, "the host with its extension");
    const newer = await server(hub.port, "9.0.0");
    expect(newer.role).toBe("peer");
    await new Promise((r) => setTimeout(r, FAST.stepDownMaxWaitMs! / 4));
    expect(hub.role).toBe("hub");
    expect(newer.role).toBe("peer");
  });

  it("#123 decision 7: while another program holds the port, tries again every tcpRetryMs and takes it once it is free", async () => {
    const { server: holder, port } = await rawHolder();
    const path = tempSocket();
    const hub = await host(path, { tcpRetryMs: 300 }, port);
    expect(hub.role).toBe("hub"); // the hub on its socket at once, whatever holds the port
    await new Promise((r) => setTimeout(r, 400));
    await new Promise<void>((r) => holder.close(() => r()));
    const freed = Date.now();
    await until(async_(() => tcpListening(port)), 3_000, "the host on the freed port");
    // At the next retry, not at once and not much later (a retry period plus scheduling slack).
    expect(Date.now() - freed).toBeLessThan(300 + 700);
    expect((await server(port, "0.3.52")).role).toBe("peer");
  });

  it("#123 decision 8: an older TCP hub on the port steps down to the host, which then holds the port", async () => {
    const old = await server(0, "0.3.52");
    expect(old.role).toBe("hub");
    const port = old.port;
    const path = tempSocket();
    const hub = await host(path, {}, port, "0.3.56");
    // The host joined it as a newer peer, so it handed the port over (its existing stepDown) ...
    await until(() => old.role === "peer" && old.hubCapabilities?.features.includes("native") === true, 6_000, "the old hub as the host's peer");
    expect(hub.port).toBe(port);
    expect(old.hubVersion).toBe("0.3.56");
    // ... and an extension on the port is now refused there.
    await expect(fakeExtension(port, { reconnect: false })).rejects.toThrow(/4403/);
  });

  it("#123 decision 7: a TCP hub of the same version stays; it moves to the host itself (watchHost) once the host has the extension", async () => {
    const path = tempSocket();
    const tcpHub = await server(0, "0.3.56", { hubSocket: path, hubPollMs: 200 });
    const tcpPeer = await server(tcpHub.port, "0.3.56", { hubSocket: path, hubPollMs: 200 });
    expect([tcpHub.role, tcpPeer.role]).toEqual(["hub", "peer"]);
    const port = tcpHub.port;
    const hub = await host(path, { tcpRetryMs: 300 }, port, "0.3.56");
    await new Promise((r) => setTimeout(r, 600)); // three checks of the socket: no extension there yet
    expect(tcpHub.role).toBe("hub");
    nativeExtension(hub);
    await until(() => [tcpHub, tcpPeer].every((s) => s.role === "peer" && s.hubIsHost && s.connected), 5_000, "both servers on the host");
    await expect(tcpPeer.call("listChats", {}, 2_000)).resolves.toEqual({ via: "native", method: "listChats" });
    await until(() => hub.port === port, 3_000, "the host on the freed TCP port");
  });

  it("#123: a TCP hub that still has an extension (native messaging blocked in that browser) stays where it is", async () => {
    const path = tempSocket();
    const tcpHub = await server(0, "0.3.56", { hubSocket: path, hubPollMs: 200 });
    const ext = await fakeExtension(tcpHub.port, { browser: "Edge", instance: "edge-1" });
    cleanups.push(() => ext.close());
    await until(() => tcpHub.connected);
    const hub = await host(path, {}, tcpHub.port, "0.3.56");
    nativeExtension(hub);
    await new Promise((r) => setTimeout(r, 1_000)); // five checks of the socket
    expect(tcpHub.role).toBe("hub");
    expect(tcpHub.extension).toMatchObject({ browser: "Edge" });
  });
});

describe("#123: servers and the hub socket", () => {
  it("#123: a server with the native host enabled joins the host on the socket first, without the TCP port", async () => {
    const path = tempSocket();
    const hub = await host(path, {}, 0);
    nativeExtension(hub);
    await until(() => hub.connected && hub.port > 0, 3_000, "the host with its extension");
    const { port } = await rawHolder(); // a port nobody serves: the server must not need it
    const s = await server(port, "0.3.56", { hubSocket: path });
    expect(s.role).toBe("peer");
    expect(s.hubIsHost).toBe(true);
    await until(() => s.connected);
    await expect(s.call("listChats", {}, 2_000)).resolves.toEqual({ via: "native", method: "listChats" });
  });

  it("#123: with the native host off (no hubSocket) a server keeps today's TCP behaviour, even beside a serving host", async () => {
    const path = tempSocket();
    const hub = await host(path, { tcpRetryMs: 60_000 }, 0);
    nativeExtension(hub);
    await until(() => hub.connected, 3_000, "the host with its extension");
    const s = await server(0, "0.3.56", { hubPollMs: 200 });
    expect(s.role).toBe("hub");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(s.role).toBe("hub");
    expect(s.hubIsHost).toBe(false);
  });

  it("#123: when the host goes, its peers' calls fail with try again and they fall back to TCP", async () => {
    const path = tempSocket();
    const hub = await host(path, {}, 0);
    nativeExtension(hub);
    await until(() => hub.connected, 3_000, "the host with its extension");
    // Port 0: as the TCP hub it takes a free port (the host's listener holds another one).
    const s = await server(0, "0.3.56", { hubSocket: path });
    expect(s.hubIsHost).toBe(true);
    await until(() => s.connected);
    const call = s.call("never", {}, 5_000);
    const failed = call.catch((e: Error) => e.message);
    await hub.close();
    // Closed with the call on its way: it fails with LOST_CALL's "try again" text, not a hang.
    expect(await failed).toMatch(/try again/i);
    await until(() => s.role === "hub", 5_000, "the server as the TCP hub");
    expect(s.port).toBeGreaterThan(0);
    expect(s.hubIsHost).toBe(false);
  });
});

/** until() for an async check: polls it and remembers its last answer. */
function async_(check: () => Promise<boolean>): () => boolean {
  let last = false;
  let running = false;
  return () => {
    if (!running) {
      running = true;
      void check().then((v) => ((last = v), (running = false)));
    }
    return last;
  };
}
