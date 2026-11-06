// #115: the capabilities handshake. hello (extension), peer-hello (peer), welcome and peer-welcome
// (hub) each declare { features, maxMessageBytes }, and each side uses a feature only when the
// other declares it. A side too old to send capabilities has no features, and nothing changes
// for it. Real sockets: hubs and peers (ExtensionBridge), fake extensions, and old-format peers
// and hubs scripted by hand.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, proof } from "../../src/bridge.js";
import { TOKEN, bridgeHarness, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness | undefined;
const extra: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of extra.splice(0)) await close();
  await h?.cleanup();
  h = undefined;
});

/** A peer of before #115, by hand: its peer-hello declares no capabilities. Records what it gets. */
async function oldPeer(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: any[] = [];
  const nonce = randomUUID();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "challenge") ws.send(JSON.stringify({ type: "peer-hello", proof: proof(TOKEN, "client", msg.nonce), nonce, version: "1.0.0" }));
  });
  ws.on("error", () => {});
  extra.push(() => ws.terminate());
  await until(() => received.some((m) => m.type === "peer-welcome"), 3_000, "peer-welcome");
  return received.find((m) => m.type === "peer-welcome");
}

describe("#115: the hub declares its capabilities", () => {
  it("welcome tells the extension the hub's features and largest message", async () => {
    h = await bridgeHarness();
    await h.session("1.0.0", { maxMessageBytes: 8 * 1024 * 1024 });
    const ext = await h.extension();
    expect(ext.welcome.capabilities).toEqual({ features: ["checksSend"], maxMessageBytes: 8 * 1024 * 1024 });
  });

  it("peer-welcome declares checksSend as a feature and keeps the old checksSend field for old peers", async () => {
    h = await bridgeHarness();
    await h.session();
    const welcome = await oldPeer(h.port);
    expect(welcome.capabilities).toEqual({ features: ["checksSend"], maxMessageBytes: MAX_MESSAGE_BYTES });
    expect(welcome.checksSend).toBe(true);
  });
});

describe("#115: the extension's capabilities", () => {
  it("the hub records what each browser's extension declares, and its peers see it", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    await h.extension({ browser: "Chrome", instance: "profile-1", capabilities: { features: ["someFeature"], maxMessageBytes: 1024 } });
    // Only strings count as features; anything else in the list is ignored.
    await h.extension({ browser: "Edge", instance: "profile-2", capabilities: { features: ["other", 7, null], maxMessageBytes: 2048 } });
    await until(() => peer.extensions.length === 2, 3_000, "the peer sees both extensions");
    const declared = [
      { browser: "Chrome", capabilities: { features: ["someFeature"], maxMessageBytes: 1024 } },
      { browser: "Edge", capabilities: { features: ["other"], maxMessageBytes: 2048 } },
    ];
    expect(hub.extensions).toMatchObject(declared);
    expect(peer.extensions).toMatchObject(declared);
  });

  it("an extension from before #115 (no capabilities, or not a list) has no features", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    await h.extension({ browser: "Chrome", instance: "profile-1" });
    await h.extension({ browser: "Edge", instance: "profile-2", capabilities: { features: "checksSend" } });
    await until(() => hub.extensions.length === 2, 3_000, "both extensions");
    for (const e of hub.extensions) expect(e.capabilities).toEqual({ features: [], maxMessageBytes: null });
  });
});

/**
 * A hub scripted by hand that pairs peers like the real one, with `declared` in its peer-welcome
 * (e.g. only capabilities, as a hub might once the old checksSend field is gone, or only the old
 * field, as before #115). Records each peer-hello. Listens on port 0: pass its port to bridgeHarness().
 */
async function scriptedHub(declared: object) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const hellos: any[] = [];
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "challenge", nonce: randomUUID() }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "peer-hello") return;
      hellos.push(msg);
      ws.send(JSON.stringify({ type: "peer-welcome", serverVersion: "1.0.0", extension: null, extensions: [], proof: proof(TOKEN, "server", msg.nonce), ...declared }));
    });
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  extra.push(() => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r()))));
  return { port: (wss.address() as { port: number }).port, hellos };
}

/** A peer of a hub whose peer-welcome declares `declared`. */
async function peerOf(declared: object) {
  const hub = await scriptedHub(declared);
  h = await bridgeHarness(undefined, { port: hub.port });
  const peer = await h.session("1.0.0", { maxMessageBytes: 4 * 1024 * 1024 });
  expect(peer.role).toBe("peer");
  return { peer, hub };
}

describe("#115: a peer and its hub's capabilities", () => {
  it("peer-hello declares this server's capabilities", async () => {
    const { hub } = await peerOf({});
    expect(hub.hellos[0].capabilities).toEqual({ features: ["checksSend"], maxMessageBytes: 4 * 1024 * 1024 });
  });

  it("the peer records what the hub declares, and trusts its send check through the feature alone", async () => {
    const { peer } = await peerOf({ capabilities: { features: ["checksSend", "later"], maxMessageBytes: 1024 } });
    expect(peer.hubCapabilities).toEqual({ features: ["checksSend", "later"], maxMessageBytes: 1024 });
    expect(peer.hubChecksSend).toBe(true);
  });

  it("a hub from before #115 that sends only checksSend: true still has its send check trusted", async () => {
    const { peer } = await peerOf({ checksSend: true });
    expect(peer.hubCapabilities).toEqual({ features: [], maxMessageBytes: null });
    expect(peer.hubChecksSend).toBe(true);
  });

  it("a hub that declares neither has no send check and no features", async () => {
    const { peer } = await peerOf({ capabilities: { features: ["other"] } });
    expect(peer.hubCapabilities).toEqual({ features: ["other"], maxMessageBytes: null });
    expect(peer.hubChecksSend).toBe(false);
  });
});
