// Meeting tools (get_meeting, read_transcript, search_transcripts in extension/background.js)
// against a fake chatsvc whose meeting chats page like Teams (newest first, backwardLink to
// the next older page) and a fake OneDrive holding each call's transcript.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, reply, SHAREPOINT_ORIGIN, TEAMS_ORIGIN, type SentRequest } from "../helpers/fakeChrome.js";

/** Meeting chat n (1 = most recent). */
const meetingId = (n: number) => `19:meeting_contoso-${String(n).padStart(3, "0")}@thread.v2`;
const callId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const transcriptUrl = (n: number) => `${SHAREPOINT_ORIGIN}/personal/alex_contoso_example/_api/v2.1/drives/d/items/i${n}/versions/current/media/transcripts/t${n}/content`;
const dayOf = (n: number) => new Date(Date.parse("2026-09-30T09:00:00Z") - n * 86_400_000);
const usDate = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()} 09:00:00`;

/** csa's view: `count` meeting chats with a transcript, meeting 1 the most recent. */
const csaWith = (count: number) => () => ({
  teams: [],
  chats: Array.from({ length: count }, (_, i) => ({
    id: meetingId(i + 1),
    chatType: "meeting",
    title: `Contoso review ${i + 1}`,
    meetingInformation: { subject: `Contoso review ${i + 1}`, startTime: dayOf(i + 1).toISOString() },
    meetingObjectsConfig: { configurations: { transcriptConfig: { hasTranscript: true } } },
    lastJoinAt: dayOf(i + 1).toISOString(),
  })),
});

/** The newest page of meeting n's chat: the call and its transcript. */
const callMessages = (n: number) => [
  {
    id: "3",
    messagetype: "RichText/Media_CallRecording",
    originalarrivaltime: new Date(dayOf(n).getTime() + 3_700_000).toISOString(),
    content: `<URIObject type="Video.2/CallRecording.1"><RecordingStatus status="Success" code="200" /><Title>Contoso review ${n}</Title><Identifiers><Id type="callId" value="${callId(n)}" /></Identifiers><RecordingContent contentTypes="Transcript" timestamp="${dayOf(n).toISOString()}" duration="1:00:00.00"><item type="onedriveForBusinessTranscript" uri="${transcriptUrl(n)}" /></RecordingContent></URIObject>`,
  },
  {
    id: "2",
    messagetype: "Event/Call",
    originalarrivaltime: new Date(dayOf(n).getTime() + 3_600_000).toISOString(),
    properties: { skypeguid: callId(n) },
    content: `<ended/><partlist alt="" count="1"><part identity="8:orgid:00000000-0000-4000-8000-00000000000a"><displayName>Alex Doe</displayName><duration>3600</duration></part></partlist><callEventType>callEnded</callEventType><callId>${callId(n)}</callId>`,
  },
  {
    id: "1",
    messagetype: "Event/Call",
    originalarrivaltime: dayOf(n).toISOString(),
    properties: { skypeguid: callId(n) },
    content: `<partlist alt=""></partlist><callEventType>callStarted</callEventType><conversationStartTime>${usDate(dayOf(n))}</conversationStartTime><callId>${callId(n)}</callId>`,
  },
];

/** A fake chatsvc: each meeting chat is `pages` pages, the newest holding the call. */
const chatsvcWith =
  (pages: number) =>
  (req: SentRequest) => {
    const m = /^\/v1\/users\/ME\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(req.path);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const n = Number(/^19:meeting_contoso-(\d+)@thread\.v2$/.exec(id)?.[1]);
    if (!n) return undefined;
    const page = Number(new URLSearchParams(m[2]).get("syncState") ?? 0);
    const messages = page === 0 ? callMessages(n) : [{ id: `p${page}`, messagetype: "RichText/Html", content: `<p>Notes ${page}</p>`, originalarrivaltime: dayOf(n + 1).toISOString() }];
    return {
      messages,
      _metadata: page + 1 < pages ? { backwardLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(id)}/messages?startTime=1&syncState=${page + 1}&pageSize=200&view=msnp24Equivalent` } : {},
    };
  };

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0")).join(":");

