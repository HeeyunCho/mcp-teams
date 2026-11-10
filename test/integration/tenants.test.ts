// 3.3: the worker's caches and captured sessions belong to one signed-in account (tenant).
// A 401 empties the chat list cache, and after the user switches Teams to another tenant
// nothing of the first one (its chats, its captured sessions) is used or returned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, reply, SHAREPOINT_ORIGIN, TEAMS_ORIGIN, type SentRequest } from "../helpers/fakeChrome.js";
import { fakeJwt } from "../helpers/jwt.js";

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** csa's chat list: one titled group chat per entry. */
const csaList = (...chats: [id: string, title: string][]) => ({ teams: [], chats: chats.map(([id, title]) => ({ id, title, chatType: "group" })) });
const messagesOf = (req: SentRequest) => /^\/v1\/users\/ME\/conversations\/([^/?]+)\/messages/.exec(req.path)?.[1];

describe("3.3: a 401 empties the chat list cache", () => {
  it("3.3: after a 401 the next lookup by name reads the chat list again and finds a chat made since", async () => {
    let expire = false;
    let renamed = false;
    const fake = createFakeChrome({
      services: {
        csa: () => (renamed ? csaList(["19:alpha@thread.v2", "Alpha launch"], ["19:gamma@thread.v2", "Gamma kickoff"]) : csaList(["19:alpha@thread.v2", "Alpha launch"])),
        chatsvc: (req) => {
          if (!messagesOf(req)) return undefined;
          if (expire) {
            expire = false;
            // The token expired; Teams' next request brings a fresh one.
            fake.session.set("capture:chatsvc", { base: BASES.chatsvc, region: "emea", headers: { authorization: "Bearer fake-fresh" }, at: Date.now() + 60_000 });
            return reply(401);
          }
          return { messages: [] };
        },
      },
    });
    const worker = await loadWorker(fake);
    await worker.handlers.readMessages({ conversation: "Alpha launch" });
    expect(fake.count("csa")).toBe(1);

    // A chat is made in Teams, and the chat service's token expires.
    renamed = true;
    expire = true;
    await worker.handlers.readMessages({ conversation: "Alpha launch" });
    expect(fake.count("chatsvc", /\/messages/)).toBe(3); // the 401, then the retry

    const r = await worker.handlers.readMessages({ conversation: "Gamma kickoff" });
    expect(r.conversation.id).toBe("19:gamma@thread.v2");
    expect(fake.count("csa")).toBe(2);
  });
});

// Two fictional tenants, each with its signed-in user.
const TENANT = {
  a: { tid: "00000000-0000-4000-8000-0000000000a0", oid: "00000000-0000-4000-8000-0000000000a1" },
  b: { tid: "00000000-0000-4000-8000-0000000000b0", oid: "00000000-0000-4000-8000-0000000000b1" },
};
type Tenant = keyof typeof TENANT;

/** When each tenant's tokens were issued (`iat`, seconds since 1970): b's after a's, as when the user switches from a to b. */
const ISSUED: Record<Tenant, number> = { a: 1_790_000_000, b: 1_790_000_600 };
/** Each tenant's tokens: AAD bearer tokens for csa and mt, a skype token for chatsvc. */
const TOKENS = Object.fromEntries(
  (Object.keys(TENANT) as Tenant[]).map((t) => [
    t,
    {
      bearer: `Bearer ${fakeJwt({ tid: TENANT[t].tid, oid: TENANT[t].oid, name: `fake ${t}`, iat: ISSUED[t] })}`,
      skype: `skypetoken=${fakeJwt({ skypeid: `orgid:${TENANT[t].oid}`, rgn: "emea", iat: ISSUED[t] })}`,
    },
  ]),
) as Record<Tenant, { bearer: string; skype: string }>;
/** Tenant a's tokens when Teams switches back to a: fresh ones, issued after b's (an older token of a's would be dropped, #77). */
const BACK_TO_A = {
  bearer: `Bearer ${fakeJwt({ tid: TENANT.a.tid, oid: TENANT.a.oid, name: "fake a", iat: ISSUED.b + 600 })}`,
  skype: `skypetoken=${fakeJwt({ skypeid: `orgid:${TENANT.a.oid}`, rgn: "emea", iat: ISSUED.b + 600 })}`,
};

