// Throttling: when Teams answers 429 with Retry-After, the worker sends nothing more to that
// service until the wait is over, a caller hears that Teams is busy, and a list built
// without the names it couldn't look up says so. The real worker (extension/background.js)
// runs under a fake chrome; the waits are real (one or two seconds).
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, ME_OID, openedSockets, reply, TEAMS_ORIGIN, type Worker } from "../helpers/fakeChrome.js";

const ALEX = "8:orgid:00000000-0000-4000-8000-000000000002";
const SAM = "8:orgid:00000000-0000-4000-8000-000000000003";
const ME = `8:orgid:${ME_OID}`;

/** csa's view: one untitled group chat with Alex and Sam, and a meeting Sam organized. */
const csa = () => ({
  teams: [],
  chats: [
    { id: "19:contoso-group@thread.v2", chatType: "chat", members: [{ mri: ME }, { mri: ALEX }, { mri: SAM }], lastMessage: { composeTime: "2026-10-01T09:00:00Z" } },
    {
      id: "19:meeting_contoso-review@thread.v2",
      chatType: "meeting",
      title: "Contoso review",
      meetingInformation: { subject: "Contoso review", startTime: "2026-09-30T09:00:00Z", organizerId: SAM.slice("8:orgid:".length) },
      members: [],
    },
  ],
});
/** mt's short profiles for whoever is asked. */
const profiles = (req: { body: string[] }) =>
  req.body.map((mri) => ({ mri, displayName: mri === ALEX ? "Alex Doe" : mri === SAM ? "Sam Roe" : "Contoso User" }));
