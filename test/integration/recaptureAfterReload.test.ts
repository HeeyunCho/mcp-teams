// After the extension reloads (an update, reload_extension), Chrome has cleared
// chrome.storage.session, so the captured Teams sessions are gone. A Teams tab left in
// the background may make no request of its own for a long time, so status said "session not
// captured" until someone used Teams. The worker now gets Teams to sign in again without
// touching the user's tab: it opens Teams in a background tab next to it, and closes that tab
// once Teams' requests there brought the session back. The real worker (extension/background.js)
// runs under a fake chrome; the reload is Chrome's onInstalled event for the new worker.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, TEAMS_ORIGIN, type FakeChrome, type Worker } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** A Teams tab is open (id 1) and nothing is captured: the worker right after it was reloaded. */
async function reloadedWorker(options: Parameters<typeof createFakeChrome>[0] = {}) {
  const fake = createFakeChrome({ captured: [], ...options });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return { fake, worker };
}

/** Chrome starts the new worker after an update or reload and reports it (`reason`), or reports a browser start. */
function chromeReports(fake: FakeChrome, event: "onInstalled" | "onStartup", reason = "update") {
  for (const l of fake.chrome.runtime[event].listeners) l(event === "onInstalled" ? { reason } : undefined);
}

/** Teams makes a chat request with its session: Chrome shows it to the worker. */
const teamsChatRequest = (fake: FakeChrome) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`, requestHeaders: [{ name: "Authorization", value: "Bearer fake-fresh" }] });
/** Teams asks for its team and chat list (csa), as it does on every load. */
const teamsListRequest = (fake: FakeChrome) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v2/teams/users/me?isPrefetch=false`, requestHeaders: [{ name: "Authorization", value: "Bearer fake-fresh-csa" }] });

/** Where the worker records the background tab it opened (chrome.storage.session). */
const HELPER_KEY = "recaptureHelperTab";

const captured = async (worker: Worker) => (await worker.handlers.status({})).sessions[0].sessionCaptured as boolean;

/** Lets the worker run for `ms` of (fake) time. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("after the extension reloads with a Teams tab open and no session", () => {
  it("opens Teams in a background tab, captures the session from its requests, then closes that tab; the user's tab is left alone", async () => {
    const { fake, worker } = await reloadedWorker();
    expect(await captured(worker)).toBe(false);
    chromeReports(fake, "onInstalled", "update");

    await pass(30_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    const [{ url, active }] = fake.spies.tabsCreate.mock.calls[0];
    expect(url).toBe(`${TEAMS_ORIGIN}/`);
    expect(active).toBe(false);
    const helperId = (await fake.spies.tabsCreate.mock.results[0].value).id;

    await teamsChatRequest(fake);
    await pass(2_000);
    expect(await captured(worker)).toBe(true);
    expect(fake.spies.tabsRemove).toHaveBeenCalledWith(helperId);
    expect(fake.tabs.map((t) => t.id)).toEqual([1]);
    // Nothing ran in or reloaded the user's tab (a call, a draft or a screen share there goes on).
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
    expect(fake.spies.executeScript).not.toHaveBeenCalled();
  });

  it("does the same on a fresh install", async () => {
    const { fake } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "install");
    await pass(30_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it("a tool call meanwhile waits for that instead of reloading the user's tab, and succeeds once the session is back", async () => {
    const { fake, worker } = await reloadedWorker({ services: { csa: () => ({ teams: [], chats: [] }) } });
    chromeReports(fake, "onInstalled", "update");
    const replies: any[] = [];
    const done = worker.dispatch({ type: "request", id: "r1", method: "listChats", params: {}, timeoutMs: 120_000 }, (r) => replies.push(r));
    await pass(30_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
    // Teams loads in the background tab and calls its services.
    await teamsListRequest(fake);
    await teamsChatRequest(fake);
    await pass(5_000);
    await done;
    expect(replies[0]).toMatchObject({ id: "r1", ok: true });
    expect(fake.count("csa")).toBeGreaterThan(0);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
  });

  it("records the background tab while it is open, and forgets it once closed", async () => {
    const { fake } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    const helperId = (await fake.spies.tabsCreate.mock.results[0].value).id;
    expect(fake.session.get(HELPER_KEY)).toBe(helperId);
    await teamsChatRequest(fake);
    await pass(2_000);
    expect(fake.session.has(HELPER_KEY)).toBe(false);
  });

  it("waits for Teams' own requests first: a tab that sends one soon gets no second tab", async () => {
    const { fake, worker } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    await pass(3_000);
    await teamsChatRequest(fake);
    await pass(60_000);
    expect(await captured(worker)).toBe(true);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("never reloads a Teams tab, even one in a call (audible)", async () => {
    const { fake } = await reloadedWorker();
    fake.tabs[0].audible = true;
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    await teamsChatRequest(fake);
    await pass(2_000);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
    expect(fake.spies.executeScript).not.toHaveBeenCalled();
  });

  it("leaves the background tab open if the user switched to it", async () => {
    const { fake, worker } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    const helper = fake.tabs.find((t) => t.id !== 1)!;
    helper.active = true;
    await teamsChatRequest(fake);
    await pass(2_000);
    expect(await captured(worker)).toBe(true);
    expect(fake.spies.tabsRemove).not.toHaveBeenCalled();
  });

  it("closes the background tab when Teams doesn't sign in there in time", async () => {
    const { fake, worker } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    await pass(120_000);
    expect(fake.spies.tabsRemove).toHaveBeenCalledTimes(1);
    expect(fake.tabs.map((t) => t.id)).toEqual([1]);
    expect(await captured(worker)).toBe(false);
  });
});

describe("nothing is opened", () => {
  it("without a Teams tab", async () => {
    const { fake } = await reloadedWorker({ teamsTab: false });
    chromeReports(fake, "onInstalled", "update");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });

  it("when the only Teams tab is discarded (asleep): it isn't woken for this", async () => {
    const { fake } = await reloadedWorker();
    fake.tabs[0].discarded = true;
    chromeReports(fake, "onInstalled", "update");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
  });

  it("when the session is still captured", async () => {
    const { fake } = await reloadedWorker({ captured: ["chatsvc", "csa", "mt", "substrate"] });
    chromeReports(fake, "onInstalled", "update");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("when only the worker restarted (no reload, update or browser start), or Chrome itself updated", async () => {
    const { fake } = await reloadedWorker();
    await pass(120_000);
    chromeReports(fake, "onInstalled", "chrome_update");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("twice when Chrome reports the reload twice (one background tab at most)", async () => {
    const { fake } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it("on a browser start (restored tabs load, or are asleep, by themselves)", async () => {
    const { fake } = await reloadedWorker();
    chromeReports(fake, "onStartup");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("when the Teams tab is still loading (it will call its services itself)", async () => {
    const { fake } = await reloadedWorker();
    fake.tabs[0].status = "loading";
    chromeReports(fake, "onInstalled", "update");
    await pass(120_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });
});

/** Runs one request as the bridge sends it; the promise resolves with the worker's reply. */
function request(worker: Worker, method: string, params: object = {}, timeoutMs = 120_000) {
  const replies: any[] = [];
  return { replies, done: worker.dispatch({ type: "request", id: "r1", method, params, timeoutMs }, (r) => replies.push(r)) };
}