/** The tenant whose token a request carried. */
const tenantOf = (req: SentRequest): Tenant | undefined =>
  (Object.keys(TOKENS) as Tenant[]).find((t) =>
    [TOKENS[t], ...(t === "a" ? [BACK_TO_A] : [])].some((k) => req.headers.authorization === k.bearer || req.headers.authentication === k.skype),
  );

/** Each tenant's chats, as its own csa lists them. */
const CHATS: Record<Tenant, [string, string][]> = {
  a: [["19:alpha@thread.v2", "Alpha launch"]],
  b: [["19:beta@thread.v2", "Beta review"]],
};

/** A tenant's Teams answers only with that tenant's token; another tenant's chat doesn't exist there. */
const tenantServices = {
  csa: (req: SentRequest) => {
    const t = tenantOf(req);
    return t ? csaList(...CHATS[t]) : reply(401);
  },
  chatsvc: (req: SentRequest) => {
    const t = tenantOf(req);
    if (!t) return reply(401);
    const id = messagesOf(req);
    if (!id) return undefined;
    return CHATS[t].some(([c]) => c === decodeURIComponent(id)) ? { messages: [] } : reply(404);
  },
  mt: (req: SentRequest) => (tenantOf(req) ? { value: [] } : reply(401)),
};

/** Teams in the tab makes a request to `service` as tenant `t`, which the worker captures. */
async function teamsRequest(fake: ReturnType<typeof createFakeChrome>, service: "csa" | "chatsvc" | "mt", t: Tenant, tokens = TOKENS[t]) {
  const url = {
    csa: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`,
    chatsvc: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`,
    mt: `${BASES.mt}/beta/users/${TENANT[t].oid}/capabilities`,
  }[service];
  const header = service === "chatsvc" ? { name: "Authentication", value: tokens.skype } : { name: "Authorization", value: tokens.bearer };
  await fake.fire("beforeSendHeaders", { url, initiator: TEAMS_ORIGIN, requestHeaders: [header] });
}

describe("3.3: switching tenants never returns the other tenant's data", () => {
  it("3.3: after the switch a chat is looked up in the new tenant's list, and the old tenant's chats are gone", async () => {
    const fake = createFakeChrome({ captured: [], services: tenantServices });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    expect((await worker.handlers.readMessages({ conversation: "Alpha launch" })).conversation.id).toBe("19:alpha@thread.v2");

    // The user switches Teams to tenant b, in the same region (same service bases).
    const switchedAt = fake.sent.length;
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");

    expect((await worker.handlers.readMessages({ conversation: "Beta review" })).conversation.id).toBe("19:beta@thread.v2");
    await expect(worker.handlers.readMessages({ conversation: "Alpha launch" })).rejects.toThrow(/Alpha launch/);
    const listed = await worker.handlers.listChats({});
    expect(listed.chats.map((c: { id: string }) => c.id)).toEqual(CHATS.b.map(([id]) => id));
    // Nothing went out as tenant a after the switch.
    expect(fake.sent.slice(switchedAt).map(tenantOf)).not.toContain("a");
  });

  it("3.3: the first request of the new tenant retires the old tenant's other sessions: they are never sent again", async () => {
    const fake = createFakeChrome({ captured: [], services: tenantServices });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    expect((await worker.handlers.status({})).signedInAs).toBe(`8:orgid:${TENANT.a.oid}`);

    // Tenant b's first request is to csa; chatsvc and mt still hold tenant a's sessions.
    const switchedAt = fake.sent.length;
    await teamsRequest(fake, "csa", "b");
    const status = await worker.handlers.status({});
    expect(status.signedInAs).toBe(`8:orgid:${TENANT.b.oid}`);
    expect(status.services).toMatchObject({ chatsvc: null, mt: null });
    expect(status.services.csa).not.toBeNull();

    // Once Teams calls the chat service as tenant b, the worker reads b's chat with b's session.
    await teamsRequest(fake, "chatsvc", "b");
    expect((await worker.handlers.readMessages({ conversation: "Beta review" })).conversation.id).toBe("19:beta@thread.v2");
    expect(fake.sent.slice(switchedAt).map(tenantOf)).not.toContain("a");
  });
});