/** Meeting n's transcript: 60 turns, 10 s apart; "budget" is said in turns 10 and 20. */
const transcriptOf = (n: number) => ({
  entries: Array.from({ length: 60 }, (_, i) => ({
    speakerDisplayName: i % 2 ? "Sam Roe" : "Alex Doe",
    startOffset: `${hms(i * 10)}.0`,
    endOffset: `${hms(i * 10 + 9)}.0`,
    text: `${i === 10 || i === 20 ? "The budget" : "The plan"} for review ${n}, point ${i}, is still being worked out by the team this week.`,
  })),
});
const sharepoint = (req: SentRequest) => {
  const n = Number(/\/items\/i(\d+)\//.exec(req.url)?.[1]);
  return n ? transcriptOf(n) : undefined;
};

const meetingChatRequests = (fake: { sent: SentRequest[] }) => fake.sent.filter((r) => r.service === "chatsvc" && /\/conversations\/[^/]*meeting_contoso[^/]*\/messages/.test(r.path));
/** Requests for meeting n's chat. */
const chatRequestsOf = (fake: { sent: SentRequest[] }, n: number) => meetingChatRequests(fake).filter((r) => decodeURIComponent(r.path).includes(meetingId(n)));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

describe("meeting chat read once per call", () => {
  it("1.3: read_transcript and 3 continueFrom pages read the meeting chat once (one page set, not four)", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: chatsvcWith(3), sharepoint } });
    const worker = await loadWorker(fake);
    let r = await worker.handlers.readTranscript({ meeting: meetingId(1), maxLength: 1000 });
    const lines = [r.transcript];
    for (let i = 0; i < 3; i++) {
      expect(r.continueFrom).toMatch(/^\d\d:\d\d:\d\d$/);
      r = await worker.handlers.readTranscript({ meeting: meetingId(1), from: r.continueFrom, maxLength: 1000 });
      lines.push(r.transcript);
    }
    expect(lines.every((t) => t.length > 0)).toBe(true);
    expect(r.session.callId).toBe(callId(1));
    expect(meetingChatRequests(fake)).toHaveLength(3);
  });

  it("1.3: search_transcripts(limit=5) over 20 meetings stops after the meeting that gives the 5th match", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(50), chatsvc: chatsvcWith(1), sharepoint } });
    const worker = await loadWorker(fake);
    // Each meeting's transcript has 2 matching lines: meetings 1 and 2 give 4, meeting 3 the 5th.
    const r = await worker.handlers.searchTranscripts({ query: "budget", limit: 5, meetings: 20 });
    expect(r.results.map((x: { id: string }) => x.id)).toEqual([meetingId(1), meetingId(2), meetingId(3)]);
    expect(r.results.flatMap((x: { matches: unknown[] }) => x.matches)).toHaveLength(5);
    expect(meetingChatRequests(fake).map((q) => decodeURIComponent(q.path).match(/meeting_contoso-\d+/)?.[0])).toEqual([
      "meeting_contoso-001",
      "meeting_contoso-002",
      "meeting_contoso-003",
    ]);
    expect(fake.count("sharepoint")).toBe(3);
    expect(r.meetingsSearched).toBe(3);
    // Stopping early is said, not silent: the AI must not read `matches` as the total of all 20.
    expect(r.notSearched).toBe(17);
    expect(r.stoppedBy).toBe("limit");
    expect(r.note).toMatch(/17 older meetings/);
  });

  it("2.1: a cancelled search_transcripts makes no further requests", async () => {
    // Each transcript takes a moment to load, so the cancel comes while the scan is under way.
    const slow = (req: SentRequest) => new Promise((r) => setTimeout(() => r(sharepoint(req)), 100));
    const fake = createFakeChrome({ services: { csa: csaWith(10), chatsvc: chatsvcWith(1), sharepoint: slow } });
    const worker = await loadWorker(fake);
    const replies: any[] = [];
    const done = worker.dispatch({ type: "request", id: "s1", method: "searchTranscripts", params: { query: "budget", meetings: 10, limit: 200 } }, (r) => replies.push(r));
    await vi.waitFor(() => expect(fake.count("sharepoint")).toBe(1), { timeout: 3_000 });
    const sentAtCancel = fake.sent.length;
    await worker.dispatch({ type: "cancel", id: "s1" }, () => {});
    await done;
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sent.length).toBe(sentAtCancel);
    expect(replies).toEqual([expect.objectContaining({ id: "s1", ok: false })]);
  });

  it("1.3: the same meeting under another chatsvc base is not served from the cache", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: chatsvcWith(1), sharepoint } });
    const worker = await loadWorker(fake);
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(meetingChatRequests(fake)).toHaveLength(1);

    const other = `${TEAMS_ORIGIN}/api/chatsvc/amer`;
    fake.session.set("capture:chatsvc", { base: other, region: "amer", headers: { authorization: "Bearer fake-other" }, at: 2 });
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    await worker.handlers.getMeeting({ meeting: meetingId(1) }); // cached under the new base
    const reqs = meetingChatRequests(fake);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].url.startsWith(`${BASES.chatsvc}/`)).toBe(true);
    expect(reqs[1].url.startsWith(`${other}/`)).toBe(true);
  });

  it("1.3: the cached meeting chat expires and is read again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: chatsvcWith(2), sharepoint } });
    const worker = await loadWorker(fake);
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(meetingChatRequests(fake)).toHaveLength(2); // one page set of 2 pages

    vi.setSystemTime(new Date("2026-10-01T10:01:01Z"));
    const r = await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(meetingChatRequests(fake)).toHaveLength(4);
    expect(r.sessions.map((s: { callId: string }) => s.callId)).toEqual([callId(1)]);
  });

  it("1.3: a 401 from chatsvc empties the meeting chat cache: the next call reads the chat again", async () => {
    let expire = false;
    const chatsvc = chatsvcWith(1);
    const fake = createFakeChrome({
      services: {
        csa: csaWith(2),
        sharepoint,
        chatsvc: (req) => {
          if (!expire) return chatsvc(req);
          expire = false;
          // The token expired; Teams' next request brings a fresh one.
          fake.session.set("capture:chatsvc", { base: BASES.chatsvc, region: "emea", headers: { authorization: "Bearer fake-fresh" }, at: Date.now() + 60_000 });
          return reply(401);
        },
      },
    });
    const worker = await loadWorker(fake);
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(chatRequestsOf(fake, 1)).toHaveLength(1);

    expire = true;
    await worker.handlers.getMeeting({ meeting: meetingId(2) });
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(chatRequestsOf(fake, 1)).toHaveLength(2);
  });

  it("1.3: a meeting chat that failed to load is not cached: the next call reads it again", async () => {
    let fail = true;
    const chatsvc = chatsvcWith(1);
    const fake = createFakeChrome({ services: { csa: csaWith(1), sharepoint, chatsvc: (req) => (fail ? reply(500) : chatsvc(req)) } });
    const worker = await loadWorker(fake);
    await expect(worker.handlers.getMeeting({ meeting: meetingId(1) })).rejects.toThrow();
    fail = false;
    const r = await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(r.sessions.map((s: { callId: string }) => s.callId)).toEqual([callId(1)]);
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(chatRequestsOf(fake, 1)).toHaveLength(2);
  });

  it("1.3: the cache holds 50 meeting chats: a 51st evicts the oldest, which is read again", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(51), chatsvc: chatsvcWith(1), sharepoint } });
    const worker = await loadWorker(fake);
    for (let n = 1; n <= 51; n++) await worker.handlers.getMeeting({ meeting: meetingId(n) });
    expect(meetingChatRequests(fake)).toHaveLength(51);

    await worker.handlers.getMeeting({ meeting: meetingId(51) }); // still cached
    expect(chatRequestsOf(fake, 51)).toHaveLength(1);
    await worker.handlers.getMeeting({ meeting: meetingId(1) }); // evicted
    expect(chatRequestsOf(fake, 1)).toHaveLength(2);
  });
});

