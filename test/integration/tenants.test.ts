// 3.3: the worker's caches and captured sessions belong to one signed-in account (tenant).
// A 401 empties the chat list cache, and after the user switches Teams to another tenant
// nothing of the first one (its chats, its captured sessions) is used or returned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, reply, TEAMS_ORIGIN, type SentRequest } from "../helpers/fakeChrome.js";

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

/** An unsigned JWT with these claims (the worker only reads ids from it). */
const fakeJwt = (claims: object) => `${[{ alg: "none", typ: "JWT" }, claims].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".")}.`;
/** Each tenant's tokens: AAD bearer tokens for csa and mt, a skype token for chatsvc. */
const TOKENS = Object.fromEntries(
  (Object.keys(TENANT) as Tenant[]).map((t) => [
    t,
    {
      bearer: `Bearer ${fakeJwt({ tid: TENANT[t].tid, oid: TENANT[t].oid, name: `fake ${t}` })}`,
      skype: `skypetoken=${fakeJwt({ skypeid: `orgid:${TENANT[t].oid}`, rgn: "emea" })}`,
    },
  ]),
) as Record<Tenant, { bearer: string; skype: string }>;

/** The tenant whose token a request carried. */
const tenantOf = (req: SentRequest): Tenant | undefined =>
  (Object.keys(TOKENS) as Tenant[]).find((t) => req.headers.authorization === TOKENS[t].bearer || req.headers.authentication === TOKENS[t].skype);

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
async function teamsRequest(fake: ReturnType<typeof createFakeChrome>, service: "csa" | "chatsvc" | "mt", t: Tenant) {
  const url = {
    csa: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`,
    chatsvc: `${BASES.chatsvc}/v1/users/ME/conversations?view=msnp24Equivalent`,
    mt: `${BASES.mt}/beta/users/${TENANT[t].oid}/capabilities`,
  }[service];
  const header = service === "chatsvc" ? { name: "Authentication", value: TOKENS[t].skype } : { name: "Authorization", value: TOKENS[t].bearer };
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
