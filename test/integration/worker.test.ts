// The extension's service worker (extension/background.js) against a fake chrome with Teams
// open (test/helpers/fakeChrome.ts). These are also the fake's self-tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, EXTENSION_VERSION, loadWorker, ME_OID, networkError, never, openedSockets, reply, TEAMS_ORIGIN, timedOut, type SentRequest } from "../helpers/fakeChrome.js";

const CHAT = "19:contoso-launch@thread.v2";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";

/** The csa list: one titled group chat. */
const csa = () => ({ teams: [], chats: [{ id: CHAT, title: "Contoso launch", chatType: "chat", members: [{ mri: `8:orgid:${ME_OID}` }, { mri: ALEX }] }] });

/** A chatsvc message from Alex Doe, `minutes` past nine. */
const message = (id: number, minutes: number) => ({
  id: String(id),
  messagetype: "RichText/Html",
  content: `<p>Update ${id} from Alex</p>`,
  imdisplayname: "Alex Doe",
  from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${ALEX}`,
  originalarrivaltime: `2026-10-01T09:${String(minutes).padStart(2, "0")}:00.000Z`,
});

/** chatsvc: `pages` pages of messages, newest first, linked by backwardLink. */
const chatsvc = (pages: number, perPage = 3) => (req: SentRequest) => {
  if (!/\/conversations\/.+\/messages/.test(req.path)) return undefined;
  const page = Number(/[?&]page=(\d+)/.exec(req.path)?.[1] ?? 0);
  const first = (pages - page) * perPage;
  return {
    messages: Array.from({ length: perPage }, (_, i) => message(first - i, first - i)),
    _metadata: page + 1 < pages ? { backwardLink: `${BASES.chatsvc}/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages?page=${page + 1}` } : {},
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

describe("service worker outside Chrome", () => {
  it("loads under a fake chrome without connecting or registering listeners", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    expect(Object.keys(worker.handlers)).toContain("readMessages");
    expect(openedSockets).toEqual([]);
    expect(fake.listenerCounts()).toEqual({ onMessage: 0, windowsOnRemoved: 0, storageOnChanged: 0, webRequest: 0, onAlarm: 0 });
  });

  it("registerListeners() registers the chrome listeners, still without connecting", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    expect(fake.listenerCounts()).toEqual({ onMessage: 2, windowsOnRemoved: 1, storageOnChanged: 1, webRequest: 3, onAlarm: 1 });
    expect(openedSockets).toEqual([]);
  });

  it("dispatch answers a request with the handler's result", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    const send = vi.fn();
    await worker.dispatch({ type: "request", id: "r1", method: "status", params: {} }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: "response", id: "r1", ok: true, result: { extensionVersion: EXTENSION_VERSION, teamsTabs: 1 } });
  });

  it("dispatch answers an unknown method with an error", async () => {
    const worker = await loadWorker(createFakeChrome());
    const send = vi.fn();
    await worker.dispatch({ type: "request", id: "r2", method: "toString" }, send);
    expect(send).toHaveBeenCalledWith({ type: "response", id: "r2", ok: false, error: "Unknown method toString" });
  });
});

describe("fake chrome", () => {
  it("routes readMessages to the fake services and counts the requests", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: chatsvc(1) } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 30 });
    expect(r.conversation).toEqual({ id: CHAT, kind: "group", title: "Contoso launch" });
    expect(r.messages.map((m: any) => m.text)).toEqual(["Update 1 from Alex", "Update 2 from Alex", "Update 3 from Alex"]);
    expect(fake.count("chatsvc", /\/messages/)).toBe(1);
    expect(fake.count("csa")).toBe(1);
    expect(fake.count("mt")).toBe(0);
  });

  it("follows chatsvc's backward links, one request per page", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: chatsvc(3) } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 30 });
    expect(r.count).toBe(9);
    expect(fake.count("chatsvc", /\/messages/)).toBe(3);
  });

  it("turns a reply() status into the worker's HTTP error", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: () => reply(403, { message: "Forbidden" }) } });
    const worker = await loadWorker(fake);
    await expect(worker.handlers.readMessages({ conversation: CHAT })).rejects.toThrow(/Teams HTTP 403 \(chatsvc\)/);
  });

  it("never() is a frozen tab: the call stays pending", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: () => never() } });
    const worker = await loadWorker(fake);
    const outcome = await Promise.race([worker.handlers.readMessages({ conversation: CHAT }).then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 200))]);
    expect(outcome).toBe("pending");
    expect(fake.count("chatsvc")).toBe(1);
  });

  it("runs a tab script only in a tab that exists, like Chrome", async () => {
    const fake = createFakeChrome({ services: { csa } });
    await loadWorker(fake);
    const pageFetch = async function pageFetch() {};
    const run = (tabId: number) => fake.chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: pageFetch, args: [`${BASES.csa}/x`, "GET", {}, null, 1] });
    await expect(run(42)).rejects.toThrow("No tab with id: 42.");
    fake.closeTab(1);
    await expect(run(1)).rejects.toThrow("No tab with id: 1.");
    expect(fake.tabs).toEqual([]);
  });

  it("a Teams tab closed between finding it and running in it: a read looks the tabs up again and runs in the Teams tab still open", async () => {
    const fake = createFakeChrome({ services: { csa } });
    fake.tabs.push({ id: 2, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    const worker = await loadWorker(fake);
    // The worker finds tab 1, then the user closes it before the request runs there.
    const query = fake.spies.tabsQuery.getMockImplementation()!;
    fake.spies.tabsQuery.mockImplementationOnce(async (q) => {
      const found = await query(q);
      fake.closeTab(1);
      return found;
    });
    const send = vi.fn();
    await worker.dispatch({ type: "request", id: "r3", method: "listChats", params: {} }, send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "response", id: "r3", ok: true }));
    expect(fake.sent.map((r) => r.tabId)).toEqual([2]);
  });

  it("networkError() is a fetch that failed in the page: the worker's 'Could not reach Teams' error with the reason", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: () => networkError("Failed to fetch") } });
    const worker = await loadWorker(fake);
    await expect(worker.handlers.readMessages({ conversation: CHAT })).rejects.toThrow("Could not reach Teams: Failed to fetch");
    expect(fake.count("chatsvc")).toBe(1);
  });

  it("timedOut() is a request the page gave up on: the worker's 'did not answer' error", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc: () => timedOut() } });
    const worker = await loadWorker(fake);
    await expect(worker.handlers.readMessages({ conversation: CHAT })).rejects.toThrow("Teams did not answer within 60 s. Reload the Teams tab and try again.");
  });

  it("captures a session from a Teams request fired at the worker's webRequest listeners", async () => {
    const fake = createFakeChrome({ captured: [] });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v1/teams/users/me`, requestHeaders: [{ name: "Authorization", value: "Bearer fake-token" }] });
    expect(fake.session.get("capture:csa")).toMatchObject({ base: BASES.csa, headers: { authorization: "Bearer fake-token" } });
  });

  it("opens the confirmation window and reports when the user closes it", async () => {
    const fake = createFakeChrome({ services: { csa } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const result = worker.handlers.requestSend({ conversation: CHAT, text: "Hi Alex" });
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
    const win = await fake.spies.windowsCreate.mock.results[0].value;
    expect(await fake.pageMessage("confirm.html?id=x", { type: "confirm:get", id: /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1] })).toMatchObject({
      request: { conversation: { id: CHAT }, text: "Hi Alex" },
    });
    fake.closeWindow(win.id);
    await expect(result).resolves.toEqual({ sent: false, reason: "The user closed the confirmation window; nothing was sent." });
    expect(fake.count("chatsvc")).toBe(0);
  });
});