describe("after a reload, the extension never reloads the user's Teams tab for a missing service", () => {
  it("chatsvc comes back first and the background tab closes: a call that needs csa says so, without a reload", async () => {
    const { fake, worker } = await reloadedWorker({ services: { csa: () => ({ teams: [], chats: [] }) } });
    chromeReports(fake, "onInstalled", "update");
    const { replies, done } = request(worker, "listChats");
    await pass(30_000);
    await teamsChatRequest(fake); // Teams in the background tab: chats first, its list not yet
    await pass(90_000);
    expect(fake.spies.tabsRemove).toHaveBeenCalledTimes(1);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
    await done;
    expect(replies[0]).toMatchObject({ ok: false, error: expect.stringContaining("team list session is not available") });
  });

  it("search (substrate, signed in only once the search box was used) says so, without a reload", async () => {
    const { fake, worker } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    await pass(30_000);
    await teamsChatRequest(fake);
    await pass(2_000);
    const { replies, done } = request(worker, "searchMessages", { query: "contoso" });
    await pass(90_000);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
    await done;
    expect(replies[0]).toMatchObject({ ok: false, error: expect.stringContaining("search session is not available") });
  });

  it("a call that gave up while the recovery waited causes no reload once the recovery fails", async () => {
    const { fake, worker } = await reloadedWorker();
    chromeReports(fake, "onInstalled", "update");
    const { replies, done } = request(worker, "listChats", {}, 5_000);
    await pass(10_000);
    await done;
    expect(replies[0]).toMatchObject({ ok: false });
    await pass(180_000); // Teams never signs in in the background tab
    expect(fake.spies.tabsRemove).toHaveBeenCalledTimes(1);
    expect(fake.spies.tabsReload).not.toHaveBeenCalled();
  });

  it("without a reload or update, a missing session still reloads the Teams tab as before", async () => {
    const { fake, worker } = await reloadedWorker({ services: { csa: () => ({ teams: [], chats: [] }) } });
    const { done } = request(worker, "listChats");
    await pass(10_000);
    expect(fake.spies.tabsReload).toHaveBeenCalledWith(1);
    await teamsListRequest(fake);
    await pass(5_000);
    await done;
  });
});

describe("a background tab left over from a suspended worker", () => {
  /** A worker starts with tab 200 recorded as its background tab (`open`: the tab still exists), and Chrome's reconnect alarm wakes it. */
  async function startsWith(open: { active: boolean } | null) {
    const fake = createFakeChrome();
    if (open) fake.tabs.push({ id: 200, url: `${TEAMS_ORIGIN}/`, status: "complete", active: open.active });
    fake.session.set(HELPER_KEY, 200);
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const l of fake.chrome.alarms.onAlarm.listeners) l({ name: "reconnect" });
    return fake;
  }

  it("is closed, and forgotten", async () => {
    const fake = await startsWith({ active: false });
    await vi.waitFor(() => expect(fake.spies.tabsRemove).toHaveBeenCalledWith(200));
    expect(fake.tabs.map((t) => t.id)).toEqual([1]);
    await vi.waitFor(() => expect(fake.session.has(HELPER_KEY)).toBe(false));
  });

  it("is kept if the user switched to it, and forgotten", async () => {
    const fake = await startsWith({ active: true });
    await vi.waitFor(() => expect(fake.session.has(HELPER_KEY)).toBe(false));
    expect(fake.spies.tabsRemove).not.toHaveBeenCalled();
    expect(fake.tabs.map((t) => t.id)).toEqual([1, 200]);
  });

  it("that is already gone is just forgotten", async () => {
    const fake = await startsWith(null);
    await vi.waitFor(() => expect(fake.session.has(HELPER_KEY)).toBe(false));
    expect(fake.spies.tabsRemove).not.toHaveBeenCalled();
  });
});
