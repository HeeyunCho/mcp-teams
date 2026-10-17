// Self-tests of test/helpers/bridgeHarness.ts: hubs, peers and the scripted fake extension.
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHarness, type BridgeHarness, until } from "../helpers/bridgeHarness.js";

describe("bridge harness", () => {
  let h: BridgeHarness;
  afterEach(async () => h?.cleanup());

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
});
