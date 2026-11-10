// #77: the account is *unsure* after a switch when the previous account shows again within 30 s
// (A → B → A): Teams may be showing either. A send never goes out as an account other than the one
// Teams shows; while that can't be known, it doesn't go out: it is refused at once, with a time to
// retry. Reads keep working, with a note. The real worker (extension/background.js) under a fake
// chrome, the account showing through Teams' own requests; get_version through the real tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";
import { BASES, createFakeChrome, loadWorker, openedSockets, reply, TEAMS_ORIGIN, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";
import { fakeJwt } from "../helpers/jwt.js";
import { until } from "../helpers/timing.js";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

// Two fictional accounts: Alex Doe and Sam Roe.
const ACCOUNT = {
  alex: { oid: "00000000-0000-4000-8000-0000000000a1", name: "Alex Doe", email: "alex.doe@contoso.example" },
  sam: { oid: "00000000-0000-4000-8000-0000000000b1", name: "Sam Roe", email: "sam.roe@fabrikam.example" },
} as const;
type Account = keyof typeof ACCOUNT;
const ACCOUNTS = Object.keys(ACCOUNT) as Account[];

// When tokens were issued (seconds since 1970): Alex's old one, then Sam's, which switches.
const OLD = 1_790_000_000;
const SWITCHING = OLD + 600;

// The switch happens at 14:00:00 local time (the clock stands still unless set), so the account is
// unsure until 14:00:30, which a refusal names.
const SWITCHED_AT = new Date(2026, 10, 9, 14, 0, 0);
const UNSURE = { since: SWITCHED_AT.toISOString(), until: new Date(2026, 10, 9, 14, 0, 30).toISOString() };
const RETRY_AT = /Teams switched accounts moments ago; try again after 14:00:30\b/;

const bearer = (t: Account, iat: number) => `Bearer ${fakeJwt({ oid: ACCOUNT[t].oid, iat })}`;
const skype = (t: Account, iat: number) => `skypetoken=${fakeJwt({ skypeid: `orgid:${ACCOUNT[t].oid}`, iat })}`;
/** The account whose token a request carried (its payload's oid or skypeid). */
const accountOf = (req: SentRequest) => {
  const token = String(req.headers.authorization ?? req.headers.authentication ?? "");
  const payload = token.split(".")[1];
  const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString()) : {};
  const oid = claims.oid ?? String(claims.skypeid ?? "").replace(/^orgid:/, "");
  return ACCOUNTS.find((t) => ACCOUNT[t].oid === oid);
};

const ALPHA = "19:alpha@thread.v2";
// Someone else to write to, found by people search: Jamie Poe (no chat with either account yet).
const JAMIE = { mri: "8:orgid:00000000-0000-4000-8000-0000000000c1", name: "Jamie Poe", email: "jamie.poe@contoso.example" };

/** Holds on a service's answers: a promise to wait for, or an answer of its own (e.g. a 429). */
type Hold = (r: SentRequest) => unknown;
/** Each account's Teams: its chats (with its notes to self), its profile, people search, and posts that go through. */
const servicesWith = (holds: { csa?: Hold; mt?: Hold; chatsvc?: Hold } = {}) => ({
  csa: async (r: SentRequest) => {
    await holds.csa?.(r);
    const t = accountOf(r);
    return {
      teams: [],
      chats: [
        { id: ALPHA, title: "Alpha launch", chatType: "group" },
        ...(t ? [{ id: "48:notes", title: "Notes", chatType: "chat", members: [{ mri: `8:orgid:${ACCOUNT[t].oid}` }] }] : []),
      ],
    };
  },
  mt: async (r: SentRequest) => {
    await holds.mt?.(r);
    const t = accountOf(r);
    return t ? (r.body as string[]).filter((m) => m === `8:orgid:${ACCOUNT[t].oid}`).map((mri) => ({ mri, displayName: ACCOUNT[t].name, email: ACCOUNT[t].email })) : [];
  },
  substrate: (r: SentRequest) => {
    const q = String((r.body as { EntityRequests: { Query: { QueryString: string } }[] }).EntityRequests[0].Query.QueryString).toLowerCase();
    const people = [JAMIE].filter((p) => p.email === q);
    return { Groups: [{ Suggestions: people.map((p) => ({ EntityType: "People", MRI: p.mri, DisplayName: p.name, EmailAddresses: [p.email] })) }] };
  },
  chatsvc: async (r: SentRequest) => {
    const own = await holds.chatsvc?.(r);
    if (own !== undefined) return own;
    return r.method === "POST" ? { OriginalArrivalTime: Date.parse("2026-11-09T13:00:05Z") } : { messages: [] };
  },
});

