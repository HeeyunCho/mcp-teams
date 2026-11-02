// A missing or rejected session is recaptured in a background Teams tab (the helper), which stays
// open up to a minute while tool calls wait on it. A call that is withdrawn meanwhile (the server
// cancels it, its time limit passes, its connection closes) no longer waits: once no call waits
// for the helper anymore, it is closed at once rather than left open for nobody. A call that still
// waits keeps it open. The real worker (extension/background.js) runs under a fake chrome, each
// request through dispatch, as the bridge sends it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, reply, type FakeChrome, type Worker } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** Where the worker records the background tab it opened (chrome.storage.session). */
const HELPER_KEY = "recaptureHelperTab";

/** A worker that runs as usual, holding the `captured` sessions only (the others are missing). */
async function runningWorker(captured: NonNullable<NonNullable<Parameters<typeof createFakeChrome>[0]>["captured"]>) {
  const fake = createFakeChrome({ captured, services: { csa: () => ({ teams: [], chats: [] }), chatsvc: () => ({ messages: [] }) } });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return { fake, worker };
}

/** Runs one request as the bridge sends it; `done` resolves once the worker answered. */
function request(worker: Worker, id: string, method: string, params: object = {}, timeoutMs = 300_000) {
  const replies: any[] = [];
  return { id, replies, done: worker.dispatch({ type: "request", id, method, params, timeoutMs }, (r) => replies.push(r)) };
}

/** The server withdraws the request. */
const cancel = (worker: Worker, id: string) => worker.dispatch({ type: "cancel", id }, () => {});

/** Lets the worker run for `ms` of (fake) time. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const helperTabs = (fake: FakeChrome) => fake.tabs.filter((t) => t.id !== 1);

/** Teams asks for its team and chat list (csa) with a fresh session: Chrome shows it to the worker. */
const teamsListRequest = (fake: FakeChrome) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v2/teams/users/me?isPrefetch=false`, requestHeaders: [{ name: "Authorization", value: "Bearer fake-fresh-csa" }] });

describe("the only call waiting for the background tab is withdrawn", () => {
  it("by the server (cancel): the tab is closed at once, not after its minute", async () => {
    const { fake, worker } = await runningWorker(["chatsvc", "mt", "substrate"]);
    const list = request(worker, "r1", "listChats");
    await pass(5_000);
    expect(helperTabs(fake)).toHaveLength(1);
    await cancel(worker, "r1");
    await pass(1_000);
    await list.done;
    expect(list.replies[0]).toMatchObject({ ok: false });
    expect(helperTabs(fake)).toEqual([]);
    expect(fake.session.has(HELPER_KEY)).toBe(false);
  });

  it("by its time limit passing: the tab is closed at once", async () => {
    const { fake, worker } = await runningWorker(["chatsvc", "mt", "substrate"]);
    const list = request(worker, "r1", "listChats", {}, 10_000);
    await pass(5_000);
    expect(helperTabs(fake)).toHaveLength(1);
    await pass(6_000); // the 10 s limit passed
    await list.done;
    expect(list.replies[0]).toMatchObject({ ok: false, error: expect.stringContaining("time limit") });
    expect(helperTabs(fake)).toEqual([]);
    expect(fake.session.has(HELPER_KEY)).toBe(false);
  });

  it("before Teams' own tab had its moment: no background tab is opened for it", async () => {
    const { fake, worker } = await runningWorker(["chatsvc", "mt", "substrate"]);
    const list = request(worker, "r1", "listChats");
    await pass(2_000);
    await cancel(worker, "r1");
    await list.done;
    await pass(10_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("a later call that needs the same session starts its own wait (and gets it)", async () => {
    const { fake, worker } = await runningWorker(["chatsvc", "mt", "substrate"]);
    const first = request(worker, "r1", "listChats");
    await pass(5_000);
    await cancel(worker, "r1");
    await pass(1_000);
    const second = request(worker, "r2", "listChats", { refresh: true });
    await pass(5_000);
    expect(helperTabs(fake)).toHaveLength(1);
    await teamsListRequest(fake);
    await pass(2_000);
    await Promise.all([first.done, second.done]);
    expect(second.replies[0]).toMatchObject({ ok: true });
    expect(helperTabs(fake)).toEqual([]);
  });
});

describe("one of several calls waiting for the background tab is withdrawn", () => {
  it("another call for the same session keeps it open, and succeeds once the session is back", async () => {
    const { fake, worker } = await runningWorker(["chatsvc", "mt", "substrate"]);
    const first = request(worker, "r1", "listChats");
    const second = request(worker, "r2", "listChats", { refresh: true });
    await pass(5_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    await cancel(worker, "r1");
    await pass(10_000);
    await first.done;
    expect(first.replies[0]).toMatchObject({ ok: false });
    expect(helperTabs(fake)).toHaveLength(1);
    await teamsListRequest(fake);
    await pass(2_000);
    await second.done;
    expect(second.replies[0]).toMatchObject({ ok: true });
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    expect(helperTabs(fake)).toEqual([]);
  });

  it("a call for another session keeps it open; it closes once that session is back", async () => {
    // The chat session is rejected (401) at once; the team list's only once `expired`.
    let expired = false;
    const fake = createFakeChrome({
      services: {
        chatsvc: (req) => (req.headers.authorization === "Bearer fake" ? reply(401) : { messages: [] }),
        csa: (req) => (expired && req.headers.authorization === "Bearer fake" ? reply(401) : { teams: [], chats: [] }),
      },
    });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const read = request(worker, "r2", "readMessages", { conversation: "19:contoso-notes@thread.v2", limit: 5 });
    await pass(1_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1); // opened for the chat session
    expired = true;
    const list = request(worker, "r1", "listChats", { refresh: true }); // joins it for the team list
    await pass(1_000);
    await cancel(worker, "r2"); // the one waiting for the chat session
    await pass(10_000);
    await read.done;
    expect(read.replies[0]).toMatchObject({ ok: false });
    expect(helperTabs(fake)).toHaveLength(1);
    await teamsListRequest(fake);
    await pass(2_000);
    await list.done;
    expect(list.replies[0]).toMatchObject({ ok: true });
    expect(helperTabs(fake)).toEqual([]);
  });
});

describe("after the extension reloads, its recovery's background tab", () => {
  it("stays open for the recovery when a call that joined it is withdrawn", async () => {
    const fake = createFakeChrome({ captured: [], services: { csa: () => ({ teams: [], chats: [] }) } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const l of fake.chrome.runtime.onInstalled.listeners) l({ reason: "update" });
    await pass(20_000); // the recovery's tab is open, waiting for the chat session
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    const list = request(worker, "r1", "listChats");
    await pass(6_000);
    await cancel(worker, "r1");
    await pass(10_000);
    await list.done;
    expect(helperTabs(fake)).toHaveLength(1);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
  });
});