describe("3.4: the transcript cache is bounded by bytes", () => {
  const MB = 1024 * 1024;
  /** Meeting n's transcript, padded to about `size` characters of JSON. */
  const bigTranscriptOf = (n: number, size: number) => {
    const t = transcriptOf(n);
    const pad = `The plan for review ${n} is still being worked out by the team this week. `.repeat(20);
    for (let length = JSON.stringify(t).length; length < size; length += pad.length + 100) {
      t.entries.push({ speakerDisplayName: "Sam Roe", startOffset: "00:10:00.0", endOffset: "00:10:09.0", text: pad });
    }
    return t;
  };
  /** OneDrive with meeting n's transcript at about `sizeOf(n)` characters; built once per meeting. */
  const bigSharepoint = (sizeOf: (n: number) => number) => {
    const built = new Map<number, unknown>();
    return (req: SentRequest) => {
      const n = Number(/\/items\/i(\d+)\//.exec(req.url)?.[1]);
      if (!n) return undefined;
      if (!built.has(n)) built.set(n, bigTranscriptOf(n, sizeOf(n)));
      return built.get(n);
    };
  };
  const transcriptReadsOf = (fake: { sent: SentRequest[] }, n: number) => fake.sent.filter((r) => r.service === "sharepoint" && r.url.includes(`/items/i${n}/`)).length;

  it("3.4: after 20 transcripts of 1 MB, the first is read from OneDrive again (fewer than 50 entries, but over the byte cap)", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(20), chatsvc: chatsvcWith(1), sharepoint: bigSharepoint(() => 1 * MB) } });
    const worker = await loadWorker(fake);
    for (let n = 1; n <= 20; n++) await worker.handlers.readTranscript({ meeting: meetingId(n), maxLength: 1000 });
    expect(fake.count("sharepoint")).toBe(20);

    await worker.handlers.readTranscript({ meeting: meetingId(20), maxLength: 1000 }); // the newest is still cached
    expect(transcriptReadsOf(fake, 20)).toBe(1);
    const r = await worker.handlers.readTranscript({ meeting: meetingId(1), maxLength: 1000 }); // evicted
    expect(transcriptReadsOf(fake, 1)).toBe(2);
    expect(r.transcript).toMatch(/review 1, point 0/);
  });

  it("3.4: a transcript bigger than the cap is not cached: each read fetches it, and it pushes nothing out", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(2), chatsvc: chatsvcWith(1), sharepoint: bigSharepoint((n) => (n === 1 ? 20 * MB : 10_000)) } });
    const worker = await loadWorker(fake);
    await worker.handlers.readTranscript({ meeting: meetingId(2), maxLength: 1000 });
    const first = await worker.handlers.readTranscript({ meeting: meetingId(1), maxLength: 1000 });
    const again = await worker.handlers.readTranscript({ meeting: meetingId(1), from: first.continueFrom, maxLength: 1000 });
    expect(again.transcript.length).toBeGreaterThan(0);
    expect(transcriptReadsOf(fake, 1)).toBe(2);
    await worker.handlers.readTranscript({ meeting: meetingId(2), maxLength: 1000 });
    expect(transcriptReadsOf(fake, 2)).toBe(1);
  });
});

