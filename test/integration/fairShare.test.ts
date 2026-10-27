// Sessions share the Teams tab fairly: the hub lets a limited number of calls run on each
// extension at once, and a freed turn goes round the sessions (the hub's own calls are one
// session, each peer another), so one session's long scans can't starve another's quick read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLostCall, NOT_SENT } from "../../src/bridge.js";
import { bridgeHarness, FAST, TOKEN, type BridgeHarness, type FakeExtension, type Request } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";
import { connectWorker, createFakeChrome, loadWorker, openedSockets, reply } from "../helpers/fakeChrome.js";

let h: BridgeHarness | undefined;
let link: { disconnect: () => Promise<void> } | undefined;

afterEach(async () => {
  await link?.disconnect();
  link = undefined;
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Teams tab that works on one request at a time, in the order they arrive: a scan takes
 * scanMs, anything else readMs. So what it is sent first finishes first.
 */
function oneAtATime(scanMs: number, readMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  return (req: Request) => {
    const work = chain.then(() => sleep(req.method === "searchTranscripts" ? scanMs : readMs).then(() => ({ ok: true, method: req.method })));
    chain = work;
    return work;
  };
}

describe("fair sharing", () => {
  it("2.4: one session's 10 slow scans don't starve another session's read: it finishes before the 3rd scan", async () => {
    h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 2 });
    const a = await h.session(); // the hub: its own calls are one session
    const ext = await h.extension({ handle: oneAtATime(150, 10) });
    const b = await h.session(); // a peer: another session
    await until(() => a.connected && b.connected, 3_000, "both sessions see the extension");

    const scansDone: number[] = [];
    const scans = Array.from({ length: 10 }, (_, i) =>
      a.call("searchTranscripts", { query: `contoso ${i}` }, 30_000).then(() => (scansDone[i] = Date.now())),
    );
    await until(() => ext.requests().length >= 1, 3_000, "the first scan reaches the extension");
    let readDone = 0;
    const read = b.call("listChats", {}, 30_000).then(() => (readDone = Date.now()));

    await Promise.all([...scans, read]);
    expect(readDone, "B's read finished before A's 3rd scan").toBeLessThan(scansDone[2]);
  }, 15_000);
});

/**
 * A Teams tab whose scans run until let go (each one held separately), and that answers
 * anything else at once.
 */
function heldScans() {
  const held: (() => void)[] = [];
  const handle = (req: Request) =>
    req.method === "searchTranscripts" ? new Promise((r) => held.push(() => r({ ok: true }))) : { ok: true, method: req.method };
  return { handle, letGo: () => held.splice(0).forEach((go) => go()) };
}

/** A hub that runs one call at a time on its extension, a peer, and the extension. */
async function oneTurn(handle: (req: Request) => unknown) {
  h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 1 });
  const hub = await h.session();
  const ext = await h.extension({ handle, version: "0.2.13" }); // sends need 0.2.13 or newer
  const peer = await h.session();
  await until(() => hub.connected && peer.connected, 3_000, "both sessions see the extension");
  return { hub, peer, ext };
}

const sentOf = (ext: FakeExtension, method: string) => ext.requests().filter((r) => r.method === method).length;

