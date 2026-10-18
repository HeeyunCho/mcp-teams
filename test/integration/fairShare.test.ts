// Sessions share the Teams tab fairly: the hub lets a limited number of calls run on each
// extension at once, and a freed turn goes round the sessions (the hub's own calls are one
// session, each peer another), so one session's long scans can't starve another's quick read.
import { afterEach, describe, expect, it } from "vitest";
import { isLostCall, NOT_SENT } from "../../src/bridge.js";
import { bridgeHarness, FAST, until, type BridgeHarness, type FakeExtension, type Request } from "../helpers/bridgeHarness.js";

let h: BridgeHarness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
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
  const ext = await h.extension({ handle });
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
