// Self-tests of test/helpers/bridgeHarness.ts: hubs, peers and the scripted fake extension.
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHarness, type BridgeHarness, stall, until } from "../helpers/bridgeHarness.js";

describe("bridge harness", () => {
  let h: BridgeHarness;
  let other: Server | undefined;
  afterEach(async () => {
    await h?.cleanup();
    await new Promise<void>((r) => (other ? other.close(() => r()) : r()));
    other = undefined;
  });

  /**
   * Another test file (or program) running alongside listens on a port: the one the harness
   * reports, if it reports one before anything of its own holds it; else any free port.
   */
  async function listenAlongside(of: BridgeHarness): Promise<Server> {
    let port = 0;
    try {
      port = of.port;
    } catch {}
    const srv = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    });
    return srv;
  }

  it("23: a program listening alongside can't take the harness's port before its first session starts", async () => {
    h = await bridgeHarness();
    other = await listenAlongside(h);
    const hub = await h.session();
    expect(hub.role).toBe("hub");
    await h.extension();
    expect(hub.connected).toBe(true);
  });

  it("a peer's call reaches the scripted fake extension through the hub", async () => {
    h = await bridgeHarness();
    const hub = await h.session("1.0.0");
    const peer = await h.session("1.0.0");
    expect([hub.role, peer.role]).toEqual(["hub", "peer"]);
    const ext = await h.extension({ handle: (req) => ({ echo: req.method, p: req.params }) });
    await until(() => peer.connected, 3_000, "peer to see the extension");
    await expect(peer.call("listChats", { query: "Alex Doe" })).resolves.toEqual({ echo: "listChats", p: { query: "Alex Doe" } });
    expect(ext.requests().map((r) => r.method)).toEqual(["listChats"]);
  });

  it("passes the fake extension's errors back to the caller", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    await h.extension({
      handle: () => {
        throw new Error("No chat or channel matches \"Sam Roe\".");
      },
    });
    await expect(hub.call("readMessages")).rejects.toThrow(/Sam Roe/);
  });

  it("the hub drops a frozen fake extension within a few FAST keep-alive periods", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    await h.extension({ pong: false, reconnect: false });
    expect(hub.connected).toBe(true);
    await until(() => !hub.connected, 2_000, "the frozen extension to be dropped");
  });

  it("the fake extension follows the port to a peer that takes over from the hub", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    await h.extension({ handle: () => "from the extension" });
    await hub.close();
    await until(() => peer.role === "hub" && peer.connected, 5_000, "the peer to take over");
    await expect(peer.call("status")).resolves.toBe("from the extension");
  });

  it("stall holds back a due timer for at least the given time", async () => {
    const t0 = performance.now();
    const fired = new Promise<number>((r) => setTimeout(() => r(performance.now()), 0));
    stall(100);
    expect((await fired) - t0).toBeGreaterThanOrEqual(100);
  });
});