describe("waiting for a turn", () => {
  it("2.4: a call cancelled while it waits for its turn leaves the line: nothing is sent, nothing stays in flight, not a lost call", async () => {
    const tab = heldScans();
    const { hub, peer, ext } = await oneTurn(tab.handle);
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    await until(() => sentOf(ext, "searchTranscripts") === 1, 3_000, "the scan holds the only turn");

    // The hub's own call...
    const own = new AbortController();
    const ownRead = hub.call("listChats", {}, 30_000, own.signal);
    // ...and a peer's, relayed through the hub.
    const theirs = new AbortController();
    const peerRead = peer.call("readMessages", { conversation: "19:contoso-launch@thread.v2" }, 30_000, theirs.signal);
    peerRead.catch(() => {});
    ownRead.catch(() => {});
    await until(() => hub.queued === 2, 3_000, "both reads wait for a turn");
    expect(hub.inFlight).toEqual({ pending: 1, peerCalls: 1 });

    own.abort();
    theirs.abort();
    const err = await ownRead.then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/not sent/);
    expect(isLostCall(err!.message), "a call never sent is not a lost call").toBe(false);
    await expect(peerRead).rejects.toThrow();
    await until(() => hub.inFlight.peerCalls === 0, 3_000, "the hub drops the peer's call");
    expect(hub.queued).toBe(0);

    tab.letGo();
    await scan;
    await sleep(100);
    expect(ext.requests().map((r) => r.method)).toEqual(["searchTranscripts"]);
    expect(hub.inFlight).toEqual({ pending: 0, peerCalls: 0 });
    expect(peer.inFlight.pending).toBe(0);
  });

  it("2.4: a call whose time limit ends while it waits fails then, unsent, and its wait counts toward the limit", async () => {
    const tab = heldScans();
    const { hub, peer, ext } = await oneTurn(tab.handle);
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    await until(() => sentOf(ext, "searchTranscripts") === 1, 3_000, "the scan holds the only turn");

    const t0 = Date.now();
    const err = await hub.call("listChats", {}, 300).then(() => null, (e: Error) => e);
    const waited = Date.now() - t0;
    expect(err?.message).toMatch(/not sent/);
    expect(isLostCall(err!.message)).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(280);
    expect(waited).toBeLessThan(1_500);

    // A peer's deadline (sent with its call) ends the wait on the hub as well.
    const t1 = Date.now();
    const peerErr = await peer.call("listChats", {}, 300).then(() => null, (e: Error) => e);
    expect(Date.now() - t1).toBeLessThan(1_500);
    expect(peerErr?.message).toMatch(/not sent/);
    expect(hub.queued).toBe(0);

    tab.letGo();
    await scan;
    await sleep(100);
    expect(sentOf(ext, "listChats")).toBe(0);
  });

  it("2.4: a call waiting for its turn on a connection that closes fails as not sent", async () => {
    const tab = heldScans();
    const { hub, ext } = await oneTurn(tab.handle);
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    scan.catch(() => {});
    await until(() => sentOf(ext, "searchTranscripts") === 1, 3_000, "the scan holds the only turn");
    const read = hub.call("listChats", {}, 30_000).then(() => null, (e: Error) => e);
    await until(() => hub.queued === 1, 3_000, "the read waits for a turn");
    const t0 = Date.now();
    await ext.close();
    const err = await read;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(err?.message).toMatch(/not sent/);
    expect(isLostCall(err!.message)).toBe(false);
    expect(hub.queued).toBe(0);
  });

  it("2.4: no reason a waiting call fails with is a lost call", () => {
    for (const m of Object.values(NOT_SENT)) {
      const message = typeof m === "string" ? m : m(4);
      expect(isLostCall(message), message).toBe(false);
    }
  });
});

