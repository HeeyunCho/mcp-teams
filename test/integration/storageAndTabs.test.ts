// 3.1: one tool call (one request the bridge sends the worker, run through dispatch) writes
// chrome.storage at most once and looks up the browser's tabs at most once, however many
// Teams requests it makes, and the waits for Teams' session or a tab's load listen for
// chrome's events instead of asking every 250-500 ms.
//
// In Chrome the worker's own requests in the Teams tab reach its webRequest listeners like
// Teams' own: `seesOwnRequests` makes the fake do the same.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, ME_OID, networkError, openedSockets, reply, SHAREPOINT_ORIGIN, TEAMS_ORIGIN, type FakeChrome, type SentRequest, type Worker } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

const ME = `8:orgid:${ME_OID}`;
const ALEX = "8:orgid:00000000-0000-4000-8000-0000000000d2";
const CHAT = "19:contoso-notes@thread.v2";
const PAGE = 20;
const PAGES = 3;

/** An untitled chat with Alex (named by mt), and three meeting chats with a transcript. */
const meetingId = (n: number) => `19:meeting_contoso-${n}@thread.v2`;
const callId = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
const dayOf = (n: number) => new Date(Date.parse("2026-09-30T09:00:00Z") - n * 86_400_000);
const transcriptUrl = (n: number) => `${SHAREPOINT_ORIGIN}/personal/alex_contoso_example/_api/v2.1/drives/d/items/i${n}/versions/current/media/transcripts/t${n}/content`;
const csa = () => ({
  teams: [],
  chats: [
    { id: CHAT, chatType: "chat", members: [{ mri: ME }, { mri: ALEX }] },
    ...[1, 2, 3].map((n) => ({
      id: meetingId(n),
      chatType: "meeting",
      title: `Contoso review ${n}`,
      meetingInformation: { subject: `Contoso review ${n}`, startTime: dayOf(n).toISOString() },
      meetingObjectsConfig: { configurations: { transcriptConfig: { hasTranscript: true } } },
      lastJoinAt: dayOf(n).toISOString(),
    })),
  ],
});
const mt = (req: SentRequest) => (Array.isArray(req.body) ? req.body.map((mri: string) => ({ mri, displayName: mri === ALEX ? "Alex Doe" : "Contoso User" })) : undefined);

/** The chat with Alex: PAGES pages of PAGE notes, newest first; a meeting chat: its call with a transcript. */
const chatsvc = (req: SentRequest) => {
  const m = /^\/v1\/users\/ME\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(req.path);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]);
  const meeting = /^19:meeting_contoso-(\d)@thread\.v2$/.exec(id);
  if (meeting) {
    const n = Number(meeting[1]);
    return {
      messages: [
        {
          id: "2",
          messagetype: "RichText/Media_CallRecording",
          originalarrivaltime: new Date(dayOf(n).getTime() + 3_700_000).toISOString(),
          content: `<URIObject type="Video.2/CallRecording.1"><RecordingStatus status="Success" code="200" /><Title>Contoso review ${n}</Title><Identifiers><Id type="callId" value="${callId(n)}" /></Identifiers><RecordingContent contentTypes="Transcript" timestamp="${dayOf(n).toISOString()}" duration="1:00:00.00"><item type="onedriveForBusinessTranscript" uri="${transcriptUrl(n)}" /></RecordingContent></URIObject>`,
        },
        {
          id: "1",
          messagetype: "Event/Call",
          originalarrivaltime: dayOf(n).toISOString(),
          properties: { skypeguid: callId(n) },
          content: `<partlist alt=""></partlist><callEventType>callStarted</callEventType><callId>${callId(n)}</callId>`,
        },
      ],
      _metadata: {},
    };
  }
  if (id !== CHAT) return undefined;
  const page = Number(new URLSearchParams(m[2]).get("syncState") ?? 0);
  return {
    messages: Array.from({ length: PAGE }, (_, i) => {
      const n = (PAGES - page) * PAGE - i;
      return { id: String(1_700_000_000_000 + n), messagetype: "RichText/Html", content: `<p>Note ${n}</p>`, imdisplayname: "Alex Doe", originalarrivaltime: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString() };
    }),
    _metadata:
      page + 1 < PAGES
        ? { backwardLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages?startTime=1&syncState=${page + 1}&pageSize=${PAGE}&view=msnp24Equivalent` }
        : {},
  };
};
const sharepoint = (req: SentRequest) => {
  const n = Number(/\/items\/i(\d+)\//.exec(req.url)?.[1]);
  return n ? { entries: [{ speakerDisplayName: "Alex Doe", startOffset: "00:00:01.0", endOffset: "00:00:05.0", text: `The budget for review ${n} is being worked out.` }] } : undefined;
};
const services = { csa, mt, chatsvc, sharepoint };

/** Runs one tool call as the bridge sends it; resolves with the worker's response. */
async function call(worker: Worker, method: string, params: object, timeoutMs = 30_000) {
  let response: any;
  await worker.dispatch({ type: "request", id: `r-${method}-${Math.random()}`, method, params, timeoutMs }, (r) => (response = r));
  return response;
}

/** The api_traffic log is saved half a second after the last request; let it be, so it counts for the call that caused it. */
const settle = () => new Promise((r) => setTimeout(r, 800));

/** Counts the storage writes and tab lookups of one call (and of the log save it causes). */
async function countsOf(fake: FakeChrome, run: () => Promise<any>) {
  fake.chrome.storage.session.set.mockClear();
  fake.chrome.storage.local.set.mockClear();
  fake.spies.tabsQuery.mockClear();
  const response = await run();
  await settle();
  expect(response).toMatchObject({ ok: true });
  return {
    writes: fake.chrome.storage.session.set.mock.calls.length + fake.chrome.storage.local.set.mock.calls.length,
    tabLookups: fake.spies.tabsQuery.mock.calls.length,
  };
}

/** A worker whose own Teams requests go through its webRequest listeners, as in Chrome. */
async function chromeLikeWorker(options: Parameters<typeof createFakeChrome>[0] = {}) {
  const fake = createFakeChrome({ services, seesOwnRequests: true, ...options });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  return { fake, worker };
}

/** Teams in the tab makes a request to chatsvc with this token; the worker captures it. */
const teamsChatRequest = (fake: FakeChrome, token: string) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`, requestHeaders: [{ name: "Authorization", value: token }] });

