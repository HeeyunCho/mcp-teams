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