describe("calls that never wait for a turn", () => {
  it("2.4: a send waiting for the user's click holds no turn: another session's read still runs", async () => {
    let clicked!: () => void;
    const handle = (req: Request) =>
      req.method === "requestSend" ? new Promise((r) => (clicked = () => r({ sent: true }))) : { ok: true, method: req.method };
    const { hub, peer, ext } = await oneTurn(handle);
    const send = hub.call("requestSend", { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" }, 30_000);
    await until(() => sentOf(ext, "requestSend") === 1, 3_000, "the confirmation window is open");

    const t0 = Date.now();
    await expect(peer.call("listChats", {}, 30_000)).resolves.toMatchObject({ method: "listChats" });
    expect(Date.now() - t0).toBeLessThan(1_000);

    clicked();
    await expect(send).resolves.toEqual({ sent: true });
  });

  it("2.4: a send is sent at once while scans hold every turn", async () => {
    const tab = heldScans();
    const { hub, peer, ext } = await oneTurn(tab.handle);
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    await until(() => sentOf(ext, "searchTranscripts") === 1, 3_000, "the scan holds the only turn");
    const send = peer.call("requestSend", { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" }, 30_000);
    await until(() => sentOf(ext, "requestSend") === 1, 1_000, "the send reaches the extension");
    await send;
    tab.letGo();
    await scan;
  });

  it("2.4: status and reload answer while scans hold every turn", async () => {
    const tab = heldScans();
    const { hub, peer, ext } = await oneTurn(tab.handle);
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    await until(() => sentOf(ext, "searchTranscripts") === 1, 3_000, "the scan holds the only turn");
    const t0 = Date.now();
    await expect(hub.call("status", {}, 30_000)).resolves.toMatchObject({ method: "status" });
    await expect(peer.call("status", {}, 30_000)).resolves.toMatchObject({ method: "status" });
    await expect(hub.call("reloadAll", {}, 30_000)).resolves.toEqual({ reloading: 1 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    tab.letGo();
    await scan;
  });

  it("2.4: with two browsers, picking one (a status probe of each) doesn't wait behind the scans", async () => {
    h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 1 });
    const hub = await h.session();
    const tab1 = heldScans();
    const tab2 = heldScans();
    const ext1 = await h.extension({ handle: tab1.handle, instance: "profile-1" });
    const ext2 = await h.extension({ handle: tab2.handle, instance: "profile-2" });
    await until(() => hub.extensions.length === 2, 3_000, "both browsers connected");
    // No call has answered yet, so each call first probes both browsers' status.
    const scan = hub.call("searchTranscripts", { query: "contoso" }, 30_000);
    await until(() => sentOf(ext1, "searchTranscripts") + sentOf(ext2, "searchTranscripts") === 1, 3_000, "the scan holds a turn");
    const t0 = Date.now();
    const read = hub.call("listChats", {}, 300).then(
      () => "answered",
      (e: Error) => e.message,
    );
    // The read waits for its turn behind the scan (one at a time), but its probes were answered.
    await until(() => sentOf(ext1, "status") >= 2 && sentOf(ext2, "status") >= 2, 1_000, "the read's status probes reach both browsers");
    expect(Date.now() - t0).toBeLessThan(1_000);
    await read;
    tab1.letGo();
    tab2.letGo();
    await scan;
  });
});

describe("throttled calls and turns", () => {
  it("35: four reads waiting out a throttle hold no turn: another session's call to a service that isn't throttled finishes promptly", async () => {
    h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 4 });
    const hub = await h.session(); // session A
    let busy = true;
    // csa throttles for 3 s; substrate (people search) isn't throttled.
    const csa = () =>
      busy
        ? reply(429, { message: "Too many requests" }, { headers: { "retry-after": "3" } })
        : { teams: [], chats: [{ id: "19:contoso-launch@thread.v2", title: "Contoso launch", chatType: "chat", members: [] }] };
    const substrate = () => ({ Groups: [{ Suggestions: [{ DisplayName: "Alex Doe", EmailAddresses: ["alex.doe@contoso.example"] }] }] });
    const fake = createFakeChrome({ services: { csa, substrate }, local: { token: TOKEN, port: h.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, () => hub.connected);
    const peer = await h.session(); // session B
    await until(() => peer.connected, 3_000, "the peer sees the extension");

    let readsDone = 0;
    const reads = Array.from({ length: 4 }, () => hub.call("listTeams", {}, 30_000).then((r) => (readsDone++, r)));
    for (const r of reads) r.catch(() => {}); // awaited below
    await until(() => fake.count("csa") >= 1 && hub.inFlight.pending === 4, 3_000, "A's four reads reach the extension, and csa throttles");
    await sleep(200); // they now wait at csa's gate

    const t0 = Date.now();
    await expect(peer.call("findPeople", { query: "Alex" }, 30_000)).resolves.toMatchObject({ people: [{ name: "Alex Doe" }] });
    expect(Date.now() - t0, "B's call didn't wait for A's throttle").toBeLessThan(1_500);
    expect(readsDone, "A's reads still wait out the throttle").toBe(0);
    expect(fake.count("substrate")).toBe(1);

    busy = false;
    for (const r of await Promise.all(reads)) expect(r).toMatchObject({ teams: [] });
  }, 15_000);

  it("35: a call that got its turn back checks the gate again: it doesn't send while another call's 429 has shut it", async () => {
    h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 2 });
    const hub = await h.session(); // session A
    // csa throttles the first read for 1 s and the second for 2 s, then answers.
    const csaAt: number[] = [];
    const csa = () => {
      csaAt.push(Date.now());
      if (csaAt.length > 2) return { teams: [], chats: [] };
      const s = String(csaAt.length);
      return reply(429, { message: "Too many requests" }, { headers: { "retry-after": s } });
    };
    // People search (not throttled) answers when the test lets it go, so B holds its turns.
    const held: (() => void)[] = [];
    const substrate = () =>
      new Promise((r) => held.push(() => r({ Groups: [{ Suggestions: [{ DisplayName: "Alex Doe", EmailAddresses: ["alex.doe@contoso.example"] }] }] })));
    const fake = createFakeChrome({ services: { csa, substrate }, local: { token: TOKEN, port: h.port } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    link = await connectWorker(fake, () => hub.connected);
    const b = await h.session();
    const c = await h.session();
    await until(() => b.connected && c.connected, 3_000, "both peers see the extension");

    const x = hub.call("listTeams", {}, 30_000); // 429 for 1 s: X waits at the gate, its turn given back
    x.catch(() => {}); // settled below
    await until(() => csaAt.length === 1, 3_000, "A's read is throttled");
    await sleep(200);
    const bs = [b.call("findPeople", { query: "Alex" }, 30_000), b.call("findPeople", { query: "Alex" }, 30_000)];
    await until(() => held.length === 2, 3_000, "B's two calls hold both turns");
    const z = c.call("listTeams", {}, 30_000); // C's read waits for a turn, ahead of X's rejoin
    z.catch(() => {});
    await sleep(1_300); // X's gate is open again: X waits for its turn back, behind C
    held.shift()!(); // C's read takes the freed turn, gets a 429 for 2 s and gives its turn back to X
    await until(() => csaAt.length >= 3, 5_000, "A's read goes to csa again");
    held.shift()!();
    await Promise.allSettled([x, z, ...bs]);
    expect(csaAt[2], "A's read went to csa while C's 429 had shut the gate").toBeGreaterThanOrEqual(csaAt[1] + 2_000);
  }, 20_000);
});
