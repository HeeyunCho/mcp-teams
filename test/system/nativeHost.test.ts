// #123 (ADR 0001): the native host (dist/hub.js) as Chrome starts it, with a fake extension on its
// stdin/stdout (Chrome's 4-byte framing) and servers joining it over the hub socket. Runs the
// built file, so it lives with the system tests (`npm run build` first).
// Ported from mcp-newoutlook test/system/nativehost.test.ts (commit c18139c).
import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { socketTransport } from "../../src/bridge.js";
import { SERVER_VERSION } from "../../src/config.js";
import { fakeExtension } from "../helpers/bridgeHarness.js";
import { nativeHarness } from "../helpers/nativeHost.js";
import { until } from "../helpers/timing.js";

let h: Awaited<ReturnType<typeof nativeHarness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const unixOnly = it.skipIf(process.platform === "win32");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#123: the native host", { timeout: 30_000 }, () => {
  it("#123: answers the extension's hello with welcome, declaring native, and pings it", async () => {
    h = await nativeHarness();
    const ext = await h.host();
    expect(ext.welcome).toMatchObject({ type: "welcome", serverVersion: SERVER_VERSION, capabilities: { features: expect.arrayContaining(["native"]) } });
    // The extension's heartbeat watchdog still gets pings on the native port.
    await until(() => ext.received.some((m) => m.type === "ping"), 3_000, "a ping");
  });

  it("#123: refuses a caller other than our extension, before reading anything", async () => {
    h = await nativeHarness();
    const ext = await h.host({ origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" });
    expect(await ext.exited).not.toBe(0);
    expect(ext.received).toEqual([]);
    expect(h.logText()).toMatch(/ refused reason=unknown caller origin/);
  });

  it("#123: with nativeHost off in config.json it does nothing and exits, so the extension stays on TCP", async () => {
    h = await nativeHarness(undefined, { nativeHost: false });
    const ext = await h.host();
    expect(await ext.exited).not.toBe(0);
    expect(ext.received).toEqual([]);
    expect(h.logText()).toMatch(/ disabled reason=nativeHost is off/);
  });

  it("#123: a server joins it on the hub socket and its calls are answered; it also holds a TCP port, for peers only", async () => {
    h = await nativeHarness();
    await h.host({ handle: (req) => ({ chats: [{ id: "19:alex-doe@contoso.example" }], method: req.method }) });
    const server = await h.server();
    expect(server.role).toBe("peer");
    expect(server.hubIsHost).toBe(true);
    await until(() => server.connected);
    await expect(server.call("listChats", {}, 3_000)).resolves.toEqual({ chats: [{ id: "19:alex-doe@contoso.example" }], method: "listChats" });
    const port = await h.hostPort();
    // An extension there is refused (decision 9); a server from before the host joins there as a peer.
    await expect(fakeExtension(port, { reconnect: false })).rejects.toThrow(/extension refused \(4403\)/);
    const old = await h.server("0.3.52", { hubSocket: undefined }, port);
    expect(old.role).toBe("peer");
    await expect(old.call("listChats", {}, 3_000)).resolves.toMatchObject({ method: "listChats" });
    expect(h.logText()).toMatch(/ refused reason=extension on the TCP port/);
  });

  it("#123: a call the AI client cancels is cancelled at the extension", async () => {
    h = await nativeHarness();
    const ext = await h.host({ silentFor: ["searchMessages"] });
    const server = await h.server();
    await until(() => server.connected);
    const abort = new AbortController();
    const call = server.call("searchMessages", { query: "offer" }, 10_000, abort.signal);
    await until(() => ext.requests().some((r) => r.method === "searchMessages"), 3_000, "the request");
    abort.abort();
    await expect(call).rejects.toThrow(/Cancelled/);
    const id = ext.requests().find((r) => r.method === "searchMessages")!.id;
    await until(() => ext.received.some((m) => m.type === "cancel" && m.id === id), 3_000, "the cancel");
  });

  it("#123: a request over 1 MB reaches the extension in chunks of at most 512 KB, every frame under 1 MB", async () => {
    h = await nativeHarness();
    const ext = await h.host({ handle: (req) => ({ size: req.params.text.length }) });
    const server = await h.server();
    await until(() => server.connected);
    const text = "Hallo Sam, 안녕하세요! ".repeat(80_000); // about 2 MB of UTF-8
    await expect(server.call("requestSend", { chatId: "19:sam-roe@contoso.example", text }, 10_000)).resolves.toEqual({ size: text.length });
    expect(ext.chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of ext.chunks) expect(Buffer.byteLength(c.data)).toBeLessThanOrEqual(512 * 1024);
    for (const n of ext.frameSizes) expect(n).toBeLessThanOrEqual(1024 * 1024);
    expect(ext.requests().find((r) => r.method === "requestSend")!.params.text).toBe(text);
  });

  it("#123 decision 5: keeps serving for the linger time after the extension disconnects, then exits; its servers fall back to TCP", async () => {
    h = await nativeHarness();
    const ext = await h.host({ lingerMs: 1_500 });
    const server = await h.server();
    await until(() => server.connected);
    ext.disconnect();
    const gone = Date.now();
    await until(() => !server.connected, 3_000, "the extension gone");
    await sleep(600);
    // Still there: an extension reconnecting now keeps the servers where they are.
    expect(ext.exitCode).toBeUndefined();
    expect(server.hubIsHost).toBe(true);
    expect(await ext.exited).toBe(0);
    expect(Date.now() - gone).toBeGreaterThanOrEqual(1_400);
    await until(() => server.role === "hub" && !server.hubIsHost, 5_000, "the server as the TCP hub");
    expect(h.logText()).toMatch(/ exit reason=no extension lingerMs=1500/);
    if (process.platform !== "win32") expect(h.socketExists()).toBe(false);
  });

  it("#123 decision 5: an extension that reconnects within the linger (a new host, relaying) keeps the host serving", async () => {
    h = await nativeHarness();
    // Long enough for a second node process to start well within it, on a busy machine too.
    const lingerMs = 5_000;
    const first = await h.host({ lingerMs });
    const server = await h.server();
    await until(() => server.connected);
    first.disconnect();
    const gone = Date.now();
    await until(() => !server.connected, 3_000, "the extension gone");
    const again = await h.host({ lingerMs, handle: () => ({ via: "relay" }) });
    expect(again.welcome?.capabilities.features).toContain("native");
    // It came in as a relaying host, within the first one's linger.
    expect(h.logText()).toMatch(new RegExp(` pid=${again.child.pid} relay version=`));
    expect(Date.now() - gone).toBeLessThan(lingerMs);
    await sleep(gone + lingerMs + 800 - Date.now()); // past the first host's linger
    expect(first.exitCode).toBeUndefined();
    expect(server.hubIsHost).toBe(true);
    await expect(server.call("listChats", {}, 3_000)).resolves.toEqual({ via: "relay" });
  });

  it("#123: a second host (another browser) relays its extension to the first, which serves both", async () => {
    h = await nativeHarness();
    await h.host({ browser: "Chrome", instance: "profile-1", handle: (r) => (r.method === "status" ? { teamsTabs: 0 } : { from: "chrome" }) });
    const edge = await h.host({
      browser: "Edge",
      instance: "profile-2",
      handle: (r) => (r.method === "status" ? { teamsTabs: 1, sessions: [{ sessionCaptured: true }] } : { from: "edge" }),
    });
    // The welcome came from the first host, through the relay (proven on a Windows pipe).
    expect(edge.welcome.capabilities.features).toContain("native");
    const server = await h.server();
    await until(() => server.extensions.length === 2, 3_000, "both browsers");
    expect(server.extensions.map((e) => e.browser).sort()).toEqual(["Chrome", "Edge"]);
    // Teams is signed in in Edge, so calls go there, through the relay.
    await expect(server.call("readMessages", {}, 3_000)).resolves.toEqual({ from: "edge" });
    expect(edge.requests().some((r) => r.method === "readMessages")).toBe(true);
  });

  it("#123: when the serving host goes away, the relaying host takes over the hub socket", async () => {
    h = await nativeHarness();
    const chrome = await h.host({ browser: "Chrome", instance: "profile-1" });
    const edge = await h.host({ browser: "Edge", instance: "profile-2", handle: () => ({ from: "edge" }) });
    const server = await h.server();
    await until(() => server.extensions.length === 2, 3_000, "both browsers");
    await chrome.kill(); // a crash: on macOS and Linux the socket file stays behind
    await until(() => server.connected && server.extensions.length === 1 && server.extension?.browser === "Edge", 8_000, "the server on the new host");
    expect(server.hubIsHost).toBe(true);
    await expect(server.call("readMessages", {}, 3_000)).resolves.toEqual({ from: "edge" });
    expect(edge.exitCode).toBeUndefined();
  });

  for (const code of [4401, 4409]) {
    it(`#123: a relaying host the serving host refuses (${code}) exits, so the extension connects again`, async () => {
      h = await nativeHarness();
      // Something holding the hub socket that refuses the relayed hello.
      const refusing = await socketTransport({ path: h.socket, maxMessageBytes: 1 << 20 }).listen({
        connection: (conn) => {
          conn.send(JSON.stringify({ type: "challenge", nonce: "n" }));
          conn.on("message", () => conn.close(code, "refused"));
        },
        error: () => {},
      });
      try {
        const ext = await h.host({}, false);
        expect(await ext.exited).toBe(1);
        expect(h.logText()).toMatch(new RegExp(` exit reason=refused by the host code=${code}`));
      } finally {
        await refusing.close();
      }
    });
  }

  it("#123: a frame from the extension over the size limit is skipped unread, logged by its size, and the port stays open", async () => {
    h = await nativeHarness();
    const ext = await h.host({ handle: () => ({ fine: true }) });
    const server = await h.server();
    await until(() => server.connected);
    // A 300 MB frame's header and its first bytes: the host must not wait for (or keep) the rest.
    const head = Buffer.alloc(4);
    head.writeUInt32LE(300 * 1024 * 1024, 0);
    ext.child.stdin.write(Buffer.concat([head, Buffer.alloc(64 * 1024, 0x61)]));
    await until(() => / oversize bytes=314572800/.test(h!.logText()), 3_000, "the oversize line");
    expect(ext.exitCode).toBeUndefined();
  });

  unixOnly("#123: the hub socket and hub.log are owner-only (folder 0700, socket and log 0600)", async () => {
    h = await nativeHarness();
    await h.host();
    await until(() => h!.logText().length > 0, 3_000, "hub.log");
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
    expect(statSync(h.socket).mode & 0o777).toBe(0o600);
    expect(statSync(h.log).mode & 0o777).toBe(0o600);
  });

  it("#123 decision 6: hub.log has message types, methods, ok, sizes and times, never message text or tokens", async () => {
    h = await nativeHarness();
    await h.host({
      handle: (r) => {
        if (r.method === "searchMessages") throw new Error("Chat with Sam Roe not found");
        return { messages: [{ text: "Contoso merger: confidential" }] };
      },
    });
    const server = await h.server();
    await until(() => server.connected);
    await server.call("readMessages", { chatId: "19:secret-chat@thread.v2" }, 3_000);
    await expect(server.call("searchMessages", { query: "budget" }, 3_000)).rejects.toThrow();
    const responses = () => h!.logText().split("\n").filter((l) => / from-extension type=response /.test(l));
    await until(() => responses().length >= 2, 3_000, "both answers in the log");
    expect(h.logText()).toMatch(/ to-extension type=request method=readMessages bytes=\d+/);
    expect(responses()[0]).toMatch(/ ok=true bytes=\d+ ms=\d+/);
    expect(responses()[1]).toMatch(/ ok=false bytes=\d+ ms=\d+/);
    expect(h.logText()).toMatch(/ host version=\S+ /);
    expect(h.logText()).not.toMatch(/Contoso|secret-chat|Sam Roe|not found|budget|test-token/);
  });
});
