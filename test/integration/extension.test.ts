import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ExtensionBridge, isNewer, proof } from "../../src/bridge.js";
import { EXTENSION_ID, EXTENSION_ORIGIN, extensionIdFromKey, installedVersion, syncExtension, writePairing } from "../../src/extension.js";
// @ts-expect-error plain JS module shared with the extension
import { pairingProof } from "../../extension/teams.js";
import { until } from "../helpers/timing.js";

// Each test's port: 0 until its first bridge listens (the system picks a free port and the
// bridge keeps it), then that bridge's port. A "free" port picked and closed before a bridge
// binds it could be taken by a test file or worktree running alongside (#23).
let PORT: number;
beforeEach(() => {
  PORT = 0;
});

/** A bridge on this test's port; the first one started sets PORT to the port it got. */
class TestBridge extends ExtensionBridge {
  constructor(...[token, version, options]: Tail<ConstructorParameters<typeof ExtensionBridge>>) {
    super(PORT, token, version, options);
  }
  override async start(): Promise<void> {
    await super.start();
    PORT ||= this.port;
  }
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;

describe("extension id", () => {
  it("matches the key in the manifest, so Chrome gives the extension this id", () => {
    const { key } = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    expect(extensionIdFromKey(key)).toBe(EXTENSION_ID);
  });
});

/**
 * A fake extension that answers the server's challenge like the real one: with a proof
 * from `secret` (null: says hello without one, like 0.2.0 and older). Requests go to `onRequest`.
 */
function extension(
  origin: string,
  secret: string | null,
  { instance, browser = "Chrome", onRequest }: { instance?: string; browser?: string; onRequest?: (ws: WebSocket, msg: any) => void } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
  const nonce = "n-" + Math.random();
  const welcome = new Promise<any>((resolve) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") {
        const p = secret ? await pairingProof(secret, "client", msg.nonce) : undefined;
        ws.send(JSON.stringify({ type: "hello", ...(secret ? { proof: p, nonce } : { token: null }), version: "0.15.0", browser, instance }));
      } else if (msg.type === "welcome") resolve(msg);
      else if (msg.type === "request") onRequest?.(ws, msg);
    });
    ws.on("close", () => resolve(null));
  });
  return { ws, nonce, welcome };
}

describe("pairing", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  /** Says hello; on welcome, `whileOpen` runs before the socket closes. */
  const hello = (origin: string, token: string | null, whileOpen: () => void = () => {}) =>
    new Promise<{ welcomed: boolean; code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
      ws.on("message", (raw) => {
        const type = JSON.parse(raw.toString()).type;
        if (type === "challenge") ws.send(JSON.stringify({ type: "hello", token, version: "0.15.0", browser: "Chrome" }));
        if (type !== "welcome") return;
        whileOpen();
        resolve({ welcomed: true });
        ws.close();
      });
      ws.on("close", (code) => resolve({ welcomed: false, code }));
    });

  it("computes the same proof in the extension as in the server", async () => {
    expect(await pairingProof("secret", "client", "abc")).toBe(proof("secret", "client", "abc"));
    expect(await pairingProof("sécret", "server", "x/y+z")).toBe(proof("sécret", "server", "x/y+z"));
  });

  it("accepts our extension when it proves the token, proves itself back, and records where it connected from", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const ext = extension(EXTENSION_ORIGIN, "secret");
    const welcome = await ext.welcome;
    expect(welcome.proof).toBe(proof("secret", "server", ext.nonce));
    expect(bridge.extension).toMatchObject({ version: "0.15.0", origin: EXTENSION_ORIGIN });
    ext.ws.close();
  });

  it("turns away anything with our extension's origin but a wrong proof", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const ext = extension(EXTENSION_ORIGIN, "guess");
    expect(await ext.welcome).toBeNull();
    expect(bridge.connected).toBe(false);
  });

  it("only asks our extension of 0.2.0 or older (no token, no proof) to reload, once, and sends it no calls", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const got: string[] = [];
    const old = extension(EXTENSION_ORIGIN, null, { onRequest: (_, msg) => got.push(msg.method) });
    const code = await new Promise((r) => old.ws.on("close", r));
    expect(code).toBe(4426);
    expect(got).toEqual(["reload"]);
    expect(bridge.connected).toBe(false);
    await expect(bridge.call("listChats")).rejects.toThrow(/not connected/);
    const again: string[] = [];
    const second = extension(EXTENSION_ORIGIN, null, { onRequest: (_, msg) => again.push(msg.method) });
    await new Promise((r) => second.ws.on("close", r));
    expect(again).toEqual([]);
  });

  it("still needs the token from any other extension", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    expect(await hello("chrome-extension://someotherextensionidxxxxxxxxxxxx", null)).toEqual({ welcomed: false, code: 4401 });
    expect(await hello("chrome-extension://someotherextensionidxxxxxxxxxxxx", "secret")).toEqual({ welcomed: true });
  });
});