/** Teams in the tab calls its services as this account, which the worker captures. */
async function teamsShows(fake: FakeChrome, t: Account, iat: number) {
  await fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t, iat) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=x`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authentication", value: skype(t, iat) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.mt}/beta/users/${ACCOUNT[t].oid}/capabilities`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t, iat) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.substrate}/search/api/v1/suggestions?scenario=peoplepicker.newChat`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t, iat) }] });
}

/** Teams retries one request with this token (one capture, for csa). */
const teamsRetries = (fake: FakeChrome, t: Account, iat: number) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t, iat) }] });

/** At 14:00:00, Teams showed Alex (old token), then switched to Sam. */
async function switchedToSam(services: ReturnType<typeof servicesWith> = servicesWith()) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SWITCHED_AT);
  const fake = createFakeChrome({ captured: [], services });
  fake.session.delete("oid");
  const worker = await loadWorker(fake);
  worker.registerListeners();
  await teamsShows(fake, "alex", OLD);
  await teamsShows(fake, "sam", SWITCHING);
  return { fake, worker };
}

type Worker = Awaited<ReturnType<typeof loadWorker>>;
const signedInAs = async (worker: Worker) => (await worker.handlers.status({})).signedInAs;
const windows = (fake: FakeChrome) => fake.spies.windowsCreate.mock.calls.length;
const windowOpened = (fake: FakeChrome) => vi.waitFor(() => expect(windows(fake)).toBe(1), { timeout: 5_000 });
const posts = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST");
const clickSend = (fake: FakeChrome) => {
  const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
  return fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });
};
/** A promise the test resolves, and the hold that waits for it. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

/** get_version's output, from a server whose extension answers status with `status()`. */
async function getVersion(status: () => Promise<unknown>) {
  const bridge = {
    connected: true,
    extension: { version: "0.3.52", browser: "Chrome" },
    extensions: [{ version: "0.3.52", browser: "Chrome" }],
    listenError: null,
    role: "hub",
    port: 0,
    hubVersion: null,
    call: async (method: string) => (method === "status" ? status() : Promise.reject(new Error(`unexpected ${method}`))),
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return JSON.parse(((await client.callTool({ name: "get_version", arguments: {} })) as { content: { text: string }[] }).content[0].text);
}

describe("#77: sends are refused while the account is unsure", () => {
  it("A → B, then A's old token within 30 s: dropped, the account is unsure, and a send is refused before the window opens, naming when to retry", async () => {
    const { fake, worker } = await switchedToSam();
    expect((await worker.handlers.status({})).accountUnsure).toBeNull();

    await teamsRetries(fake, "alex", OLD);

    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.sam.oid}`); // dropped, as before
    expect((await worker.handlers.status({})).accountUnsure).toEqual(UNSURE);
    const result = await worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    expect(result).toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(windows(fake)).toBe(0);
    expect(posts(fake)).toEqual([]);
  });

  it("unsure starts while the confirmation window is open: the click is refused, and nothing is posted", async () => {
    const { fake, worker } = await switchedToSam();
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await windowOpened(fake);

    await teamsRetries(fake, "alex", OLD);
    await clickSend(fake);

    await expect(result).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(posts(fake)).toEqual([]);
  });

  it("auto-send (notes to self), with unsure starting during its lookups: refused, nothing posted", async () => {
    let lookups = 0;
    const lookup = gate();
    const { fake, worker } = await switchedToSam(servicesWith({ mt: () => (lookups++ === 0 ? lookup.opened : undefined) }));
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.sam.email] });
    await vi.waitFor(() => expect(lookups).toBe(1)); // the send checked who it is for and looks up Sam's addresses

    await teamsRetries(fake, "alex", OLD);
    lookup.open();

    await expect(result).resolves.toEqual({ sent: false, autoSent: true, reason: expect.stringMatching(RETRY_AT) });
    expect(windows(fake)).toBe(0);
    expect(posts(fake)).toEqual([]);
  });

  it("mirror case: B's switching token is older than A's retry, so the account flips back to A; B's next capture within 30 s marks it unsure, and a send is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SWITCHED_AT);
    const fake = createFakeChrome({ captured: [], services: servicesWith() });
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsShows(fake, "alex", SWITCHING);
    await teamsShows(fake, "sam", OLD); // a cached older token of Sam's switches to Sam
    await teamsRetries(fake, "alex", SWITCHING); // Alex's genuine retry is later: it isn't dropped
    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.alex.oid}`);
    // A capture of the account it switched from, within 30 s: unsure from the flip on, before Sam shows again.
    expect((await worker.handlers.status({})).accountUnsure).toEqual(UNSURE);
    await expect(worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" })).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });

    await teamsRetries(fake, "sam", OLD); // Teams still shows Sam

    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.alex.oid}`); // dropped: older than Alex's
    expect((await worker.handlers.status({})).accountUnsure).toEqual(UNSURE);
    const result = await worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    expect(result).toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(windows(fake)).toBe(0);
    expect(posts(fake)).toEqual([]);
  });

  it("once the switch's window closes, the next capture decides normally: unsure is null again, and sends go through", async () => {
    const { fake, worker } = await switchedToSam();
    await teamsRetries(fake, "alex", OLD);
    expect((await worker.handlers.status({})).accountUnsure).toEqual(UNSURE);

    vi.setSystemTime(SWITCHED_AT.getTime() + 30_000);
    expect((await worker.handlers.status({})).accountUnsure).toBeNull();
    await teamsShows(fake, "alex", OLD); // outside the window: a switch back, as before

    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.alex.oid}`);
    expect((await worker.handlers.status({})).accountUnsure).toBeNull();
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await windowOpened(fake);
    await clickSend(fake);
    await expect(result).resolves.toMatchObject({ sent: true, conversation: "Alpha launch" });
    expect(posts(fake).map(accountOf)).toEqual(["alex"]);
  });
});

describe("#77: reads and status while the account is unsure", () => {
  it("a read works and carries a note; get_version shows accountUnsure", async () => {
    const { fake, worker } = await switchedToSam();
    await teamsRetries(fake, "alex", OLD);

    const replies: { ok: boolean; result?: { chats: { title: string }[]; accountNote?: string } }[] = [];
    await worker.dispatch({ type: "request", id: "r1", method: "listChats", params: {}, timeoutMs: 60_000 }, (r) => replies.push(r as (typeof replies)[number]));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(true);
    expect(replies[0].result!.chats.map((c) => c.title)).toContain("Alpha launch");
    expect(replies[0].result!.accountNote).toMatch(/Teams switched accounts moments ago.*14:00:30/);
    const v = await getVersion(() => worker.handlers.status({}));
    expect(v.teams.accountUnsure).toEqual(UNSURE);
    expect(v.teams.droppedOldCaptures.count).toBe(1);
  });

  it("a read when the account isn't unsure carries no note", async () => {
    const { worker } = await switchedToSam();
    const replies: { ok: boolean; result?: object }[] = [];
    await worker.dispatch({ type: "request", id: "r1", method: "listChats", params: {}, timeoutMs: 60_000 }, (r) => replies.push(r as (typeof replies)[number]));
    expect(replies[0].ok).toBe(true);
    expect(replies[0].result).not.toHaveProperty("accountNote");
  });

  it("get_version with an older extension (no accountUnsure in its status) shows accountUnsure: null", async () => {
    const v = await getVersion(async () => ({ extensionVersion: "0.3.52", teamsTabs: 1, sessions: [{ sessionCaptured: true }], droppedOldCaptures: { count: 0, lastAt: null } }));
    expect(v.teams).toHaveProperty("accountUnsure", null);
  });

  it("a restart of the worker in the middle of the window keeps the unsure state", async () => {
    const { fake } = await switchedToSam();
    await teamsRetries(fake, "alex", OLD);
    fake.stopWorker();
    const next = await loadWorker(fake);
    next.registerListeners();

    expect((await next.handlers.status({})).accountUnsure).toEqual(UNSURE);
    const result = await next.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    expect(result).toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(windows(fake)).toBe(0);
    expect(posts(fake)).toEqual([]);
  });
});

describe("#77: rule 1 as written: any capture of the previous account within 30 s marks the account unsure", () => {
  // A token of Alex's issued after Sam's: not dropped, a switch back.
  const FRESH = SWITCHING + 600;

  it("within 30 s, a capture of the previous account that switches back (a newer token) marks the account unsure too: a send is refused", async () => {
    const { fake, worker } = await switchedToSam();

    await teamsRetries(fake, "alex", FRESH);

    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.alex.oid}`); // switched back, as before
    expect((await worker.handlers.status({})).accountUnsure).toEqual(UNSURE);
    await expect(worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" })).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(windows(fake)).toBe(0);
  });

  it("a switch back while unsure doesn't clear it: unsure since the drop, until 30 s after the switch back", async () => {
    const { fake, worker } = await switchedToSam();
    await teamsRetries(fake, "alex", OLD); // dropped at 14:00:00: unsure
    vi.setSystemTime(SWITCHED_AT.getTime() + 10_000);

    await teamsRetries(fake, "alex", FRESH); // 14:00:10: a switch back to Alex

    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.alex.oid}`);
    expect((await worker.handlers.status({})).accountUnsure).toEqual({ since: SWITCHED_AT.toISOString(), until: new Date(2026, 10, 9, 14, 0, 40).toISOString() });
  });
});

describe("#77: each check that refuses a send while unsure, on its own", () => {
  /** Until the send answered or opened a window (a window keeps it waiting for a decision). */
  const answerOrWindow = (fake: FakeChrome, result: Promise<unknown>) =>
    Promise.race([result.catch(() => {}), vi.waitFor(() => expect(windows(fake)).toBeGreaterThan(0), { timeout: 4_000 })]);

  it("requestSend: unsure before the send starts: refused before anything is looked up for it", async () => {
    const { fake, worker } = await switchedToSam();
    await teamsRetries(fake, "alex", OLD);
    const before = fake.sent.length;

    await expect(worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" })).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });

    expect(fake.sent.slice(before)).toEqual([]); // not even the chat list
  });

  it("askUserToConfirm: unsure starts during the send's lookups: no window opens", async () => {
    let reads = 0;
    const list = gate();
    const { fake, worker } = await switchedToSam(servicesWith({ csa: () => (reads++ === 0 ? list.opened : undefined) }));
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await vi.waitFor(() => expect(reads).toBe(1)); // past the first check, reading the chat list

    await teamsRetries(fake, "alex", OLD);
    list.open();

    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
    expect(posts(fake)).toEqual([]);
  });

  it("sendWithoutConfirming: unsure starts during an auto-send's lookups: refused before it asks Teams anything more", async () => {
    let lookups = 0;
    const lookup = gate();
    const { fake, worker } = await switchedToSam(servicesWith({ mt: () => (lookups++ === 0 ? lookup.opened : undefined) }));
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.sam.email] });
    await vi.waitFor(() => expect(lookups).toBe(1));

    await teamsRetries(fake, "alex", OLD);
    const before = fake.sent.length;
    lookup.open();

    await expect(result).resolves.toEqual({ sent: false, autoSent: true, reason: expect.stringMatching(RETRY_AT) });
    expect(fake.sent.slice(before)).toEqual([]); // not even the sender's name
  });
});

describe("#77: a post that waits out Teams' throttling", () => {
  it("the old token is dropped while the clicked post waits for the gate a 429 closed: nothing is posted", async () => {
    let throttled = false;
    const services = servicesWith({
      chatsvc: (r) => {
        if (r.method !== "GET" || throttled) return undefined;
        throttled = true;
        return reply(429, { message: "Too many requests" }, { headers: { "retry-after": "1" } });
      },
    });
    // The clock stands still, so the gate a 429 shuts stays shut until the test moves the clock on.
    const { fake, worker } = await switchedToSam(services);
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await windowOpened(fake);
    // A read is throttled: chatsvc's gate shuts for a second. Its deadline leaves no time to wait
    // that out, so it fails at once as busy, and the post is the only one to wait at the gate.
    const replies: { ok: boolean; error?: string }[] = [];
    await worker.dispatch({ type: "request", id: "r1", method: "readMessages", params: { conversation: ALPHA }, timeoutMs: 60_000, deadline: Date.now() + 1_100 }, (r) =>
      replies.push(r as (typeof replies)[number]),
    );
    expect(replies).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/Teams is busy \(throttled\)/) })]);

    // The post's own check before the gate finds the account sure; the drop lands once it waits
    // there: it sleeps for the gate's second (again each second while the clock stands still).
    // Not vi.waitFor, which moves a fake clock on as it polls. (until's own timeout counts on that
    // clock too, so a post that never waits fails on the test's timeout.)
    const sleeps = vi.spyOn(globalThis, "setTimeout");
    try {
      const clicked = clickSend(fake); // answered once the send is done
      await until(() => sleeps.mock.calls.some(([, ms]) => ms === 1_000), undefined, "the post to wait at the gate");
      await teamsRetries(fake, "alex", OLD);
      vi.setSystemTime(Date.now() + 1_000); // the gate opens

      await expect(result).resolves.toEqual({ sent: false, reason: expect.stringMatching(RETRY_AT) });
      await clicked;
    } finally {
      sleeps.mockRestore();
    }
    expect(posts(fake)).toEqual([]);
  });
});

describe("#77: a new chat created just before the account turned unsure", () => {
  it("the chat was created, then the message is refused: the reason says so once, with when to retry", async () => {
    let shown: FakeChrome | null = null;
    const services = servicesWith({
      // The drop lands while Teams creates the chat: after that post's check, before the message's.
      chatsvc: async (r) => {
        if (shown && r.method === "POST" && /\/threads$/.test(r.path)) await teamsRetries(shown, "alex", OLD);
        return undefined;
      },
    });
    const { fake, worker } = await switchedToSam(services);
    shown = fake;
    const result = worker.handlers.requestSend({ to: [JAMIE.email], text: "Hi Jamie" });
    await windowOpened(fake);

    await clickSend(fake);

    const r = (await result) as { sent: boolean; reason: string };
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/^The chat was created, but the message wasn't sent: Teams switched accounts moments ago\b/);
    expect(r.reason).toMatch(/after 14:00:30\b/i);
    expect(r.reason).not.toMatch(/Nothing was sent/);
    expect(posts(fake).filter((p) => /\/threads$/.test(p.path))).toHaveLength(1);
    expect(posts(fake).filter((p) => /\/messages$/.test(p.path))).toEqual([]);
  });
});
