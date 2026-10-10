import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ExtensionBridge, isNewer } from "../src/bridge.js";
import { EXTENSION_ID, EXTENSION_ORIGIN, extensionIdFromKey, installedVersion, syncExtension } from "../src/extension.js";

const PORT = 47597;

describe("extension id", () => {
  it("matches the key in the manifest, so Chrome gives the extension this id", () => {
    const { key } = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    expect(extensionIdFromKey(key)).toBe(EXTENSION_ID);
  });
});

describe("bridge without pairing", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  /** Says hello; on welcome, `whileOpen` runs before the socket closes. */
  const hello = (origin: string, token: string | null, whileOpen: () => void = () => {}) =>
    new Promise<{ welcomed: boolean; code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, version: "0.15.0", browser: "Chrome" })));
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type !== "welcome") return;
        whileOpen();
        resolve({ welcomed: true });
        ws.close();
      });
      ws.on("close", (code) => resolve({ welcomed: false, code }));
    });

  it("accepts our extension's fixed id without a token, and records where it connected from", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.15.0");
    await bridge.start();
    let seen: unknown;
    expect(await hello(EXTENSION_ORIGIN, null, () => (seen = bridge!.extension))).toEqual({ welcomed: true });
    expect(seen).toMatchObject({ version: "0.15.0", origin: EXTENSION_ORIGIN });
  });

  it("still needs the token from any other extension", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.15.0");
    await bridge.start();
    expect(await hello("chrome-extension://someotherextensionidxxxxxxxxxxxx", null)).toEqual({ welcomed: false, code: 4401 });
    expect(await hello("chrome-extension://someotherextensionidxxxxxxxxxxxx", "secret")).toEqual({ welcomed: true });
  });
});

describe("two copies of the extension", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  it("keeps our extension connected and turns an older copy away", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.15.0");
    await bridge.start();
    const connect = (origin: string, token: string | null) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, version: "x", browser: "Chrome" })));
      return ws;
    };
    const ours = connect(EXTENSION_ORIGIN, null);
    await new Promise((r) => ours.on("message", r));
    const old = connect("chrome-extension://eppconghijagecilnpngjgafbnphfhpd", "secret");
    expect(await new Promise((r) => old.on("close", r))).toBe(4409);
    expect(bridge.connected).toBe(true);
    expect(bridge.extension?.origin).toBe(EXTENSION_ORIGIN);
    ours.close();
  });
});

describe("several browsers at once", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  /** A fake extension: answers status with `signedIn`, records the methods it gets. */
  const browser = (name: string, instance: string, signedIn: boolean) => {
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: EXTENSION_ORIGIN });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: null, version: "0.15.0", browser: name, instance })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "request") return;
      got.push(msg.method);
      const result = msg.method === "status" ? { teamsTabs: 1, sessions: [{ sessionCaptured: signedIn }] } : { from: name };
      ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
    });
    return { ws, got };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("keeps both connected and sends calls to the browser where Teams is signed in", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.15.0");
    await bridge.start();
    const edge = browser("Edge", "edge-1", true);
    const chrome = browser("Chrome", "chrome-1", false);
    await until(() => bridge!.extensions.length === 2);
    expect(bridge.extensions.map((e) => e.browser).sort()).toEqual(["Chrome", "Edge"]);
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Edge" });
    // It sticks with the browser that answered, without asking again.
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Edge" });
    expect(chrome.got).toEqual(["status"]);
    expect(bridge.extension?.browser).toBe("Edge");

    // When that browser goes away, calls go to the other one.
    edge.ws.close();
    await until(() => bridge!.extensions.length === 1);
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Chrome" });
    chrome.ws.close();
  });

  it("reloads every browser, and a reconnect replaces only that browser's connection", async () => {
    bridge = new ExtensionBridge(PORT, "secret", "0.15.0");
    await bridge.start();
    const edge = browser("Edge", "edge-1", true);
    const chrome = browser("Chrome", "chrome-1", false);
    await until(() => bridge!.extensions.length === 2);
    await expect(bridge.call("reloadAll")).resolves.toEqual({ reloading: 2 });
    expect(edge.got).toContain("reload");
    expect(chrome.got).toContain("reload");

    const closed = new Promise((r) => chrome.ws.on("close", r));
    const chromeAgain = browser("Chrome", "chrome-1", false);
    expect(await closed).toBe(4000);
    await until(() => bridge!.extensions.length === 2 && chromeAgain.ws.readyState === WebSocket.OPEN);
    expect(bridge.extensions.map((e) => e.instance).sort()).toEqual(["chrome-1", "edge-1"]);
    edge.ws.close();
    chromeAgain.ws.close();
  });
});

