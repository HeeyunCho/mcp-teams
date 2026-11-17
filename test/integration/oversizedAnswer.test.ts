// #193: over TCP (WebSocket), an answer larger than the receiver takes fails only that call. The
// extension checks an answer against the limit the hub's welcome declares and sends a short error
// instead; the hub does the same for an answer to a peer over the limit the peer declared. Either
// way the connection stays up and the other calls on it carry on. (The native connection's check
// is in workerNative.test.ts.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIDGE_OPTIONS } from "../../src/bridge.js";
import { bridgeHarness, FAST, TOKEN, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { connectWorker, createFakeChrome, loadWorker, openedSockets, stopWorkers } from "../helpers/fakeChrome.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness | undefined;
let link: { disconnect: () => Promise<void> } | undefined;

afterEach(async () => {
  await link?.disconnect();
  // No retry may wait to run after the test, without its fake chrome (#99).
  stopWorkers();
  link = undefined;
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** Big payloads: the real keep-alive, so a pong queued behind the data doesn't drop the connection. */
const BIG = { ...FAST, keepAliveMs: DEFAULT_BRIDGE_OPTIONS.keepAliveMs };
const LIMIT = 16 * 1024;
/** 30 chats with 1 KB titles: a listChats answer of over 30 KB. */
const bigChats = Array.from({ length: 30 }, (_, i) => ({ id: `19:contoso-${i}@thread.v2`, title: `Contoso ${i} ${"x".repeat(1_000)}`, chatType: "chat", members: [] }));
const ALEX = { Groups: [{ Suggestions: [{ DisplayName: "Alex Doe", EmailAddresses: ["alex.doe@contoso.example"] }] }] };

describe("an answer over the limit, over TCP (#193)", () => {
  it("the extension: two calls in flight, one answer over the hub's declared limit; only that call fails, too large, and the other succeeds", async () => {
    h = await bridgeHarness(BIG);
    const hub = await h.session("1.0.0", { maxMessageBytes: LIMIT });
    // People search answers only when the test lets it go, so it is in flight while the big answer goes.
    let letGo!: () => void;
    const substrate = () => new Promise((r) => (letGo = () => r(ALEX)));
    const csa = () => ({ teams: [], chats: bigChats });
    const fake = createFakeChrome({ services: { csa, substrate }, local: { token: TOKEN, port: h.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, () => hub.connected);

    const people = hub.call("findPeople", { query: "Alex" }, 30_000);
    people.catch(() => {}); // awaited below
    await until(() => fake.count("substrate") === 1, 3_000, "the people search reaches Teams");
    await expect(hub.call("listChats", {}, 30_000)).rejects.toThrow(/^The answer was too large to pass on over the WebSocket connection \(.* KB; the limit is 16 KB\)\. Nothing else was affected\./);
    letGo();
    await expect(people).resolves.toMatchObject({ people: [{ name: "Alex Doe" }] });
    expect(hub.extensions).toHaveLength(1);
  }, 15_000);

  it("a peer: an answer over the limit the peer declared fails only that call, too large; its other call and another peer's carry on", async () => {
    h = await bridgeHarness(BIG);
    const hub = await h.session();
    // readMessages answers with 32 KB; the others answer when the test lets them go.
    const held: (() => void)[] = [];
    await h.extension({
      handle: (req) =>
        req.method === "readMessages" ? { messages: ["x".repeat(32 * 1024)] } : new Promise((r) => held.push(() => r({ from: "Chrome", method: req.method }))),
    });
    const small = await h.session("1.0.0", { maxMessageBytes: LIMIT });
    const other = await h.session();
    await until(() => small.connected && other.connected, 3_000, "both peers see the extension");

    const mine = small.call("listChats", {}, 30_000);
    const theirs = other.call("listTeams", {}, 30_000);
    mine.catch(() => {}); // awaited below
    theirs.catch(() => {});
    await until(() => held.length === 2, 3_000, "both peers' calls reach the extension");
    await expect(small.call("readMessages", {}, 30_000)).rejects.toThrow(/^The answer was too large to pass on to this session \(.* KB; the limit is 16 KB\)\. Nothing else was affected\./);
    for (const letGo of held) letGo();
    await expect(mine).resolves.toEqual({ from: "Chrome", method: "listChats" });
    await expect(theirs).resolves.toEqual({ from: "Chrome", method: "listTeams" });
    expect(hub.inFlight).toEqual({ pending: 0, peerCalls: 0 });
  }, 15_000);
});
