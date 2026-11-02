// With no Teams tab open, list_teams and list_chats say so at once instead of opening a tab and
// waiting. The real worker (extension/background.js) runs under a fake chrome, each request
// through dispatch, as the bridge sends it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, type Worker } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

const READ_TIMEOUT_MS = 120_000; // what src/tools.ts gives both tools
const csa = () => ({ teams: [{ id: "19:contoso@thread.tacv2", displayName: "Contoso", channels: [] }], chats: [] });

/** Runs one request as the bridge sends it; resolves with the worker's response and how long it took. */
async function request(worker: Worker, method: string, params: object = {}) {
  const start = Date.now();
  const replies: any[] = [];
  await worker.dispatch({ type: "request", id: "r1", method, params, timeoutMs: READ_TIMEOUT_MS }, (r) => replies.push(r));
  return { reply: replies[0], ms: Date.now() - start };
}

describe("no Teams tab open", () => {
  it("list_teams fails at once, opens no tab and sends nothing", async () => {
    const fake = createFakeChrome({ services: { csa }, teamsTab: false });
    const worker = await loadWorker(fake);
    const { reply, ms } = await request(worker, "listTeams");
    expect(reply).toMatchObject({ id: "r1", ok: false, error: expect.stringContaining("no Teams tab open") });
    expect(ms).toBeLessThan(1_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
  });

  it("list_chats fails at once, opens no tab and sends nothing", async () => {
    const fake = createFakeChrome({ services: { csa }, teamsTab: false });
    const worker = await loadWorker(fake);
    const { reply, ms } = await request(worker, "listChats");
    expect(reply).toMatchObject({ id: "r1", ok: false, error: expect.stringContaining("no Teams tab open") });
    expect(ms).toBeLessThan(1_000);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
  });

  it("list_chats fails the same way without any captured session", async () => {
    const fake = createFakeChrome({ services: { csa }, teamsTab: false, captured: [] });
    const worker = await loadWorker(fake);
    const { reply, ms } = await request(worker, "listChats");
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("no Teams tab open") });
    expect(ms).toBeLessThan(1_000);
  });

  it("a list cached before the tab closed is not answered once no tab is open", async () => {
    const fake = createFakeChrome({ services: { csa } });
    const worker = await loadWorker(fake);
    expect((await request(worker, "listTeams")).reply).toMatchObject({ ok: true });
    fake.closeTab(1);
    expect((await request(worker, "listTeams")).reply).toMatchObject({ ok: false, error: expect.stringContaining("no Teams tab open") });
  });

  it("setup's openTab still opens Teams in the background and answers once it has signed in", async () => {
    const fake = createFakeChrome({ services: { csa }, teamsTab: false });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const done = request(worker, "listTeams", { refresh: true, openTab: true });
    await vi.waitFor(() => expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300));
    // Teams in the new tab makes its first request; the worker captures the session.
    await fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`, requestHeaders: [{ name: "Authorization", value: "Bearer fake" }] });
    expect((await done).reply).toMatchObject({ ok: true, result: { teams: [{ id: "19:contoso@thread.tacv2" }] } });
  });
});

describe("a Teams tab is open", () => {
  it("list_teams and list_chats read as before", async () => {
    const fake = createFakeChrome({ services: { csa } });
    const worker = await loadWorker(fake);
    expect((await request(worker, "listTeams")).reply).toMatchObject({ ok: true, result: { teams: [{ id: "19:contoso@thread.tacv2" }] } });
    expect((await request(worker, "listChats")).reply).toMatchObject({ ok: true, result: { total: 0 } });
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it.each(["listTeams", "listChats"])("%s: a frozen or asleep tab still fails after 60 s with the message that says so", async (method) => {
    const fake = createFakeChrome({ services: { csa } });
    fake.freezeTab(1);
    const worker = await loadWorker(fake);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled: { reply: any } | null = null;
    void request(worker, method).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled!.reply).toMatchObject({
      ok: false,
      error: "The Teams tab did not run the request within 60 s (it may be frozen or asleep). Reload the Teams tab and try again.",
    });
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });
});
