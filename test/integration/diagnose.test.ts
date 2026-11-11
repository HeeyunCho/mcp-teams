// #143: what the bridge tells server.log (BridgeOptions.diagnose): its role and how it got it, the
// hand-over to a newer server, the extensions coming and going (with the close code), and, as a
// peer, the hub closing. Real sockets, the harness's FAST timings.
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHarness, type BridgeHarness } from "../helpers/bridgeHarness.js";
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
    const ext = await h.extension();
    await until(() => events.some((e) => e.event === "extensions" && e.fields.count === 1), 3_000, "the extension's arrival");
    await ext.close();
    await until(() => events.some((e) => e.event === "extension-closed"), 3_000, "the extension's close");
    expect(events).toEqual([
      { event: "role", fields: { role: "hub", via: "tcp" } },
      { event: "extensions", fields: { count: 1, transport: "websocket" } },
      { event: "extension-closed", fields: { code: expect.any(Number), transport: "websocket" } },
      { event: "extensions", fields: { count: 0 } },
    ]);
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
