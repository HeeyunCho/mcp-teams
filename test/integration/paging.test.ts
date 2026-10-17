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

// ------------------------------------------------------------ edge cases at page boundaries

const TEAM = "19:contoso-team@thread.tacv2";
const CHANNEL = "19:contoso-general@thread.tacv2";
const SAM = "8:orgid:00000000-0000-4000-8000-00000000000b";

type Raw = Record<string, unknown> & { id: string };

/**
 * chatsvc for any number of conversations, each a list of raw messages newest first: pages
 * of `pageSize`, the offset in syncState of the backwardLink.
 */
const pagedChatsvc = (convs: Record<string, Raw[]>) => (req: SentRequest) => {
  const m = /^\/v1\/users\/ME\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(req.path);
  const id = m ? decodeURIComponent(m[1]) : "";
  const all = convs[id];
  if (!m || !all) return undefined;
  const q = new URLSearchParams(m[2]);
  const pageSize = Number(q.get("pageSize") ?? 20);
  const offset = Number(q.get("syncState") ?? 0);
  const next = offset + pageSize;
  return {
    messages: all.slice(offset, next),
    _metadata:
      next < all.length
        ? { backwardLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(id)}/messages?startTime=1&syncState=${next}&pageSize=${pageSize}&view=msnp24Equivalent` }
        : {},
  };
};

const channelCsa = () => ({
  teams: [{ id: TEAM, displayName: "Contoso", channels: [{ id: CHANNEL, displayName: "General" }] }],
  chats: [],
});

type Out = { id: string; time: string | null; text: string; replies?: Out[] };
type Fake = ReturnType<typeof createFakeChrome>;

/** Reads pages with the cursor until there is none: each page's messages and chatsvc requests. */
async function readAll(fake: Fake, args: Record<string, unknown>, maxPages = 200) {
  const worker = await loadWorker(fake);
  const pages: { messages: Out[]; requests: number }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const before = fake.count("chatsvc", /messages/);
    const r = await worker.handlers.readMessages({ ...args, ...(cursor ? { cursor } : {}) });
    pages.push({ messages: r.messages, requests: fake.count("chatsvc", /messages/) - before });
    cursor = r.olderCursor;
    if (!cursor) return pages;
  }
  throw new Error(`still paging after ${maxPages} pages`);
}

const flatten = (ms: Out[]): Out[] => ms.flatMap((m) => [m, ...(m.replies ?? [])]);
const newestFirst = (pages: { messages: Out[] }[]) => pages.flatMap((p) => p.messages.map(noteNumber).reverse());
const countdown = (n: number) => Array.from({ length: n }, (_, i) => n - i);

describe("read_messages paging at page boundaries", () => {
  it("1.1: messages sharing one millisecond across a page boundary are all returned, exactly once", async () => {
    // 100 messages, four per millisecond; ids of 2 to 4 digits (13, 26, ... 1300), so
    // ordering them as strings would put "1001" before "988".
    const at = (n: number) => new Date(START + Math.floor(n / 4)).toISOString();
    const msgs: Raw[] = countdown(100).map((n) => ({ ...message(n), id: String(n * 13), originalarrivaltime: at(n) }));
    const fake = createFakeChrome({ services: { csa, chatsvc: pagedChatsvc({ [CHAT]: msgs }) } });
    const pages = await readAll(fake, { conversation: CHAT, limit: 3 });
    expect(newestFirst(pages)).toEqual(countdown(100));
    expect(Math.max(...pages.map((p) => p.requests))).toBeLessThanOrEqual(2);
  });

  it("1.1: a message without a time at a page boundary doesn't make the cursor return the same page again", async () => {
    // Every fifth message has no arrival or compose time, only its id (the arrival in ms).
    const msgs: Raw[] = countdown(50).map((n) => {
      const m: Raw = message(n);
      if (n % 5 === 1) delete m.originalarrivaltime;
      return m;
    });
    const fake = createFakeChrome({ services: { csa, chatsvc: pagedChatsvc({ [CHAT]: msgs }) } });
    const pages = await readAll(fake, { conversation: CHAT, limit: 5 }, 30);
    expect(newestFirst(pages)).toEqual(countdown(50));
  });

  it("1.1: a channel post's thread (reply_to) pages with the cursor, contiguous, without duplicates, at most 2 requests per page", async () => {
    const ROOT = String(START);
    const link = `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${CHANNEL};messageid=${ROOT}`;
    const thread: Raw[] = countdown(95).map((n) => ({ ...message(n), conversationLink: link }));
    const fake = createFakeChrome({ services: { csa: channelCsa, chatsvc: pagedChatsvc({ [`${CHANNEL};messageid=${ROOT}`]: thread }) } });
    const pages = await readAll(fake, { conversation: CHANNEL, threadId: ROOT, limit: 10 });
    expect(newestFirst(pages)).toEqual(countdown(95));
    expect(pages.length).toBe(10);
    expect(Math.max(...pages.map((p) => p.requests))).toBeLessThanOrEqual(2);
  });

  it("1.1: a channel pages by post with the cursor: every post and reply once, contiguous, at most 2 requests per page", async () => {
    // 40 posts ten minutes apart; each gets two replies 13 and 27 minutes later, so replies
    // arrive after newer posts and a page boundary can fall between a post and its replies.
    const at = (min: number) => new Date(START + min * 60_000).toISOString();
    const channelLink = `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${CHANNEL}`;
    const all: Raw[] = [];
    for (let p = 1; p <= 40; p++) {
      const postId = String(START + p * 600_000);
      all.push({ ...message(p), id: postId, content: `<p>Post ${p}</p>`, originalarrivaltime: at(p * 10), conversationLink: channelLink });
      for (const [k, d] of [
        [1, 13],
        [2, 27],
      ]) {
        all.push({
          ...message(p),
          id: String(START + (p * 10 + d) * 60_000),
          content: `<p>Reply ${k} to post ${p}</p>`,
          from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${SAM}`,
          imdisplayname: "Sam Roe",
          originalarrivaltime: at(p * 10 + d),
          conversationLink: `${channelLink};messageid=${postId}`,
        });
      }
    }
    all.sort((a, b) => Number(b.id) - Number(a.id)); // newest first, as chatsvc returns them
    const fake = createFakeChrome({ services: { csa: channelCsa, chatsvc: pagedChatsvc({ [CHANNEL]: all }) } });
    const pages = await readAll(fake, { conversation: CHANNEL, limit: 4 });

    const ids = pages.flatMap((p) => flatten(p.messages).map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(all.map((m) => m.id).sort()); // nothing lost
    // Contiguous: everything on a page is newer than everything on the pages after it.
    for (let i = 1; i < pages.length; i++) {
      const older = Math.max(...flatten(pages[i].messages).map((m) => Date.parse(m.time!)));
      const newer = Math.min(...flatten(pages[i - 1].messages).map((m) => Date.parse(m.time!)));
      expect(older).toBeLessThan(newer);
    }
    expect(Math.max(...pages.map((p) => p.requests))).toBeLessThanOrEqual(2);
  });
});