describe("3.2: the cached chat list belongs to the account that read it", () => {
  it("3.2: list_chats right after a switch reads the new tenant's list rather than serving the cached one", async () => {
    const fake = createFakeChrome({ captured: [], services: tenantServices });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    expect((await worker.handlers.listChats({})).chats.map((c: { id: string }) => c.id)).toEqual(CHATS.a.map(([id]) => id));
    expect(fake.count("csa")).toBe(1);

    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    expect((await worker.handlers.listChats({})).chats.map((c: { id: string }) => c.id)).toEqual(CHATS.b.map(([id]) => id));
    expect(fake.count("csa")).toBe(2);
    // And b's list is then the cached one.
    await worker.handlers.listChats({});
    expect(fake.count("csa")).toBe(2);
  });
});

describe("3.3: a switch that lands while a request runs", () => {
  it("3.3: a chat list read as tenant a that finishes after the switch isn't kept for tenant b", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const fake = createFakeChrome({
      captured: [],
      services: {
        ...tenantServices,
        // Tenant a's csa answers only once the test lets it (the switch lands meanwhile).
        csa: async (req) => {
          if (hold && tenantOf(req) === "a") await held;
          return tenantServices.csa(req);
        },
      },
    });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");

    const first = worker.handlers.readMessages({ conversation: "Alpha launch" }).catch((err: Error) => err);
    await vi.waitFor(() => expect(fake.count("csa")).toBe(1));
    // The user switches Teams to tenant b while a's chat list is still being read.
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    hold = false;
    release();
    await first;

    const switchedAt = fake.sent.length;
    await expect(worker.handlers.readMessages({ conversation: "Alpha launch" })).rejects.toThrow(/Alpha launch/);
    expect(fake.count("csa")).toBe(2); // b's own list, read as b
    expect(fake.sent.slice(switchedAt).filter((r) => messagesOf(r) === encodeURIComponent("19:alpha@thread.v2"))).toEqual([]);
  });
});

describe("3.3: a send confirmed as one account is never posted as another", () => {
  /** The id of the confirmation window opened `n`-th (0 = the first). */
  const windowRequestId = (fake: ReturnType<typeof createFakeChrome>, n = 0) => /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[n][0]!.url!)![1];
  const click = (fake: ReturnType<typeof createFakeChrome>, id: string) => fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });
  const posts = (fake: ReturnType<typeof createFakeChrome>, from: number) => fake.sent.slice(from).filter((r) => r.service === "chatsvc" && r.method === "POST");
  const CHANGED = "The signed-in Teams account changed since this was confirmed; nothing was sent.";

  it("3.3: a message to a chat confirmed as tenant a, clicked after the switch to b: nothing is posted", async () => {
    const fake = createFakeChrome({ captured: [], services: tenantServices });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi Alex" });
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));

    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    const switchedAt = fake.sent.length;
    await click(fake, windowRequestId(fake));
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake, switchedAt)).toEqual([]);
  });

  /** Services where chatsvc takes any post (as Teams would for a chat it knows), and `held` service requests wait. */
  const sendServices = (held: { service: "chatsvc" | "mt"; path: RegExp; until: Promise<void> }) => ({
    ...tenantServices,
    mt: async (req: SentRequest) => {
      if (held.service === "mt" && held.path.test(req.path) && tenantOf(req) === "a") await held.until;
      return tenantServices.mt(req);
    },
    chatsvc: async (req: SentRequest) => {
      if (held.service === "chatsvc" && held.path.test(req.path) && tenantOf(req) === "a") await held.until;
      if (!tenantOf(req)) return reply(401);
      if (req.method === "POST" && req.path === "/v1/threads") return reply(201, {}, { location: `${BASES.chatsvc}/v1/threads/${encodeURIComponent("19:new@thread.v2")}` });
      if (req.method === "POST") return { OriginalArrivalTime: Date.parse("2026-10-18T10:00:00Z") };
      return tenantServices.chatsvc(req);
    },
  });
  const postsAs = (fake: ReturnType<typeof createFakeChrome>, t: Tenant) => posts(fake, 0).filter((r) => tenantOf(r) === t);

  it("3.3: a switch while the new chat is created (as a): the chat exists, but no message goes out as b", async () => {
    let release = () => {};
    const until = new Promise<void>((r) => (release = r));
    const fake = createFakeChrome({ captured: [], services: sendServices({ service: "chatsvc", path: /^\/v1\/threads$/, until }) });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    const result = worker.handlers.requestSend({ to: ["8:orgid:00000000-0000-4000-8000-0000000000a2"], text: "Hi Sam" });
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));

    const clicked = click(fake, windowRequestId(fake));
    await vi.waitFor(() => expect(posts(fake, 0).map((r) => r.path)).toEqual(["/v1/threads"]));
    // The chat is being created as a when Teams switches to b.
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    release();
    await clicked;

    const r = await result;
    expect(postsAs(fake, "b")).toEqual([]);
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/chat was created/i);
    expect(r.reason).toMatch(/no message was sent/i);
    expect(r.reason).toMatch(/list_chats/);
  });

  it("3.3: a switch during the name lookup before a post into an existing chat: nothing goes out as b", async () => {
    let release = () => {};
    const until = new Promise<void>((r) => (release = r));
    const fake = createFakeChrome({ captured: [], services: sendServices({ service: "mt", path: /fetchShortProfile/, until }) });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi Alex" });
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));

    const clicked = click(fake, windowRequestId(fake));
    // The click passed; the post waits for the sender's own name (mt) when Teams switches to b.
    await vi.waitFor(() => expect(fake.count("mt", /fetchShortProfile/)).toBe(1));
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    release();
    await clicked;

    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake, 0)).toEqual([]);
  });

  it("3.3: a new chat confirmed as tenant a, clicked after the switch to b: no chat is created", async () => {
    const fake = createFakeChrome({ captured: [], services: tenantServices });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    const result = worker.handlers.requestSend({ to: ["8:orgid:00000000-0000-4000-8000-0000000000a2"], text: "Hi Sam" });
    await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));

    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    const switchedAt = fake.sent.length;
    await click(fake, windowRequestId(fake));
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake, switchedAt)).toEqual([]);
  });
});

