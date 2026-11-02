// After a reload, recaptureAfterReload may open Teams in a background tab of its own (the helper,
// recorded in chrome.storage.session) and close it once the session is back. A tool request must
// never run in that tab while it is open: if the user's own Teams tab was still loading, the
// request went to the helper (loaded) and failed with "The tab was closed." when it closed.
// The real worker (extension/background.js) runs under a fake chrome, each request through
// dispatch, as the bridge sends it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, ME_OID, openedSockets, TEAMS_ORIGIN, type FakeChrome, type Worker } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** Where the worker records the background tab it opened (chrome.storage.session). */
const HELPER_KEY = "recaptureHelperTab";
const HELPER = 200;

type Services = NonNullable<Parameters<typeof createFakeChrome>[0]>["services"];

const csa = () => ({ teams: [], chats: [] });

/**
 * The user's Teams tab (1) is still loading; the helper (200) has loaded and is in the
 * background. `recorded`: the worker still has it as its helper (false: it was kept and forgotten).
 */
async function withHelper({ recorded = true, services = { csa } as Services } = {}) {
  const fake = createFakeChrome({ services });
  fake.tabs[0].status = "loading";
  fake.tabs.push({ id: HELPER, url: `${TEAMS_ORIGIN}/`, status: "complete", active: false });
  if (recorded) fake.session.set(HELPER_KEY, HELPER);
  const worker = await loadWorker(fake);
  return { fake, worker };
}

/** Runs one request as the bridge sends it; resolves with the worker's response. */
async function request(worker: Worker, method: string, params: object = {}) {
  const replies: any[] = [];
  await worker.dispatch({ type: "request", id: "r1", method, params, timeoutMs: 120_000 }, (r) => replies.push(r));
  return replies[0];
}

/** The tabs the worker ran its requests in. */
const ranIn = (fake: FakeChrome) => fake.spies.executeScript.mock.calls.map(([{ target }]) => target.tabId);

describe("while the recapture helper tab is open", () => {
  it("a tool request doesn't run in it, even when the user's own tab is still loading", async () => {
    const { fake, worker } = await withHelper();
    expect(await request(worker, "listChats")).toMatchObject({ ok: true });
    expect(ranIn(fake).length).toBeGreaterThan(0);
    expect(ranIn(fake)).not.toContain(HELPER);
  });

  it("closing it doesn't fail a request in flight (a post, which is never sent twice)", async () => {
    // An auto-send to notes to self: the one request that posts without a window.
    const me = `8:orgid:${ME_OID}`;
    let answerPost!: () => void;
    const posted = new Promise<void>((r) => (answerPost = r));
    const { fake, worker } = await withHelper({
      services: {
        csa: () => ({ teams: [], chats: [{ id: "48:notes", title: null, chatType: "chat", members: [{ mri: me }] }] }),
        mt: (req) => (/fetchShortProfile/.test(req.path) ? [{ mri: me, displayName: "Pat Lee", email: "pat.lee@contoso.example" }] : undefined),
        chatsvc: (req) => (req.method === "POST" ? posted.then(() => ({ OriginalArrivalTime: Date.parse("2026-10-01T09:00:00Z") })) : undefined),
      },
    });
    const reply = request(worker, "requestSend", { conversation: "48:notes", text: "Remember the slides", autoSendTo: ["pat.lee@contoso.example"] });
    await vi.waitFor(() => expect(fake.sent.some((r) => r.service === "chatsvc" && r.method === "POST")).toBe(true));
    // Teams signed in there: the worker closes its helper while the post is on its way.
    fake.closeTab(HELPER);
    answerPost();
    expect(await reply).toMatchObject({ ok: true, result: { sent: true } });
  });
});

describe("when the helper is the only Teams tab (the user closed theirs)", () => {
  async function onlyHelper(services: Services = { csa }) {
    const { fake, worker } = await withHelper({ services });
    fake.closeTab(1);
    return { fake, worker };
  }

  it("list_chats says no Teams tab is open, at once, and runs nothing in the helper", async () => {
    const { fake, worker } = await onlyHelper();
    expect(await request(worker, "listChats")).toMatchObject({ ok: false, error: expect.stringContaining("no Teams tab open") });
    expect(ranIn(fake)).toEqual([]);
  });

  it("status doesn't count it as a Teams tab", async () => {
    const { worker } = await onlyHelper();
    expect(await worker.handlers.status({})).toMatchObject({ teamsTabs: 0 });
  });

  it("another read opens Teams in a tab of its own, as with no Teams tab, rather than use the helper", async () => {
    const { fake, worker } = await onlyHelper({ chatsvc: () => ({ messages: [] }) });
    worker.registerListeners();
    const reply = request(worker, "readMessages", { conversation: "48:notes" });
    await vi.waitFor(() => expect(fake.spies.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ pinned: true, active: false })));
    // Teams in the new tab makes its first request; the worker captures the session.
    await fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`, requestHeaders: [{ name: "Authorization", value: "Bearer fake" }] });
    expect(await reply).toMatchObject({ ok: true });
    const opened = (await fake.spies.tabsCreate.mock.results[0].value).id;
    expect(ranIn(fake).length).toBeGreaterThan(0);
    expect(new Set(ranIn(fake))).toEqual(new Set([opened]));
  });
});

describe("once the user switched to the helper, while it is still recorded", () => {
  it("is a Teams tab like any other at once, not only after the worker forgets it", async () => {
    const { fake, worker } = await withHelper();
    fake.tabs[1].active = true;
    expect(await request(worker, "listChats")).toMatchObject({ ok: true });
    expect(ranIn(fake)).toContain(HELPER);
    expect(await worker.handlers.status({})).toMatchObject({ teamsTabs: 2 });
  });
});

describe("once the user switched to the helper, it was kept and forgotten", () => {
  it("is a Teams tab like any other: a request may run there", async () => {
    const { fake, worker } = await withHelper({ recorded: false });
    fake.tabs[1].active = true;
    expect(await request(worker, "listChats")).toMatchObject({ ok: true });
    expect(ranIn(fake)).toContain(HELPER);
    expect(await worker.handlers.status({})).toMatchObject({ teamsTabs: 2 });
  });
});

describe("with no helper tab", () => {
  it("a request runs in the Teams tab that has loaded, as before, not one still loading", async () => {
    const fake = createFakeChrome({ services: { csa } });
    fake.tabs[0].status = "loading";
    fake.tabs.push({ id: 300, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    const worker = await loadWorker(fake);
    expect(await request(worker, "listChats")).toMatchObject({ ok: true });
    expect(new Set(ranIn(fake))).toEqual(new Set([300]));
    expect(await worker.handlers.status({})).toMatchObject({ teamsTabs: 2 });
  });
});