describe("3.1: one storage write and one tab lookup per call", () => {
  it("3.1: a read_messages over 3 pages writes storage at most once and looks up tabs once", async () => {
    const { fake, worker } = await chromeLikeWorker();
    expect(await call(worker, "listChats", {})).toMatchObject({ ok: true }); // the list, and Alex's name
    await settle();

    const counts = await countsOf(fake, () => call(worker, "readMessages", { conversation: CHAT, limit: PAGES * PAGE }));
    expect(fake.count("chatsvc", /contoso-notes/)).toBe(PAGES);
    expect(counts).toEqual({ writes: expect.any(Number), tabLookups: 1 });
    expect(counts.writes).toBeLessThanOrEqual(1);
  });

  it("3.1: a paged read_messages (the next page by cursor) writes storage at most once and looks up tabs once", async () => {
    const { fake, worker } = await chromeLikeWorker();
    const first = await call(worker, "readMessages", { conversation: CHAT, limit: PAGE * 2 });
    expect(first.result.olderCursor).toEqual(expect.any(String));
    await settle();

    const counts = await countsOf(fake, () => call(worker, "readMessages", { conversation: CHAT, limit: PAGE, cursor: first.result.olderCursor }));
    expect(counts).toEqual({ writes: expect.any(Number), tabLookups: 1 });
    expect(counts.writes).toBeLessThanOrEqual(1);
  });

  it("3.1: a list_chats read fresh (csa, then mt for names) writes storage at most once and looks up tabs once", async () => {
    const { fake, worker } = await chromeLikeWorker();
    const counts = await countsOf(fake, () => call(worker, "listChats", { refresh: true }));
    expect(fake.count("csa")).toBe(1);
    expect(fake.count("mt")).toBeGreaterThanOrEqual(1);
    expect(counts).toEqual({ writes: expect.any(Number), tabLookups: 1 });
    expect(counts.writes).toBeLessThanOrEqual(1);
  });

  it("3.1: a search_transcripts over 3 meetings (Teams and OneDrive) writes storage at most once and looks up tabs once", async () => {
    const { fake, worker } = await chromeLikeWorker();
    // It opens a OneDrive tab for the transcripts (no lookup: it just found none).
    const counts = await countsOf(fake, () => call(worker, "searchTranscripts", { query: "budget", meetings: 3 }));
    expect(fake.count("sharepoint")).toBe(3);
    expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ writes: expect.any(Number), tabLookups: 1 });
    expect(counts.writes).toBeLessThanOrEqual(1);
  });

  it("3.1: Teams' new token is still captured and used by the next call", async () => {
    const { fake, worker } = await chromeLikeWorker();
    expect(await call(worker, "readMessages", { conversation: CHAT, limit: PAGE })).toMatchObject({ ok: true });
    await teamsChatRequest(fake, "Bearer fake-renewed");
    const from = fake.sent.length;
    expect(await call(worker, "readMessages", { conversation: CHAT, limit: PAGE })).toMatchObject({ ok: true });
    const chat = fake.sent.slice(from).filter((r) => r.service === "chatsvc");
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((r) => r.headers.authorization === "Bearer fake-renewed")).toBe(true);
  });
});