const throttled = (seconds: string) => reply(429, { message: "Too many requests" }, { headers: { "retry-after": seconds } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** Runs one request as the bridge sends it; resolves with the worker's response and how long it took. */
async function request(worker: Worker, method: string, params: object, timeoutMs: number) {
  const start = Date.now();
  const replies: any[] = [];
  await worker.dispatch({ type: "request", id: "r1", method, params, timeoutMs }, (r) => replies.push(r));
  return { reply: replies[0], ms: Date.now() - start };
}

describe("throttling (429 with Retry-After)", () => {
  it("2.2: after mt answers 429 with Retry-After: 2, nothing goes to mt for 2 s, and list_chats says names are missing (throttled)", async () => {
    let busy = true;
    const mtAt: number[] = []; // when each mt request was sent
    const fake = createFakeChrome({
      services: {
        csa,
        mt: (req) => {
          mtAt.push(Date.now());
          return busy ? throttled("2") : profiles(req);
        },
      },
    });
    const worker = await loadWorker(fake);
    const t0 = Date.now(); // the 429 comes after this, so the gate stays shut until t0 + 2 s at least

    const first = await request(worker, "listChats", {}, 10_000);
    expect(first.reply).toMatchObject({ ok: true });
    expect(first.reply.result.note).toMatch(/names missing \(throttled\)/i);
    expect(mtAt).toHaveLength(1);
    const t1 = Date.now(); // the 429 came before this, so the gate is open again by t1 + 2 s
    busy = false;

    // Within the 2 s, about halfway and near the end: the gap is noted again rather than cached silently.
    await sleep(Math.max(0, t0 + 1_000 - Date.now()));
    const second = await request(worker, "listChats", {}, 10_000);
    expect(second.reply).toMatchObject({ ok: true });
    if (Date.now() < t0 + 2_000) expect(second.reply.result.note).toMatch(/names missing \(throttled\)/i);
    await sleep(Math.max(0, t0 + 1_800 - Date.now()));
    await request(worker, "listChats", {}, 10_000);

    // Once the wait is over: names again, and no note.
    await sleep(Math.max(0, t1 + 2_300 - Date.now()));
    const third = await request(worker, "listChats", {}, 10_000);
    expect(third.reply.result.note).toBeUndefined();
    expect(third.reply.result.chats.map((c: any) => c.title)).toContain("Alex Doe, Sam Roe");

    // However slow the machine: no mt request until the 2 s were over, then one again.
    expect(mtAt.length).toBeGreaterThan(1);
    for (const at of mtAt.slice(1)) expect(at).toBeGreaterThanOrEqual(t0 + 2_000);
  });

  it("2.2: list_meetings says organizer names are missing (throttled) when mt is throttled", async () => {
    const fake = createFakeChrome({ services: { csa, mt: () => throttled("2") } });
    const worker = await loadWorker(fake);
    const { reply: r } = await request(worker, "listMeetings", {}, 10_000);
    expect(r).toMatchObject({ ok: true });
    expect(r.result.note).toMatch(/names missing \(throttled\)/i);
    expect(fake.count("mt")).toBe(1);
  });

  it("2.2: get_meeting says the organizer's name is missing (throttled) when mt is throttled", async () => {
    const fake = createFakeChrome({ services: { csa, mt: () => throttled("2"), chatsvc: () => ({ messages: [] }) } });
    const worker = await loadWorker(fake);
    const { reply: r } = await request(worker, "getMeeting", { meeting: "Contoso review" }, 10_000);
    expect(r).toMatchObject({ ok: true, result: { meeting: { organizer: SAM } } });
    expect(r.result.note).toMatch(/name missing \(throttled\)/i);
  });

  it("2.2: a throttled service fails the call with 'Teams is busy (throttled)', and a call within the wait sends nothing", async () => {
    const fake = createFakeChrome({ services: { csa: () => throttled("2") } });
    const worker = await loadWorker(fake);

    // A 1 s deadline can't wait 2 s: busy, at once.
    const first = await request(worker, "listChats", {}, 1_000);
    expect(first.reply).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\) for 2 s; try again after that/) });
    expect(first.ms).toBeLessThan(900);
    expect(fake.count("csa")).toBe(1);

    const second = await request(worker, "listTeams", {}, 1_000);
    expect(second.reply).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\) for [12] s/) });
    expect(second.ms).toBeLessThan(500);
    expect(fake.count("csa")).toBe(1);
  });

  it("2.2: a call to a throttled service waits out Retry-After when that fits its deadline", async () => {
    let calls = 0;
    const fake = createFakeChrome({ services: { csa: () => (calls++ === 0 ? throttled("1") : csa()), mt: profiles } });
    const worker = await loadWorker(fake);
    const { reply: r, ms } = await request(worker, "listTeams", {}, 5_000);
    expect(r).toMatchObject({ ok: true });
    expect(fake.count("csa")).toBe(2);
    expect(ms).toBeGreaterThanOrEqual(950);
  });

  it("2.2: Retry-After given as an HTTP date is honoured too", async () => {
    const fake = createFakeChrome({ services: { csa: () => reply(429, {}, { headers: { "retry-after": new Date(Date.now() + 3_000).toUTCString() } }) } });
    const worker = await loadWorker(fake);
    const first = await request(worker, "listTeams", {}, 500);
    expect(first.reply).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\) for [23] s/) });
    const second = await request(worker, "listTeams", {}, 500);
    expect(second.reply).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\)/) });
    expect(fake.count("csa")).toBe(1);
  });

  it("2.2: a send whose post Teams throttles after the click says it failed (Teams refused it), and is not sent again", async () => {
    const fake = createFakeChrome({ services: { csa, mt: profiles, chatsvc: (req) => (req.method === "POST" ? throttled("2") : undefined) } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const replies: any[] = [];
    const done = worker.dispatch({ type: "request", id: "s1", method: "requestSend", params: { conversation: "19:contoso-group@thread.v2", text: "Hi both" }, timeoutMs: 60_000 }, (r) => replies.push(r));
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
    const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
    await fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });
    await done;
    expect(replies[0].result).toMatchObject({ sent: false, reason: expect.stringMatching(/^Sending failed: Teams is busy \(throttled\)/) });
    expect(replies[0].result.reason).not.toMatch(/may have been posted/);
    expect(fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST")).toHaveLength(1);
  });

  it("2.2: a chat looked up by a person's name while names are throttled says why it isn't found", async () => {
    const fake = createFakeChrome({ services: { csa, mt: () => throttled("2"), chatsvc: () => ({ messages: [] }) } });
    const worker = await loadWorker(fake);
    const { reply: r } = await request(worker, "readMessages", { conversation: "Alex Doe" }, 10_000);
    // On its own line, after the lookup's own message (which may end in a list of ids).
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/\nChat names missing \(throttled\)/) });
  });

  it("2.2: names that fail to load for another reason are noted too, with the reason, not as throttled", async () => {
    const fake = createFakeChrome({ services: { csa, mt: () => reply(500, { message: "Internal error" }) } });
    const worker = await loadWorker(fake);
    const { reply: r } = await request(worker, "listChats", {}, 10_000);
    expect(r).toMatchObject({ ok: true });
    expect(r.result.note).toMatch(/Chat names missing: .*Teams HTTP 500 \(mt\)/);
    expect(r.result.note).not.toMatch(/throttled/);
  });

  it("2.2: a person given by id for a new chat is named after Teams' throttle, not shown as the raw id", async () => {
    let calls = 0;
    const fake = createFakeChrome({ services: { csa, mt: (req) => (calls++ === 0 ? throttled("1") : profiles(req)) } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    void worker.dispatch({ type: "request", id: "s1", method: "requestSend", params: { to: [ALEX], text: "Hi Alex" }, timeoutMs: 60_000 }, () => {});
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
    const shown = (await fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:get", id })) as { request: { people: { name: string }[] } };
    expect(shown.request.people.map((p) => p.name)).toEqual(["Alex Doe"]);
  });

  it("2.2: a person given by id whose name can't be looked up before the deadline fails the send as busy (no window with a raw id)", async () => {
    const fake = createFakeChrome({ services: { csa, mt: () => throttled("5") } });
    const worker = await loadWorker(fake);
    const { reply: r } = await request(worker, "requestSend", { to: [ALEX], text: "Hi Alex" }, 2_000);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\)/) });
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });

  it("2.2: a throttle on one service base doesn't hold calls to another (another region or tenant)", async () => {
    const other = `${TEAMS_ORIGIN}/api/csa/amer`;
    const fake = createFakeChrome({ services: { csa: (req) => (req.url.startsWith(`${BASES.csa}/`) ? throttled("5") : csa()), mt: profiles } });
    const worker = await loadWorker(fake);
    const first = await request(worker, "listTeams", {}, 1_000);
    expect(first.reply).toMatchObject({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\)/) });
    fake.session.set("capture:csa", { base: other, region: "amer", headers: { authorization: "Bearer fake-other" }, at: 2 });
    const second = await request(worker, "listTeams", {}, 1_000);
    expect(second.reply).toMatchObject({ ok: true });
    expect(fake.sent.filter((q) => q.url.startsWith(`${other}/`))).toHaveLength(1);
  });

  it("2.2: get_meeting calls a missing organizer name throttled only when its own lookup was throttled", async () => {
    let throttle = false;
    // mt doesn't know Sam (no profile), and later throttles a different lookup.
    const fake = createFakeChrome({ services: { csa, mt: (req) => (throttle ? throttled("5") : profiles(req).filter((p) => p.mri !== SAM)), chatsvc: () => ({ messages: [] }) } });
    const worker = await loadWorker(fake);
    await request(worker, "listMeetings", {}, 10_000); // the list (cached for a minute) has no name for Sam: not throttled
    throttle = true;
    await request(worker, "requestSend", { to: ["8:orgid:00000000-0000-4000-8000-000000000004"], text: "Hi" }, 1_000); // closes mt's gate
    const { reply: r } = await request(worker, "getMeeting", { meeting: "Contoso review" }, 10_000);
    expect(r).toMatchObject({ ok: true, result: { meeting: { organizer: SAM } } });
    expect(r.result.note ?? "").not.toMatch(/throttled/);
  });
});
