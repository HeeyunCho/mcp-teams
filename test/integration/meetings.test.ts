// Meeting tools (get_meeting, read_transcript, search_transcripts in extension/background.js)
// against a fake chatsvc whose meeting chats page like Teams (newest first, backwardLink to
// the next older page) and a fake OneDrive holding each call's transcript.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, SHAREPOINT_ORIGIN, TEAMS_ORIGIN, type SentRequest } from "../helpers/fakeChrome.js";

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

  it("1.3: search_transcripts(limit=5) over 50 meetings stops after the meeting that gives the 5th match", async () => {
    const fake = createFakeChrome({ services: { csa: csaWith(50), chatsvc: chatsvcWith(1), sharepoint } });
    const worker = await loadWorker(fake);
    // Each meeting's transcript has 2 matching lines: meetings 1 and 2 give 4, meeting 3 the 5th.
    const r = await worker.handlers.searchTranscripts({ query: "budget", limit: 5, meetings: 50 });
    expect(r.results.map((x: { id: string }) => x.id)).toEqual([meetingId(1), meetingId(2), meetingId(3)]);
    expect(r.results.flatMap((x: { matches: unknown[] }) => x.matches)).toHaveLength(5);
    expect(meetingChatRequests(fake).map((q) => decodeURIComponent(q.path).match(/meeting_contoso-\d+/)?.[0])).toEqual([
      "meeting_contoso-001",
      "meeting_contoso-002",
      "meeting_contoso-003",
    ]);
    expect(fake.count("sharepoint")).toBe(3);
    expect(r.meetingsSearched).toBe(3);
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
});