describe("3.1: waits listen for chrome's events instead of polling", () => {
  /** Records when each call to `spy` was made, with the arguments it got. */
  const timed = <A extends unknown[]>(spy: { getMockImplementation(): ((...a: A) => any) | undefined; mockImplementation(f: (...a: A) => any): unknown }) => {
    const calls: { at: number; args: A }[] = [];
    const real = spy.getMockImplementation()!;
    spy.mockImplementation((...args: A) => {
      calls.push({ at: Date.now(), args });
      return real(...args);
    });
    return calls;
  };

  it("3.1: a call waiting for Teams' chat session doesn't read storage again until Teams makes its request, then goes on at once", async () => {
    const { fake, worker } = await chromeLikeWorker({ captured: ["csa", "mt", "substrate"] });
    const reads = timed(fake.chrome.storage.session.get);
    const start = Date.now();
    const done = call(worker, "readMessages", { conversation: CHAT, limit: PAGE }).then((r) => ({ r, at: Date.now() }));

    await new Promise((r) => setTimeout(r, 1_500));
    const firedAt = Date.now();
    await teamsChatRequest(fake, "Bearer fake-chat");
    const { r, at } = await done;

    expect(r).toMatchObject({ ok: true });
    const asked = (x: { args: unknown[] }) => [x.args[0]].flat().includes("capture:chatsvc");
    // Polling every 250 ms reads the capture 4 times or more in this second.
    expect(reads.filter((x) => asked(x) && x.at >= start + 400 && x.at < firedAt).length).toBe(0);
    expect(at - firedAt).toBeLessThan(1_000);
  });

  it("3.1: after a reload the call waits for the tab's load event, not asking for the tab every 250 ms, and retries only once it loaded", async () => {
    let expired = true;
    const reads: { at: number; token: string }[] = [];
    const fake = createFakeChrome({
      loadMs: 1_500,
      services: {
        ...services,
        chatsvc: (req) => {
          if (!/contoso-notes/.test(req.path)) return chatsvc(req);
          reads.push({ at: Date.now(), token: req.headers.authorization });
          return expired ? reply(401) : chatsvc(req);
        },
      },
    });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const gets = timed(fake.spies.tabsGet);
    const reloads: number[] = [];
    // The reload starts the tab loading; Teams' first request after it brings a fresh token.
    const reload = fake.spies.tabsReload.getMockImplementation()!;
    fake.spies.tabsReload.mockImplementation(async (id: number) => {
      reloads.push(Date.now());
      await reload(id);
      setTimeout(() => {
        expired = false;
        void teamsChatRequest(fake, "Bearer fake-fresh");
      }, 100);
    });

    const r = await call(worker, "readMessages", { conversation: CHAT, limit: PAGE });
    expect(r).toMatchObject({ ok: true });
    expect(reloads).toHaveLength(1);
    const loadedAt = reloads[0] + 1_500;
    expect(reads.map((x) => x.token)).toEqual(["Bearer fake", "Bearer fake-fresh"]);
    expect(reads[1].at).toBeGreaterThanOrEqual(loadedAt);
    // Polling asks for the loading tab every 250 ms: 5 times or more while it loads.
    expect(gets.filter((g) => g.at > reloads[0] && g.at < loadedAt - 100).length).toBeLessThanOrEqual(1);
  });

  it("3.1: a Teams tab the worker opens is used once Teams makes its first request there, with the same session as before", async () => {
    const { fake, worker } = await chromeLikeWorker({ teamsTab: false });
    const done = call(worker, "readMessages", { conversation: CHAT, limit: PAGE }).then((r) => ({ r, at: Date.now() }));
    await vi.waitFor(() => expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300));
    const firedAt = Date.now();
    await teamsChatRequest(fake, "Bearer fake"); // the session the worker already holds
    const { r, at } = await done;
    expect(r).toMatchObject({ ok: true });
    expect(at - firedAt).toBeLessThan(3_000);
  });

  it("3.1: a Teams tab closed while it reloads ends the call's wait for it at once", async () => {
    const fake = createFakeChrome({ loadMs: 20_000, services: { ...services, chatsvc: (req) => (/contoso-notes/.test(req.path) ? reply(401) : chatsvc(req)) } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const reload = fake.spies.tabsReload.getMockImplementation()!;
    let closedAt = 0;
    fake.spies.tabsReload.mockImplementation(async (id: number) => {
      await reload(id);
      setTimeout(async () => {
        await teamsChatRequest(fake, "Bearer fake-fresh");
        await new Promise((r) => setTimeout(r, 300));
        closedAt = Date.now();
        fake.closeTab(id);
      }, 100);
    });
    const done = call(worker, "readMessages", { conversation: CHAT, limit: PAGE }, 4_000);
    // It goes on (opening Teams again) instead of waiting for the closed tab to load.
    await vi.waitFor(() => expect(fake.spies.tabsCreate).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(closedAt).toBeGreaterThan(0);
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    expect(await done).toMatchObject({ ok: false, error: expect.stringContaining("time limit") });
  });

  it("3.1: a call waiting for Teams' session still ends at its time limit", async () => {
    const { worker } = await chromeLikeWorker({ captured: ["csa", "mt", "substrate"] });
    const start = Date.now();
    const r = await call(worker, "readMessages", { conversation: CHAT, limit: PAGE }, 800);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("time limit") });
    expect(Date.now() - start).toBeLessThan(1_500);
  });
});

