// read_messages paging through a long chat (extension/background.js readMessages) against a
// fake chatsvc that pages like Teams: newest first, `pageSize` per page, `_metadata.backwardLink`
// to the next older page (on chatsvc's own host).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, loadWorker, ME_OID, openedSockets, type SentRequest } from "../helpers/fakeChrome.js";

const CHAT = "19:contoso-history@thread.v2";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";
const TOTAL = 5_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

const csa = () => ({ teams: [], chats: [{ id: CHAT, title: "Contoso history", chatType: "chat", members: [{ mri: `8:orgid:${ME_OID}` }, { mri: ALEX }] }] });

/** Message n (1 = oldest, TOTAL = newest), one minute apart. */
const timeOf = (n: number) => new Date(START + n * 60_000).toISOString();
const message = (n: number) => ({
  id: String(START + n * 60_000),
  messagetype: "RichText/Html",
  content: `<p>Note ${n} from Alex</p>`,
  imdisplayname: "Alex Doe",
  from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${ALEX}`,
  originalarrivaltime: timeOf(n),
});

/** A 5,000-message chat. The first request starts at the newest; backwardLink carries the offset. */
const chatsvc = (req: SentRequest) => {
  const m = /^\/v1\/users\/ME\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(req.path);
  if (!m || decodeURIComponent(m[1]) !== CHAT) return undefined;
  const q = new URLSearchParams(m[2]);
  const pageSize = Number(q.get("pageSize") ?? 20);
  const offset = Number(q.get("syncState") ?? 0);
  const newest = TOTAL - offset;
  const count = Math.max(0, Math.min(pageSize, newest));
  const next = offset + pageSize;
  return {
    messages: Array.from({ length: count }, (_, i) => message(newest - i)),
    _metadata:
      next < TOTAL
        ? { backwardLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages?startTime=1&syncState=${next}&pageSize=${pageSize}&view=msnp24Equivalent` }
        : {},
  };
};

const noteNumber = (m: { text: string }) => Number(/Note (\d+)/.exec(m.text)?.[1]);

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

describe("read_messages paging", () => {
  it("1.1: reading 10 pages of 30 with the cursor costs at most 2 chatsvc requests per page, contiguous and without duplicates", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc } });
    const worker = await loadWorker(fake);
    const seen: number[] = [];
    const perPage: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const before = fake.count("chatsvc", /messages/);
      const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 30, ...(cursor ? { cursor } : {}) });
      perPage.push(fake.count("chatsvc", /messages/) - before);
      expect(r.count).toBe(30);
      seen.push(...r.messages.map(noteNumber).reverse()); // newest first
      cursor = r.olderCursor;
      expect(typeof cursor).toBe("string");
    }
    expect(Math.max(...perPage)).toBeLessThanOrEqual(2);
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => TOTAL - i));
  });

  it("1.1: paging by `before` past the 20-page cap says so and returns a cursor, never a silent empty page", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc } });
    const worker = await loadWorker(fake);
    // 4,000 messages are newer than this; 20 pages of 60 cover only 1,200 of them.
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 30, before: timeOf(1_001) });
    expect(fake.count("chatsvc", /messages/)).toBe(20);
    expect(r.count).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/20 pages/);
    expect(typeof r.olderCursor).toBe("string");

    // The cursor carries on from where the cap stopped, still before that time.
    let next = r;
    for (let i = 0; i < 5 && next.count === 0; i++) next = await worker.handlers.readMessages({ conversation: CHAT, limit: 30, cursor: next.olderCursor });
    expect(next.messages.map(noteNumber)).toEqual(Array.from({ length: 30 }, (_, i) => 971 + i));
  });

  it("1.1: a cursor is for one conversation; giving it with `before` is an error", async () => {
    const fake = createFakeChrome({ services: { csa, chatsvc } });
    const worker = await loadWorker(fake);
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 30 });
    await expect(worker.handlers.readMessages({ conversation: CHAT, cursor: r.olderCursor, before: timeOf(10) })).rejects.toThrow(/either/i);
    await expect(worker.handlers.readMessages({ conversation: "19:other-chat@thread.v2", cursor: r.olderCursor })).rejects.toThrow(/not a valid cursor/i);
  });
});