describe("77.1: read_messages never returns pages read as two accounts", () => {
  // Alpha launch holds 30 notes (1 = oldest), which chatsvc returns newest first, 10 per page.
  const CHAT = "19:alpha@thread.v2";
  const NOTES = 30;
  const PAGE = 10;
  const START = Date.parse("2026-10-01T09:00:00.000Z");
  const ALEX = "8:orgid:00000000-0000-4000-8000-0000000000a2";
  const note = (n: number) => ({
    id: String(START + n * 60_000),
    messagetype: "RichText/Html",
    content: `<p>Note ${n} from Alex</p>`,
    imdisplayname: "Alex Doe",
    from: `${BASES.chatsvc}/v1/users/ME/contacts/${ALEX}`,
    originalarrivaltime: new Date(START + n * 60_000).toISOString(),
  });
  /** Tenant a's chat session after its token was renewed: the same user, another token. */
  const FRESH_A = `skypetoken=${fakeJwt({ skypeid: `orgid:${TENANT.a.oid}`, rgn: "emea", renewed: true })}`;
  const accountOf = (req: SentRequest) => tenantOf(req) ?? (req.headers.authentication === FRESH_A ? "a" : undefined);
  const offsetOf = (req: SentRequest) => Number(new URLSearchParams(req.path.split("?")[1] ?? "").get("syncState") ?? 0);
  const pageRequests = (fake: ReturnType<typeof createFakeChrome>) => fake.sent.filter((r) => messagesOf(r) === encodeURIComponent(CHAT));
  const CHANGED = /account changed while messages were read/;

  /**
   * Tenant services where Alpha launch pages as above for whichever account asks. `hook` runs
   * first for each page asked for (`offset`: how many notes newer pages hold); what it returns,
   * if anything, is the answer instead.
   */
  const pagedServices = (hook?: (req: SentRequest, offset: number) => unknown) => ({
    ...tenantServices,
    chatsvc: async (req: SentRequest) => {
      if (!accountOf(req)) return reply(401);
      if (messagesOf(req) !== encodeURIComponent(CHAT)) return undefined;
      const offset = offsetOf(req);
      const early = await hook?.(req, offset);
      if (early !== undefined) return early;
      const next = offset + PAGE;
      return {
        messages: Array.from({ length: Math.min(PAGE, NOTES - offset) }, (_, i) => note(NOTES - offset - i)),
        _metadata: next < NOTES ? { backwardLink: `${BASES.chatsvc}/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages?startTime=1&syncState=${next}&view=msnp24Equivalent` } : {},
      };
    },
  });

  /** A worker signed in as tenant a, over pagedServices(hook). */
  async function signedInAsA(hook?: (req: SentRequest, offset: number) => unknown) {
    const fake = createFakeChrome({ captured: [], services: pagedServices(hook) });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    return { fake, worker };
  }
  const switchTo = async (fake: ReturnType<typeof createFakeChrome>, t: Tenant) => {
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, t);
  };
  const noteNumbers = (r: { messages: { text: string }[] }) => r.messages.map((m) => Number(/Note (\d+)/.exec(m.text)?.[1]));
  /** Notes 6 to 30, oldest first: the newest 25. */
  const NEWEST_25 = Array.from({ length: 25 }, (_, i) => 6 + i);

  it("77.1: a read of three pages with no switch returns the newest messages from all three, read as tenant a", async () => {
    const { fake, worker } = await signedInAsA();
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 25 });
    expect(r.count).toBe(25);
    expect(noteNumbers(r)).toEqual(NEWEST_25);
    expect(typeof r.olderCursor).toBe("string");
    expect(pageRequests(fake).map(offsetOf)).toEqual([0, 10, 20]);
    expect(pageRequests(fake).map(accountOf)).toEqual(["a", "a", "a"]);
  });

  it("77.1: Teams switches to tenant b right after answering page 1: the read is refused and no page is asked for as b", async () => {
    const { fake, worker } = await signedInAsA(async (req, offset) => {
      if (offset === 0) await switchTo(fake, "b");
    });
    await expect(worker.handlers.readMessages({ conversation: CHAT, limit: 25 })).rejects.toThrow(CHANGED);
    expect(fake.sent.map(tenantOf)).not.toContain("b");
  });

  it("77.1: a switch that lands while the last page's answer is still on its way: the read is refused", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const { fake, worker } = await signedInAsA(async (req, offset) => {
      if (offset === 20) await held;
    });
    const read = worker.handlers.readMessages({ conversation: CHAT, limit: 25 }).catch((err: Error) => err);
    await vi.waitFor(() => expect(pageRequests(fake).map(offsetOf)).toEqual([0, 10, 20]));
    await switchTo(fake, "b");
    release();
    const r = await read;
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(CHANGED);
    expect(fake.sent.map(tenantOf)).not.toContain("b");
  });

  it("77.1: a switch that a 401 on page 2 brings in: the read is refused before page 2 is asked for again as b", async () => {
    let switched = false;
    const { fake, worker } = await signedInAsA(async (req, offset) => {
      if (offset !== 10 || switched) return undefined;
      switched = true;
      // Teams switches to b meanwhile, and a's token is refused; the worker's retry would carry b's.
      await switchTo(fake, "b");
      fake.session.set("capture:chatsvc", { ...(fake.session.get("capture:chatsvc") as object), at: Date.now() + 60_000 });
      return reply(401);
    });
    await expect(worker.handlers.readMessages({ conversation: CHAT, limit: 25 })).rejects.toThrow(CHANGED);
    expect(pageRequests(fake).map(accountOf)).toEqual(["a", "a"]);
    expect(fake.sent.map(tenantOf)).not.toContain("b");
  });

  it("77.1: a 401 on page 2 renewed with a fresh token for the same user still returns all three pages", async () => {
    let renewed = false;
    const { fake, worker } = await signedInAsA((req, offset) => {
      if (offset !== 10 || renewed) return undefined;
      renewed = true;
      // a's token expired; Teams' next request brings a fresh one for the same user.
      fake.session.set("capture:chatsvc", { ...(fake.session.get("capture:chatsvc") as object), headers: { authentication: FRESH_A }, at: Date.now() + 60_000 });
      return reply(401);
    });
    const r = await worker.handlers.readMessages({ conversation: CHAT, limit: 25 });
    expect(r.count).toBe(25);
    expect(noteNumbers(r)).toEqual(NEWEST_25);
    expect(pageRequests(fake).map(offsetOf)).toEqual([0, 10, 10, 20]);
    expect(pageRequests(fake).map((q) => q.headers.authentication === FRESH_A)).toEqual([false, false, true, true]);
  });
});