describe("robustness", () => {
  const bridges: ExtensionBridge[] = [];
  afterEach(async () => {
    await Promise.all(bridges.map((b) => b.close()));
    bridges.length = 0;
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A fake extension of ours that never answers requests. */
  const silent = (instance: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: EXTENSION_ORIGIN });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: null, version: "x", browser: "Chrome", instance })));
    return new Promise<WebSocket>((r) => ws.on("message", () => r(ws)));
  };

  it("compares versions", () => {
    expect(isNewer("0.15.1", "0.15.0")).toBe(true);
    expect(isNewer("0.16.0", "0.15.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.15.0", "0.15.0")).toBe(false);
    expect(isNewer("0.14.1", "0.15.0")).toBe(false);
    expect(isNewer("unknown", "0.15.0")).toBe(false);
    expect(isNewer(undefined, "0.15.0")).toBe(false);
  });

  it("fails a call at once when its extension connection is replaced", async () => {
    const hub = new ExtensionBridge(PORT, "secret", "0.15.0");
    bridges.push(hub);
    await hub.start();
    const first = await silent("profile-1");
    const call = hub.call("status", {}, 60_000).then(() => null, (err: Error) => err);
    await sleep(100);
    const started = Date.now();
    const second = await silent("profile-1"); // the same browser reconnects
    expect((await call)?.message).toMatch(/reconnected/);
    expect(Date.now() - started).toBeLessThan(2_000);
    first.close();
    second.close();
  });

  it("ignores a local client that sends JSON null", async () => {
    const hub = new ExtensionBridge(PORT, "secret", "0.15.0");
    bridges.push(hub);
    await hub.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => ws.on("open", r));
    ws.send("null");
    await sleep(100);
    expect(hub.role).toBe("hub");
    ws.close();
  });

  it("an older hub hands the port to a newer server that joins", async () => {
    const old = new ExtensionBridge(PORT, "secret", "0.15.0");
    bridges.push(old);
    await old.start();
    expect(old.role).toBe("hub");
    const newer = new ExtensionBridge(PORT, "secret", "0.15.1");
    bridges.push(newer);
    await newer.start();
    expect(newer.role).toBe("peer");
    for (const end = Date.now() + 5_000; Date.now() < end && (newer.role !== "hub" || old.role !== "peer"); ) await sleep(100);
    expect(newer.role).toBe("hub");
    expect(old.role).toBe("peer");
    expect(old.hubVersion).toBe("0.15.1");
  });

  it("a hub doesn't step down for a peer of the same or an older version", async () => {
    const hub = new ExtensionBridge(PORT, "secret", "0.15.0");
    bridges.push(hub);
    await hub.start();
    const same = new ExtensionBridge(PORT, "secret", "0.15.0");
    const older = new ExtensionBridge(PORT, "secret", "0.14.1");
    bridges.push(same, older);
    await same.start();
    await older.start();
    await sleep(2_500);
    expect([hub.role, same.role, older.role]).toEqual(["hub", "peer", "peer"]);
  });
});

describe("syncExtension", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "mcp-teams-ext-"));

  it("copies the extension, updates changed files and removes stale ones", () => {
    const from = tmp();
    const to = join(tmp(), "extension");
    mkdirSync(join(from, "icons"));
    writeFileSync(join(from, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(from, "icons", "a.png"), "A");
    expect(installedVersion(to)).toBeNull();
    expect(syncExtension(from, to)).toEqual({ changed: true, dir: to });
    expect(installedVersion(to)).toBe("1.0.0");
    expect(readFileSync(join(to, "icons", "a.png"), "utf8")).toBe("A");

    expect(syncExtension(from, to).changed).toBe(false);

    writeFileSync(join(from, "manifest.json"), JSON.stringify({ version: "1.1.0" }));
    writeFileSync(join(to, "old.js"), "stale");
    expect(syncExtension(from, to).changed).toBe(true);
    expect(installedVersion(to)).toBe("1.1.0");
    expect(existsSync(join(to, "old.js"))).toBe(false);
  });
});