describe("3.1: a Teams tab that changes during a call is looked up again", () => {
  /** The tab each meeting chat's messages (sessionsOf) were read in, in order. */
  const meetingTabs = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && /meeting_contoso/.test(r.path)).map((r) => r.tabId);

  /** OneDrive's transcripts; once the first is read, `change` runs (between two of the call's requests). */
  function afterFirstTranscript(change: () => void) {
    let changed = false;
    return (req: SentRequest) => {
      const answer = sharepoint(req);
      if (!changed) {
        changed = true;
        change();
      }
      return answer;
    };
  }

  /** A search_transcripts over the three meetings, and how many tab lookups it made. */
  async function search(fake: FakeChrome, worker: Worker) {
    fake.spies.tabsQuery.mockClear();
    const r = await call(worker, "searchTranscripts", { query: "budget", meetings: 3 });
    return { r, tabLookups: fake.spies.tabsQuery.mock.calls.length };
  }

  const allThree = {
    ok: true,
    result: { meetingsSearched: 3, matches: 3, results: [1, 2, 3].map((n) => expect.objectContaining({ meeting: `Contoso review ${n}` })) },
  };

  it("3.1: Teams closed and opened again (a new tab) between two requests of a search_transcripts: the next request runs in the new tab and all three meetings are searched", async () => {
    let fake: FakeChrome | undefined;
    const sharepointOnce = afterFirstTranscript(() => {
      fake!.closeTab(1);
      fake!.tabs.push({ id: 7, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    });
    const started = await chromeLikeWorker({ services: { ...services, sharepoint: sharepointOnce } });
    fake = started.fake;

    const { r, tabLookups } = await search(fake, started.worker);
    expect(r).toMatchObject(allThree);
    expect(r.result.skipped).toBeUndefined();
    expect(meetingTabs(fake)).toEqual([1, 7, 7]);
    expect(tabLookups).toBe(2); // at the start, and once more after the tab went away
  });

  it("3.1: the Teams tab went to OneDrive between two requests (pageFetch: status 0 there) and Teams is open in another tab: the next request runs there and all three meetings are searched", async () => {
    let fake: FakeChrome | undefined;
    const sharepointOnce = afterFirstTranscript(() => {
      fake!.tabs[0].url = `${SHAREPOINT_ORIGIN}/`;
      fake!.tabs.push({ id: 8, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    });
    // From a page that isn't Teams, Teams' services don't answer the page's fetch (CORS).
    const inTeams = (req: SentRequest) => !!fake!.tabs.find((t) => t.id === req.tabId)?.url.startsWith(`${TEAMS_ORIGIN}/`);
    const started = await chromeLikeWorker({ services: { ...services, sharepoint: sharepointOnce, chatsvc: (req) => (inTeams(req) ? chatsvc(req) : networkError("Failed to fetch")) } });
    fake = started.fake;

    const { r, tabLookups } = await search(fake, started.worker);
    expect(r).toMatchObject(allThree);
    expect(r.result.skipped).toBeUndefined();
    expect(meetingTabs(fake)).toEqual([1, 1, 8, 8]);
    expect(tabLookups).toBe(2);
  });
});