describe("two copies of the extension", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  it("keeps our extension connected and turns an older copy away", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const ours = extension(EXTENSION_ORIGIN, "secret");
    await ours.welcome;
    const old = extension("chrome-extension://eppconghijagecilnpngjgafbnphfhpd", "secret");
    expect(await new Promise((r) => old.ws.on("close", r))).toBe(4409);
    expect(bridge.connected).toBe(true);
    expect(bridge.extension?.origin).toBe(EXTENSION_ORIGIN);
    ours.ws.close();
  });
});

describe("several browsers at once", () => {
  let bridge: ExtensionBridge | undefined;
  afterEach(async () => bridge?.close());

  /**
   * A fake extension: answers status with `signedIn` and its Teams tabs (`state.teamsTabs`, which
   * a test changes to close or open its tab), records the methods it gets.
   */
  const browser = (name: string, instance: string, signedIn: boolean, teamsTabs = 1) => {
    const got: string[] = [];
    const state = { teamsTabs };
    const { ws, welcome } = extension(EXTENSION_ORIGIN, "secret", {
      browser: name,
      instance,
      onRequest: (ws, msg) => {
        got.push(msg.method);
        const result = msg.method === "status" ? { teamsTabs: state.teamsTabs, sessions: [{ sessionCaptured: signedIn }] } : { from: name };
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
      },
    });
    return { ws, got, state, welcome };
  };

  /** Chrome has Teams signed in but no Teams tab; Edge has a Teams tab but no captured session. */
  const chromeWithoutTabEdgeWithTab = async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const chrome = browser("Chrome", "chrome-1", true, 0);
    await chrome.welcome;
    const edge = browser("Edge", "edge-1", false, 1);
    await until(() => bridge!.extensions.length === 2, 3_000, "both browsers to connect");
    return { chrome, edge };
  };

  it.each(["listTeams", "listChats"])("sends %s to the browser with a Teams tab before one with only a captured session", async (method) => {
    const { chrome, edge } = await chromeWithoutTabEdgeWithTab();
    await expect(bridge!.call(method)).resolves.toEqual({ from: "Edge" });
    expect(chrome.got).not.toContain(method);
    chrome.ws.close();
    edge.ws.close();
  });

  it.each(["listTeams", "listChats"])("moves %s off the browser that answered last once its Teams tab has closed", async (method) => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const chrome = browser("Chrome", "chrome-1", true, 1);
    const edge = browser("Edge", "edge-1", false, 1);
    await until(() => bridge!.extensions.length === 2, 3_000, "both browsers to connect");
    await expect(bridge.call(method)).resolves.toEqual({ from: "Chrome" });
    expect(bridge.extension?.browser).toBe("Chrome");

    chrome.state.teamsTabs = 0; // the user closes Teams in Chrome; it stays open in Edge
    await expect(bridge.call(method)).resolves.toEqual({ from: "Edge" });
    // And back to Chrome once Edge's tab is gone and Chrome has one again: the count is asked each time.
    edge.state.teamsTabs = 0;
    chrome.state.teamsTabs = 1;
    await expect(bridge.call(method)).resolves.toEqual({ from: "Chrome" });
    chrome.ws.close();
    edge.ws.close();
  });

  it("keeps sending other calls to the signed-in browser and then to the one that answered last, tab or not", async () => {
    const { chrome, edge } = await chromeWithoutTabEdgeWithTab();
    await expect(bridge!.call("readMessages")).resolves.toEqual({ from: "Chrome" });
    await expect(bridge!.call("searchMessages")).resolves.toEqual({ from: "Chrome" });
    // Only the first call asked for the browsers' status.
    expect(chrome.got).toEqual(["status", "readMessages", "searchMessages"]);
    expect(edge.got).toEqual(["status"]);
    chrome.ws.close();
    edge.ws.close();
  });

  it.each(["listTeams", "listChats"])("keeps other calls on the browser that answered last after %s went to another browser for its tab", async (method) => {
    const { chrome, edge } = await chromeWithoutTabEdgeWithTab();
    await expect(bridge!.call("readMessages")).resolves.toEqual({ from: "Chrome" });
    await expect(bridge!.call(method)).resolves.toEqual({ from: "Edge" });
    await expect(bridge!.call("readMessages")).resolves.toEqual({ from: "Chrome" });
    expect(bridge!.extension?.browser).toBe("Chrome");
    chrome.ws.close();
    edge.ws.close();
  });

  it("with no Teams tab in any browser, sends list_teams to the browser that answered last", async () => {
    const { chrome, edge } = await chromeWithoutTabEdgeWithTab();
    await expect(bridge!.call("readMessages")).resolves.toEqual({ from: "Chrome" });
    edge.state.teamsTabs = 0;
    await expect(bridge!.call("listTeams")).resolves.toEqual({ from: "Chrome" });
    chrome.ws.close();
    edge.ws.close();
  });

  it.each(["listTeams", "listChats"])(
    "asks every browser for its status at once for %s, so a frozen browser that answered last costs one status wait, not two",
    async (method) => {
      const pickStatusTimeoutMs = 1_000;
      bridge = new TestBridge("secret", "0.15.0", { pickStatusTimeoutMs });
      await bridge.start();
      /** Answers calls but never its status, like a browser whose service worker is stuck. */
      const frozen = (name: string, instance: string) => {
        const { ws, welcome } = extension(EXTENSION_ORIGIN, "secret", {
          browser: name,
          instance,
          onRequest: (ws, msg) => {
            if (msg.method !== "status") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { from: name } }));
          },
        });
        return { ws, welcome };
      };
      const chrome = frozen("Chrome", "chrome-1");
      await until(() => bridge!.extensions.length === 1, 3_000, "Chrome to connect");
      await expect(bridge.call("readMessages")).resolves.toEqual({ from: "Chrome" }); // Chrome answered last
      const firefox = frozen("Firefox", "firefox-1");
      const edge = browser("Edge", "edge-1", false, 1);
      await until(() => bridge!.extensions.length === 3, 3_000, "all three browsers to connect");

      const started = Date.now();
      await expect(bridge.call(method)).resolves.toEqual({ from: "Edge" });
      // Asked one after the other, Chrome's wait and then Firefox's would take 2 s.
      expect(Date.now() - started).toBeLessThan(pickStatusTimeoutMs * 1.6);
      expect(bridge.extension?.browser).toBe("Chrome");
      chrome.ws.close();
      firefox.ws.close();
      edge.ws.close();
    },
  );

  it("with one browser, sends list_teams and list_chats to it without asking for its status, tab or not", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const chrome = browser("Chrome", "chrome-1", true, 0);
    await until(() => bridge!.extensions.length === 1, 3_000, "the browser to connect");
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Chrome" });
    await expect(bridge.call("listChats")).resolves.toEqual({ from: "Chrome" });
    expect(chrome.got).toEqual(["listTeams", "listChats"]);
    chrome.ws.close();
  });

  it("keeps both connected and sends calls to the browser where Teams is signed in", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const edge = browser("Edge", "edge-1", true);
    const chrome = browser("Chrome", "chrome-1", false);
    await until(() => bridge!.extensions.length === 2, 3_000, "both browsers to connect");
    expect(bridge.extensions.map((e) => e.browser).sort()).toEqual(["Chrome", "Edge"]);
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Edge" });
    // It sticks with the browser that answered. Each list call asks every browser for its
    // status at once, so Chrome is asked again, but gets no list call.
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Edge" });
    // Edge's answer can come back before Chrome has read its second status request.
    await until(() => chrome.got.length >= 2, 3_000, "Chrome's second status request");
    expect(chrome.got).toEqual(["status", "status"]);
    expect(bridge.extension?.browser).toBe("Edge");

    // When that browser goes away, calls go to the other one.
    edge.ws.close();
    await until(() => bridge!.extensions.length === 1, 3_000, "the bridge to drop the closed Edge connection");
    await expect(bridge.call("listTeams")).resolves.toEqual({ from: "Chrome" });
    chrome.ws.close();
  });

  it("reloads every browser, and a reconnect replaces only that browser's connection", async () => {
    bridge = new TestBridge("secret", "0.15.0");
    await bridge.start();
    const edge = browser("Edge", "edge-1", true);
    const chrome = browser("Chrome", "chrome-1", false);
    await until(() => bridge!.extensions.length === 2, 3_000, "both browsers to connect");
    await expect(bridge.call("reloadAll")).resolves.toEqual({ reloading: 2 });
    expect(edge.got).toContain("reload");
    expect(chrome.got).toContain("reload");

    const closed = new Promise((r) => chrome.ws.on("close", r));
    const chromeAgain = browser("Chrome", "chrome-1", false);
    expect(await closed).toBe(4000);
    await until(
      () => bridge!.extensions.length === 2 && chromeAgain.ws.readyState === WebSocket.OPEN,
      3_000,
      "the reconnected Chrome to replace its old connection",
    );
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
  const silent = async (instance: string) => {
    const ext = extension(EXTENSION_ORIGIN, "secret", { instance });
    await ext.welcome;
    return ext.ws;
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
    const hub = new TestBridge("secret", "0.15.0");
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
    const hub = new TestBridge("secret", "0.15.0");
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
    const old = new TestBridge("secret", "0.15.0");
    bridges.push(old);
    await old.start();
    expect(old.role).toBe("hub");
    const newer = new TestBridge("secret", "0.15.1");
    bridges.push(newer);
    await newer.start();
    expect(newer.role).toBe("peer");
    await until(() => newer.role === "hub" && old.role === "peer", 5_000, "the newer server to take over as hub");
    expect(old.hubVersion).toBe("0.15.1");
  }, 10_000);

  it("23: a hub that took port 0 keeps the port it got when it hands over, and joins the newer server there", async () => {
    const old = new ExtensionBridge(0, "secret", "0.15.0");
    bridges.push(old);
    await old.start();
    const port = old.port;
    const newer = new ExtensionBridge(port, "secret", "0.15.1");
    bridges.push(newer);
    await newer.start();
    await until(() => newer.role === "hub" && old.role === "peer", 4_000, "the newer server to take over as hub on the old hub's port");
    // A new free port would leave it a hub nobody can find, and the newer server without its peer.
    expect(old.port).toBe(port);
  }, 10_000);

  it("a server doesn't join a program on the port that can't prove the token, and never sends it the token", async () => {
    const { WebSocketServer } = await import("ws");
    const seen: any[] = [];
    const rogue = new WebSocketServer({ host: "127.0.0.1", port: PORT });
    rogue.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "challenge", nonce: "c" }));
      ws.on("message", (raw) => {
        seen.push(JSON.parse(raw.toString()));
        ws.send(JSON.stringify({ type: "peer-welcome", serverVersion: "9.9.9", proof: "forged", extension: null }));
      });
    });
    await new Promise((r) => rogue.once("listening", r));
    PORT = (rogue.address() as { port: number }).port;
    const server = new TestBridge("secret", "0.15.0");
    bridges.push(server);
    await server.start();
    expect(server.role).toBe("none");
    expect(server.listenError).toMatch(/0\.2\.0 or older|another program/);
    expect(JSON.stringify(seen)).not.toContain("secret");
    await server.close();
    await new Promise((r) => rogue.close(r));
  });

  it("a hub doesn't step down for a peer of the same or an older version", async () => {
    const hub = new TestBridge("secret", "0.15.0");
    bridges.push(hub);
    await hub.start();
    const same = new TestBridge("secret", "0.15.0");
    const older = new TestBridge("secret", "0.14.1");
    bridges.push(same, older);
    await same.start();
    await older.start();
    await sleep(2_500);
    expect([hub.role, same.role, older.role]).toEqual(["hub", "peer", "peer"]);
  });
});

describe("writePairing", () => {
  it("writes the token for the extension, readable by this user only, and syncExtension keeps it", () => {
    const from = mkdtempSync(join(tmpdir(), "mcp-teams-ext-"));
    const to = mkdtempSync(join(tmpdir(), "mcp-teams-ext-"));
    writeFileSync(join(from, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    expect(writePairing("tok", to)).toBe(true);
    expect(writePairing("tok", to)).toBe(false);
    expect(JSON.parse(readFileSync(join(to, "pairing.json"), "utf8"))).toEqual({ token: "tok" });
    if (process.platform !== "win32") expect(statSync(join(to, "pairing.json")).mode & 0o777).toBe(0o600);
    syncExtension(from, to);
    expect(existsSync(join(to, "pairing.json"))).toBe(true);
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