describe("#179: one search_transcripts call makes a bounded number of Teams requests", () => {
  /** Teams requests a search made: meeting chat pages and transcripts. */
  const teamsRequests = (fake: { sent: SentRequest[] }) => meetingChatRequests(fake).length + fake.sent.filter((r) => r.service === "sharepoint").length;

  it("#179: 50 meetings, each a long chat with a transcript, take at most 100 requests, and the result says the search stopped early", async () => {
    // Each meeting chat is 20 short pages (as Teams may send them), the call on the newest.
    const fake = createFakeChrome({ services: { csa: csaWith(50), chatsvc: chatsvcWith(20), sharepoint } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meetings: 50, limit: 200 });
    // Before #179: 1,050 (50 chats × 20 pages, and 50 transcripts).
    expect(teamsRequests(fake)).toBeLessThanOrEqual(100);
    // Matches found before the stop are returned, and the stop is said, not silent.
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.notSearched).toBeGreaterThan(0);
    expect(r.meetingsSearched + r.notSearched).toBe(20); // at most 20 meetings, even when asked for 50
    expect(r.stoppedBy).toBe("budget");
    expect(r.note).toMatch(/100 Teams requests/);
  });

  it("#179: a meeting chat longer than 5 pages is read to 5 pages, and the result names it as cut", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(2), chatsvc: chatsvcWith(8), sharepoint } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meetings: 2 });
    expect(chatRequestsOf(fake, 1)).toHaveLength(5);
    expect(chatRequestsOf(fake, 2)).toHaveLength(5);
    expect(r.results).toHaveLength(2); // the calls are on the newest page
    expect(r.chatsCut).toEqual(["Contoso review 1", "Contoso review 2"]);
    expect(r.note).toMatch(/newest 5 pages/);
    expect(r.stoppedBy).toBeUndefined();
  });

  it("#179: a chat that fits in 5 pages is not reported as cut", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: chatsvcWith(5), sharepoint } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meetings: 1 });
    expect(chatRequestsOf(fake, 1)).toHaveLength(5);
    expect(r.chatsCut).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  /** Meeting chats of 8 pages; meeting 1's 7th page holds an older call (callId 40) with a transcript. */
  const withOlderCall = () => {
    const chatsvc = chatsvcWith(8);
    return (req: SentRequest) => {
      const res = chatsvc(req) as { messages: unknown[] } | undefined;
      const page = Number(/syncState=(\d+)/.exec(req.path)?.[1] ?? 0);
      if (res && page === 6 && decodeURIComponent(req.path).includes(meetingId(1))) res.messages = callMessages(40);
      return res;
    };
  };

  it("#179: get_meeting after a search reads the whole chat again: a chat the search cut short isn't served from the cache", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: withOlderCall(), sharepoint } });
    const worker = await loadWorker(fake);
    await worker.handlers.searchTranscripts({ query: "budget", meetings: 1 });
    expect(chatRequestsOf(fake, 1)).toHaveLength(5);
    const m = await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(m.sessions.map((s: { callId: string }) => s.callId)).toEqual([callId(1), callId(40)]);
    expect(chatRequestsOf(fake, 1)).toHaveLength(5 + 8);
    // The whole chat now cached also answers the next search.
    await worker.handlers.searchTranscripts({ query: "budget", meetings: 1 });
    expect(chatRequestsOf(fake, 1)).toHaveLength(5 + 8);
  });

  it("#179: a search of one named meeting reads its whole chat, and finds the older call's transcript", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: withOlderCall(), sharepoint } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meeting: meetingId(1) });
    expect(chatRequestsOf(fake, 1)).toHaveLength(8);
    expect(r.results.map((x: { callId: string }) => x.callId)).toEqual([callId(1), callId(40)]);
    expect(r.chatsCut).toBeUndefined();
  });

  it("#179: a second search within a minute reads only what the first didn't: cached chats and transcripts cost no requests", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(20), chatsvc: chatsvcWith(20), sharepoint } });
    const worker = await loadWorker(fake);
    const first = await worker.handlers.searchTranscripts({ query: "budget", meetings: 20, limit: 200 });
    expect(first.stoppedBy).toBe("budget");
    const before = meetingChatRequests(fake).length + fake.count("sharepoint");
    const second = await worker.handlers.searchTranscripts({ query: "budget", meetings: 20, limit: 200 });
    expect(second.meetingsSearched).toBe(20);
    expect(second.stoppedBy).toBeUndefined();
    expect(meetingChatRequests(fake).length + fake.count("sharepoint") - before).toBe(first.notSearched * 6);
  });

  it("#179: a search of one named meeting reads all its transcripts, even more than the budget of 100 requests", async () => {
    // One page holding 120 calls (callIds 101-220), each with its own transcript.
    const calls = Array.from({ length: 120 }, (_, i) => 101 + i);
    const chatsvc = (req: SentRequest) =>
      /\/conversations\/[^/]*meeting_contoso-001[^/]*\/messages/.test(req.path) ? { messages: calls.flatMap((n) => callMessages(n)), _metadata: {} } : undefined;
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc, sharepoint } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meeting: meetingId(1), limit: 200 });
    expect(meetingChatRequests(fake)).toHaveLength(1);
    // The budget limits only the search across meetings: one named meeting is searched whole.
    expect(fake.count("sharepoint")).toBe(120);
    expect(r.matches).toBe(240);
    expect(r.stoppedBy).toBeUndefined();
    expect(r.transcriptsNotSearched).toBeUndefined();
    expect(r.notSearched).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  it("#179: a chat cut short says how many pages were read: 20 when get_meeting read it before the search, not 5", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(1), chatsvc: chatsvcWith(25), sharepoint } });
    const worker = await loadWorker(fake);
    await worker.handlers.getMeeting({ meeting: meetingId(1) });
    expect(chatRequestsOf(fake, 1)).toHaveLength(20);
    const r = await worker.handlers.searchTranscripts({ query: "budget", meetings: 1 });
    expect(chatRequestsOf(fake, 1)).toHaveLength(20); // served from the cache
    expect(r.chatsCut).toEqual(["Contoso review 1"]);
    expect(r.note).toMatch(/newest 20 pages/);
    expect(r.note).not.toMatch(/newest 5 pages/);
  });
});
