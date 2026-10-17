// Throttling: when Teams answers 429 with Retry-After, the worker sends nothing more to that
// service until the wait is over, a caller hears that Teams is busy, and a list built
// without the names it couldn't look up says so. The real worker (extension/background.js)
// runs under a fake chrome; the waits are real (one or two seconds).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, loadWorker, ME_OID, openedSockets, reply, type Worker } from "../helpers/fakeChrome.js";

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
    const fake = createFakeChrome({ services: { csa, mt: (req) => (busy ? throttled("2") : profiles(req)) } });
    const worker = await loadWorker(fake);

    const first = await request(worker, "listChats", {}, 10_000);
    expect(first.reply).toMatchObject({ ok: true });
    expect(first.reply.result.note).toMatch(/names missing \(throttled\)/i);
    expect(fake.count("mt")).toBe(1);

    // Within the 2 s: still nothing to mt, and the gap is noted again rather than cached silently.
    busy = false;
    await sleep(1_000);
    const second = await request(worker, "listChats", {}, 10_000);
    expect(second.reply).toMatchObject({ ok: true });
    expect(second.reply.result.note).toMatch(/names missing \(throttled\)/i);
    expect(fake.count("mt")).toBe(1);

    // Once the wait is over: names again, and no note.
    await sleep(1_300);
    const third = await request(worker, "listChats", {}, 10_000);
    expect(fake.count("mt")).toBeGreaterThan(1);
    expect(third.reply.result.note).toBeUndefined();
    expect(third.reply.result.chats.map((c: any) => c.title)).toContain("Alex Doe, Sam Roe");
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
});