describe("77.3: what a 401 and an account switch make the worker read again", () => {
  // Each tenant sees the same two chats: an untitled one with Alex (named by looking Alex up)
  // and a meeting chat whose call has a transcript on the organizer's OneDrive.
  type Fake = ReturnType<typeof createFakeChrome>;
  type Worker = Awaited<ReturnType<typeof loadWorker>>;
  const ALEX = "8:orgid:00000000-0000-4000-8000-0000000000c1";
  const meMri = (t: Tenant) => `8:orgid:${TENANT[t].oid}`;
  const myEmail = (t: Tenant) => `pat.${t}@contoso.example`;
  const WITH_ALEX = "19:contoso-with-alex@thread.v2";
  const MEETING = "19:meeting_contoso-review@thread.v2";
  const CALL = "00000000-0000-4000-8000-0000000000c2";
  const DAY = Date.parse("2026-09-30T09:00:00Z");
  const TRANSCRIPT_URL = `${SHAREPOINT_ORIGIN}/personal/alex_contoso_example/_api/v2.1/drives/d/items/i1/versions/current/media/transcripts/t1/content`;
  /** Tenant a's chat session after its token was renewed: the same user, another token. */
  const FRESH_A = `skypetoken=${fakeJwt({ skypeid: `orgid:${TENANT.a.oid}`, rgn: "emea", renewed: true })}`;
  const accountOf = (req: SentRequest) => tenantOf(req) ?? (req.headers.authentication === FRESH_A ? "a" : undefined);

  const callMessages = [
    {
      id: "3",
      messagetype: "RichText/Media_CallRecording",
      originalarrivaltime: new Date(DAY + 3_700_000).toISOString(),
      content: `<URIObject type="Video.2/CallRecording.1"><RecordingStatus status="Success" code="200" /><Title>Contoso review</Title><Identifiers><Id type="callId" value="${CALL}" /></Identifiers><RecordingContent contentTypes="Transcript" timestamp="${new Date(DAY).toISOString()}" duration="1:00:00.00"><item type="onedriveForBusinessTranscript" uri="${TRANSCRIPT_URL}" /></RecordingContent></URIObject>`,
    },
    {
      id: "2",
      messagetype: "Event/Call",
      originalarrivaltime: new Date(DAY + 3_600_000).toISOString(),
      properties: { skypeguid: CALL },
      content: `<ended/><partlist alt="" count="1"><part identity="${ALEX}"><displayName>Alex Doe</displayName><duration>3600</duration></part></partlist><callEventType>callEnded</callEventType><callId>${CALL}</callId>`,
    },
    {
      id: "1",
      messagetype: "Event/Call",
      originalarrivaltime: new Date(DAY).toISOString(),
      properties: { skypeguid: CALL },
      content: `<partlist alt=""></partlist><callEventType>callStarted</callEventType><conversationStartTime>09/30/2026 09:00:00</conversationStartTime><callId>${CALL}</callId>`,
    },
  ];
  const transcript = {
    entries: Array.from({ length: 4 }, (_, i) => ({
      speakerDisplayName: "Alex Doe",
      startOffset: `00:00:${String(i * 10).padStart(2, "0")}.0`,
      endOffset: `00:00:${String(i * 10 + 9).padStart(2, "0")}.0`,
      text: `The plan for the review, point ${i}.`,
    })),
  };

  /** Teams for whichever account asks. `onChatRead` runs first when the chat with Alex is read; what it returns, if anything, is the answer instead. */
  const services = (onChatRead: () => unknown) => ({
    csa: (req: SentRequest) => {
      const t = tenantOf(req);
      if (!t) return reply(401);
      return {
        teams: [],
        chats: [
          { id: WITH_ALEX, title: null, chatType: "chat", members: [{ mri: meMri(t) }, { mri: ALEX }] },
          {
            id: MEETING,
            chatType: "meeting",
            title: "Contoso review",
            meetingInformation: { subject: "Contoso review", startTime: new Date(DAY).toISOString() },
            meetingObjectsConfig: { configurations: { transcriptConfig: { hasTranscript: true } } },
            lastJoinAt: new Date(DAY).toISOString(),
          },
        ],
      };
    },
    chatsvc: async (req: SentRequest) => {
      if (!accountOf(req)) return reply(401);
      if (req.method === "POST") return { OriginalArrivalTime: Date.parse("2026-10-01T09:00:00Z") };
      const id = messagesOf(req);
      if (!id) return undefined;
      if (decodeURIComponent(id) === MEETING) return { messages: callMessages, _metadata: {} };
      const early = decodeURIComponent(id) === WITH_ALEX ? await onChatRead() : undefined;
      return early !== undefined ? early : { messages: [] };
    },
    mt: (req: SentRequest) => {
      if (!tenantOf(req)) return reply(401);
      if (!/fetchShortProfile/.test(req.path)) return { value: [] };
      const all = [
        { mri: meMri("a"), displayName: "Pat A", email: myEmail("a") },
        { mri: meMri("b"), displayName: "Pat B", email: myEmail("b") },
        { mri: ALEX, displayName: "Alex Doe", email: "alex.doe@contoso.example" },
      ];
      return all.filter((p) => (req.body as string[]).includes(p.mri));
    },
    sharepoint: (req: SentRequest) => (req.url.startsWith(TRANSCRIPT_URL) ? transcript : undefined),
  });

  const since = (fake: Fake, from: number) => fake.sent.slice(from);
  const profileLookups = (fake: Fake, from: number) => since(fake, from).filter((r) => r.service === "mt" && /fetchShortProfile/.test(r.path));
  /** Alex's name looked up (to name the untitled chat). */
  const alexLookups = (fake: Fake, from: number) => profileLookups(fake, from).filter((r) => (r.body as string[]).includes(ALEX));
  /** My own addresses looked up (for an auto-send to self): a lookup of just me. */
  const myAddressLookups = (fake: Fake, from: number, t: Tenant) => profileLookups(fake, from).filter((r) => JSON.stringify(r.body) === JSON.stringify([meMri(t)]));
  const listReads = (fake: Fake, from: number) => since(fake, from).filter((r) => r.service === "csa" && /\/teams\/users\/me\?/.test(r.path));
  const meetingReads = (fake: Fake, from: number) => since(fake, from).filter((r) => messagesOf(r) === encodeURIComponent(MEETING));
  const transcriptReads = (fake: Fake, from: number) => since(fake, from).filter((r) => r.service === "sharepoint");

  const autoSendToSelf = (worker: Worker, t: Tenant) =>
    expect(worker.handlers.requestSend({ conversation: "48:notes", text: "Remember the slides", autoSendTo: [myEmail(t)] })).resolves.toMatchObject({ sent: true, autoSent: true });
  /**
   * #77: back as a within 30 s of the switch to b, a capture of the account it switched from: the
   * account is unsure, so the auto-send is refused; once the switch's 30 s are over, it goes through.
   */
  const autoSendToSelfOnceSure = async (worker: Worker, t: Tenant) => {
    await expect(worker.handlers.requestSend({ conversation: "48:notes", text: "Remember the slides", autoSendTo: [myEmail(t)] })).resolves.toEqual({
      sent: false,
      reason: expect.stringMatching(/Teams switched accounts moments ago; try again after \d\d:\d\d:\d\d/),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 30_000);
      await autoSendToSelf(worker, t);
    } finally {
      vi.useRealTimers();
    }
  };

  /** A 401 renewed with a fresh token for the same user. */
  const renewedForA = (fake: Fake) => () => {
    fake.session.set("capture:chatsvc", { ...(fake.session.get("capture:chatsvc") as object), headers: { authentication: FRESH_A }, at: Date.now() + 60_000 });
    return reply(401);
  };
  /** Teams switches to tenant b meanwhile, and a's token is refused: the worker's retry carries b's. */
  const switchedToB = (fake: Fake) => async () => {
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "b");
    fake.session.set("capture:chatsvc", { ...(fake.session.get("capture:chatsvc") as object), at: Date.now() + 60_000 });
    return reply(401);
  };

  const EVENTS = {
    "a 401 renewed for the same user": { as: "a", on401: renewedForA, switches: [] },
    "a 401 whose fresh session is tenant b's": { as: "b", on401: switchedToB, switches: [] },
    "a switch to tenant b with no 401": { as: "b", on401: null, switches: ["b"] },
    // Back as a, the account the list and the calls were filed under: what a read before the switches is gone too.
    // Within 30 s of the switch to b, the account is unsure (#77): the auto-send waits out the 30 s.
    "a switch to tenant b and back to a, with no 401": { as: "a", on401: null, switches: ["b", "a"], unsure: true },
  } as const;

  /**
   * Signed in as tenant a with every cache filled (my address, the list and Alex's name, the
   * meeting's calls and its transcript), then `event`; returns where the requests after it start.
   * Afterwards: the list, the transcript, and an auto-send to self, in that order.
   */
  async function readAgainAfter(name: keyof typeof EVENTS) {
    const event = EVENTS[name];
    let onChatRead: () => unknown = () => undefined;
    const fake = createFakeChrome({ captured: [], services: services(() => onChatRead()) });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, "a");
    await autoSendToSelf(worker, "a");
    await worker.handlers.listChats({});
    await worker.handlers.readTranscript({ meeting: MEETING });
    expect([alexLookups(fake, 0), myAddressLookups(fake, 0, "a"), meetingReads(fake, 0), transcriptReads(fake, 0)].map((x) => x.length)).toEqual([1, 1, 1, 1]);
    // Cached: read again, they ask Teams nothing.
    const warm = fake.sent.length;
    await worker.handlers.listChats({});
    await worker.handlers.readTranscript({ meeting: MEETING });
    expect(fake.sent.length).toBe(warm);

    if (event.on401) {
      let once = event.on401(fake) as () => unknown;
      onChatRead = () => {
        const answer = once();
        once = () => undefined;
        return answer;
      };
      const read = worker.handlers.readMessages({ conversation: WITH_ALEX });
      if (event.as === "a") await read;
      else await expect(read).rejects.toThrow(/account changed/);
    }
    // Back to a (where it started), Teams brings fresh tokens.
    for (const t of event.switches) for (const s of ["csa", "chatsvc", "mt"] as const) await teamsRequest(fake, s, t, t === "a" ? BACK_TO_A : TOKENS[t]);
    expect((await worker.handlers.status({})).signedInAs).toBe(meMri(event.as));

    const at = fake.sent.length;
    await worker.handlers.listChats({});
    await worker.handlers.readTranscript({ meeting: MEETING });
    if ("unsure" in event) await autoSendToSelfOnceSure(worker, event.as);
    else await autoSendToSelf(worker, event.as);
    return { fake, at, as: event.as as Tenant };
  }

  it("77.3: after a 401 whose fresh session is tenant b's, names, my address, the list, the meeting's calls and its transcript are all read again, as b", async () => {
    const { fake, at } = await readAgainAfter("a 401 whose fresh session is tenant b's");
    expect(listReads(fake, at).map(tenantOf)).toEqual(["b"]);
    expect(alexLookups(fake, at).map(tenantOf)).toEqual(["b"]);
    expect(meetingReads(fake, at).map(tenantOf)).toEqual(["b"]);
    expect(transcriptReads(fake, at)).toHaveLength(1);
    expect(myAddressLookups(fake, at, "b").map(tenantOf)).toEqual(["b"]);
    expect(since(fake, at).map(tenantOf)).not.toContain("a");
  });

  it("77.3: after a 401 renewed for the same user, names, my address and a transcript already read aren't looked up again", async () => {
    const { fake, at } = await readAgainAfter("a 401 renewed for the same user");
    expect(alexLookups(fake, at)).toEqual([]);
    expect(transcriptReads(fake, at)).toEqual([]);
    expect(myAddressLookups(fake, at, "a")).toEqual([]);
    // The list and the meeting's calls are read again (as the next test checks), with a's fresh token.
    expect(meetingReads(fake, at).map((r) => r.headers.authentication === FRESH_A)).toEqual([true]);
  });

  it.each(Object.keys(EVENTS) as (keyof typeof EVENTS)[])("77.3: after %s, the list and the meeting's calls are read again, as whoever is signed in", async (name) => {
    const { fake, at, as } = await readAgainAfter(name);
    expect(listReads(fake, at).map(tenantOf)).toEqual([as]);
    expect(meetingReads(fake, at).map(accountOf)).toEqual([as]);
  });
});
