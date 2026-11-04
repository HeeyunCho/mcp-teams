// A send confirmed or judged as one account is never posted as another, also on a cold start:
// a send that begins before Teams has shown who is signed in (just after a browser start or an
// extension reload). The real worker (extension/background.js) under a fake chrome, with the
// account switching through Teams' own requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, stopWorkers, TEAMS_ORIGIN, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";

afterEach(() => {
  stopWorkers(); // no save of the worker's last calls left waiting without its fake chrome (#103)
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

// Two fictional accounts in the same region: Alex Doe (a) and Sam Roe (b).
const ACCOUNT = {
  a: { oid: "00000000-0000-4000-8000-0000000000a1", name: "Alex Doe", email: "alex.doe@contoso.example" },
  b: { oid: "00000000-0000-4000-8000-0000000000b1", name: "Sam Roe", email: "sam.roe@fabrikam.example" },
};
type Account = keyof typeof ACCOUNT;
// Someone else to write to: Jamie Poe, found by people search.
const JAMIE = { mri: "8:orgid:00000000-0000-4000-8000-0000000000c1", name: "Jamie Poe", email: "jamie.poe@contoso.example" };
const ACCOUNTS = Object.keys(ACCOUNT) as Account[];

const fakeJwt = (claims: object) => `${[{ alg: "none", typ: "JWT" }, claims].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".")}.`;
const bearer = (t: Account) => `Bearer ${fakeJwt({ oid: ACCOUNT[t].oid })}`;
const skype = (t: Account) => `skypetoken=${fakeJwt({ skypeid: `orgid:${ACCOUNT[t].oid}` })}`;
const accountOf = (req: SentRequest) => ACCOUNTS.find((t) => req.headers.authorization === bearer(t) || req.headers.authentication === skype(t));

const ALPHA = "19:alpha@thread.v2";
const chatsOf = (t?: Account) => ({
  teams: [],
  chats: [
    { id: ALPHA, title: "Alpha launch", chatType: "group" },
    ...(t ? [{ id: "48:notes", title: "Notes", chatType: "chat", members: [{ mri: `8:orgid:${ACCOUNT[t].oid}` }] }] : []),
  ],
});

/** People search: Jamie, and whichever account searches for its own address. */
const searchAs = (r: SentRequest) => {
  const t = accountOf(r);
  const q = String((r.body as { EntityRequests: { Query: { QueryString: string } }[] }).EntityRequests[0].Query.QueryString).toLowerCase();
  const people = [JAMIE, ...(t ? [{ mri: `8:orgid:${ACCOUNT[t].oid}`, name: ACCOUNT[t].name, email: ACCOUNT[t].email }] : [])].filter((p) => p.email === q);
  return { Groups: [{ Suggestions: people.map((p) => ({ EntityType: "People", MRI: p.mri, DisplayName: p.name, EmailAddresses: [p.email] })) }] };
};

/** Each account's Teams; `holds` answers wait as long as the test wants (the switch lands meanwhile). */
const servicesWith = (holds: { csa?: (r: SentRequest) => Promise<void> | void; mt?: (r: SentRequest) => Promise<void> | void } = {}) => ({
  csa: async (r: SentRequest) => {
    await holds.csa?.(r);
    return chatsOf(accountOf(r));
  },
  mt: async (r: SentRequest) => {
    await holds.mt?.(r);
    const t = accountOf(r);
    return t ? (r.body as string[]).filter((m) => m === `8:orgid:${ACCOUNT[t].oid}`).map((mri) => ({ mri, displayName: ACCOUNT[t].name, email: ACCOUNT[t].email })) : [];
  },
  substrate: searchAs,
  // As Teams would for a chat it knows: either account may post, so only the worker can refuse.
  chatsvc: (r: SentRequest) => (r.method === "POST" ? { OriginalArrivalTime: Date.parse("2026-10-18T10:00:00Z") } : { messages: [] }),
});

/** A promise the test resolves, and the hold that waits for it once armed. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

/** Teams in the tab calls its services as this account, which the worker captures. */
async function teamsShows(fake: FakeChrome, t: Account) {
  await fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations?view=x`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authentication", value: skype(t) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.mt}/beta/users/${ACCOUNT[t].oid}/capabilities`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t) }] });
  await fake.fire("beforeSendHeaders", { url: `${BASES.substrate}/search/api/v1/suggestions?scenario=peoplepicker.newChat`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: bearer(t) }] });
}

/** A worker where Teams hasn't shown anyone yet: no sessions, no account. */
async function cold(services = servicesWith()) {
  const fake = createFakeChrome({ captured: [], services });
  fake.session.delete("oid");
  const worker = await loadWorker(fake);
  worker.registerListeners();
  return { fake, worker };
}

/** A worker where Teams has already shown this account. */
async function warm(t: Account, services = servicesWith()) {
  const { fake, worker } = await cold(services);
  await teamsShows(fake, t);
  return { fake, worker };
}

/** Starts a send on a cold worker, and lets Teams show `t` once the send waits for a session. */
async function sendAsTeamsWakes<T>(fake: FakeChrome, start: () => Promise<T>, t: Account) {
  const before = fake.listenerCounts().storageOnChanged;
  const result = start();
  await vi.waitFor(() => expect(fake.listenerCounts().storageOnChanged).toBeGreaterThan(before));
  await new Promise((r) => setTimeout(r, 5)); // a capture must be later than the wait's start
  await teamsShows(fake, t);
  return { result }; // in an object: awaiting this doesn't wait for the send itself
}

const windows = (fake: FakeChrome) => fake.spies.windowsCreate.mock.calls.length;
const windowOpened = (fake: FakeChrome) => vi.waitFor(() => expect(windows(fake)).toBe(1), { timeout: 5_000 });
/** Until the send answered or opened a window (a window keeps it waiting for a decision). */
const answerOrWindow = (fake: FakeChrome, result: Promise<unknown>) =>
  Promise.race([result.catch(() => {}), vi.waitFor(() => expect(windows(fake)).toBeGreaterThan(0), { timeout: 4_000 })]);
const posts = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST");
const clickSend = (fake: FakeChrome) => {
  const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
  return fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });
};
/** The message posts (not the creation of a chat). */
const messagePosts = (fake: FakeChrome) => posts(fake).filter((r) => /\/messages$/.test(r.path));
const CHANGED = "The signed-in Teams account changed since this was confirmed; nothing was sent.";
const CHANGED_BEFORE = "The signed-in Teams account changed while this send was being prepared; nothing was sent. Check who is signed in, then try again.";

describe("cold start: the confirmation window", () => {
  it("cold start: the window opened once Teams showed Alex, clicked after the switch to Sam: nothing is posted", async () => {
    const { fake, worker } = await cold();
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" }), "a");
    await windowOpened(fake);

    await teamsShows(fake, "b");
    const before = fake.sent.length;
    await clickSend(fake);

    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake)).toEqual([]);
    // The click itself refuses: not even a read goes out as Sam before the post would be refused.
    expect(fake.sent.slice(before)).toEqual([]);
  });

  it("warm control: the same switch and click, with Alex known before the send: nothing is posted", async () => {
    const { fake, worker } = await warm("a");
    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await windowOpened(fake);

    await teamsShows(fake, "b");
    const before = fake.sent.length;
    await clickSend(fake);

    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake)).toEqual([]);
    // The click itself refuses: not even a read goes out as Sam before the post would be refused.
    expect(fake.sent.slice(before)).toEqual([]);
  });

  it("cold start: with no switch, the click posts once, as Alex", async () => {
    const { fake, worker } = await cold();
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" }), "a");
    await windowOpened(fake);

    await clickSend(fake);

    await expect(result).resolves.toMatchObject({ sent: true, conversation: "Alpha launch" });
    expect(posts(fake).map(accountOf)).toEqual(["a"]);
  });

  it("cold start: a switch that lands during the lookups (Alex's list, then Sam): no window for Sam, nothing posted", async () => {
    const list = gate();
    const { fake, worker } = await cold(servicesWith({ csa: (r) => (accountOf(r) === "a" ? list.opened : undefined) }));
    // By id: a list read that a switch overtook doesn't stop the send, so the send goes on after it.
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ conversation: ALPHA, text: "Hi all" }), "a");
    await vi.waitFor(() => expect(fake.count("csa")).toBe(1));

    await teamsShows(fake, "b");
    list.open();

    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).resolves.toEqual({ sent: false, reason: expect.stringMatching(/account changed.*nothing was sent/) });
    expect(posts(fake)).toEqual([]);
  });

  it("an account Teams never showed (tokens that don't say who): refused before any window, nothing posted", async () => {
    const fake = createFakeChrome({ services: servicesWith() }); // opaque sessions, for nobody known
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();

    const result = worker.handlers.requestSend({ conversation: "Alpha launch", text: "Hi all" });
    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).rejects.toThrow(/hasn't shown who is signed in/);
    expect(posts(fake)).toEqual([]);
  });
});

describe("cold start: auto-send", () => {
  it("cold start: a note for Alex, with the switch to Sam as soon as Alex's session shows: no post without a window, and the click refuses", async () => {
    const lookup = gate();
    const { fake, worker } = await cold(servicesWith({ mt: () => lookup.opened }));
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.a.email] }), "a");
    // Before the fix the send stops at the address lookup; after it, at the window.
    await vi.waitFor(() => expect(fake.count("mt") + windows(fake)).toBeGreaterThan(0));

    await teamsShows(fake, "b");
    lookup.open();
    await answerOrWindow(fake, result);

    expect(posts(fake)).toEqual([]);
    expect(windows(fake)).toBe(1);
    await clickSend(fake);
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED });
    expect(posts(fake)).toEqual([]);
  });

  it("cold start: with no switch, a note for Alex still waits for the window, then posts once as Alex", async () => {
    const { fake, worker } = await cold();
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.a.email] }), "a");
    await answerOrWindow(fake, result);

    expect(posts(fake)).toEqual([]);
    expect(windows(fake)).toBe(1);
    await clickSend(fake);
    const r = await result;
    expect(r).toMatchObject({ sent: true });
    expect(r).not.toHaveProperty("autoSent");
    expect(r).not.toHaveProperty("note");
    expect(posts(fake).map(accountOf)).toEqual(["a"]);
  });

  it("cold start: to: my own address, with Alex shown just after the send read who is signed in: the window opens, and nothing is posted until the click", async () => {
    const { fake, worker } = await cold();
    const get = fake.chrome.storage.session.get;
    const read = get.getMockImplementation()!;
    // Teams shows Alex between the send's first read and whatever it reads next.
    get.mockImplementation(async (keys) => {
      const r = await read(keys);
      if (keys === "oid" && !fake.session.has("oid")) await teamsShows(fake, "a");
      return r;
    });

    const result = worker.handlers.requestSend({ to: [ACCOUNT.a.email], text: "Note", autoSendTo: [ACCOUNT.a.email] });
    await answerOrWindow(fake, result);

    expect(posts(fake)).toEqual([]);
    expect(windows(fake)).toBe(1);
    await clickSend(fake);
    const r = await result;
    expect(r).toMatchObject({ sent: true });
    expect(r).not.toHaveProperty("autoSent");
    expect(posts(fake).map((p) => [accountOf(p), decodeURIComponent(p.path)])).toEqual([["a", "/v1/users/ME/conversations/48:notes/messages"]]);
  });
});

describe("cold start: to:", () => {
  it("cold start: to: another person, with Teams showing Alex during the send's wait: the window opens for Alex, and the click posts once as Alex", async () => {
    const { fake, worker } = await cold();
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ to: [JAMIE.email], text: "Hi Jamie", autoSendTo: [ACCOUNT.a.email] }), "a");
    await windowOpened(fake);
    expect(posts(fake)).toEqual([]);

    await clickSend(fake);

    const r = await result;
    expect(r).toMatchObject({ sent: true, newChat: true });
    expect(r).not.toHaveProperty("autoSent");
    expect(messagePosts(fake).map(accountOf)).toEqual(["a"]);
    expect(posts(fake).map(accountOf)).toEqual(["a", "a"]); // the new chat, then the message
  });

  it("cold start: to: my own address with autoSendTo, with Teams showing Alex during the send's wait: the window opens, no post until the click", async () => {
    const { fake, worker } = await cold();
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ to: [ACCOUNT.a.email], text: "Note", autoSendTo: [ACCOUNT.a.email] }), "a");
    await answerOrWindow(fake, result);

    expect(posts(fake)).toEqual([]);
    expect(windows(fake)).toBe(1);
    await clickSend(fake);
    const r = await result;
    expect(r).toMatchObject({ sent: true });
    expect(r).not.toHaveProperty("autoSent");
    expect(posts(fake).map(accountOf)).toEqual(["a"]);
  });

  it("cold start: to:, with a switch from Alex to Sam while the send is prepared: no window, nothing posted", async () => {
    const list = gate();
    const { fake, worker } = await cold(servicesWith({ csa: (r) => (accountOf(r) === "a" ? list.opened : undefined) }));
    const { result } = await sendAsTeamsWakes(fake, () => worker.handlers.requestSend({ to: [JAMIE.email], text: "Hi Jamie" }), "a");
    await vi.waitFor(() => expect(fake.count("csa")).toBe(1));

    await teamsShows(fake, "b");
    list.open();

    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED_BEFORE });
    expect(posts(fake)).toEqual([]);
    expect(fake.count("substrate")).toBe(0); // nobody is looked up as Sam for a send that won't go
  });

  it("cold start: to:, with no account shown within the wait (tokens that don't say who): refused after looking, nothing posted", async () => {
    const fake = createFakeChrome({ services: servicesWith() }); // opaque sessions, for nobody known
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();

    const result = worker.handlers.requestSend({ to: [JAMIE.email], text: "Hi Jamie" });
    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).rejects.toThrow(/hasn't shown who is signed in/);
    expect(fake.count("csa")).toBeGreaterThan(0); // the session was waited for and used: it showed nobody
    expect(posts(fake)).toEqual([]);
  });
});

describe("auto-send's account recheck", () => {
  // Starting by conversation or by my own address: both end in the same recheck.
  const NOTE = [
    ["a conversation", { conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.a.email] }],
    ["to: my own address", { to: [ACCOUNT.a.email], text: "Note", autoSendTo: [ACCOUNT.a.email] }],
  ] as const;

  it.each(NOTE)("with no switch, %s posts once as Alex without a window", async (_, params) => {
    const { fake, worker } = await warm("a");
    await expect(worker.handlers.requestSend(params)).resolves.toMatchObject({ sent: true, autoSent: true });
    expect(posts(fake).map(accountOf)).toEqual(["a"]);
    expect(windows(fake)).toBe(0);
  });

  it.each(NOTE)("a switch during the address lookup (%s): refused before deciding, and nothing more goes to Teams", async (_, params) => {
    const lookup = gate();
    const { fake, worker } = await warm("a", servicesWith({ mt: () => lookup.opened }));
    const result = worker.handlers.requestSend(params);
    await vi.waitFor(() => expect(fake.count("mt")).toBe(1));

    await teamsShows(fake, "b");
    const switchedAt = fake.sent.length;
    lookup.open();

    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED_BEFORE });
    expect(windows(fake)).toBe(0);
    expect(fake.sent.slice(switchedAt)).toEqual([]); // not even Sam's name, for a post that won't go
  });

  it("a switch after the recheck, during the sender's name lookup: the post itself is refused", async () => {
    const name = gate();
    let lookups = 0;
    const { fake, worker } = await warm("a", servicesWith({ mt: () => (++lookups === 2 ? name.opened : undefined) }));
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.a.email] });
    await vi.waitFor(() => expect(lookups).toBe(2)); // my addresses, then my name

    await teamsShows(fake, "b");
    name.open();

    await expect(result).resolves.toEqual({ sent: false, autoSent: true, reason: CHANGED });
    expect(posts(fake)).toEqual([]);
    expect(windows(fake)).toBe(0);
  });
});

describe("warm: a switch during the lookups", () => {
  /** Holds the send's first request to the service (Alex's), so the switch lands while the send looks things up. */
  function holdFirst() {
    const lookup = gate();
    let reads = 0;
    return { lookup, hold: () => (++reads === 1 ? lookup.opened : undefined) };
  }

  // Which lookup the switch lands during: the chat list (csa), or my addresses (mt).
  const SENDS = [
    ["an auto-send", "csa", { conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.a.email, ACCOUNT.b.email] }],
    ["a window send", "csa", { conversation: ALPHA, text: "Hi all" }],
    ["an auto-send, to: my own address", "mt", { to: [ACCOUNT.a.email], text: "Note", autoSendTo: [ACCOUNT.a.email, ACCOUNT.b.email] }],
    ["a window send, to: someone else", "csa", { to: [JAMIE.email], text: "Hi Jamie" }],
  ] as const;

  it.each(SENDS)("Alex known, a switch to Sam and back to Alex during the lookups (%s): refused, no window, nothing posted", async (_, service, params) => {
    const { lookup, hold } = holdFirst();
    const { fake, worker } = await warm("a", servicesWith({ [service]: hold }));
    const result = worker.handlers.requestSend(params);
    await vi.waitFor(() => expect(fake.count(service)).toBe(1));

    await teamsShows(fake, "b");
    await teamsShows(fake, "a");
    lookup.open();

    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED_BEFORE });
    expect(posts(fake)).toEqual([]);
  });

  it("Alex known, a switch to Sam during the lookups, with Sam's address on autoSendTo: judged with Alex's addresses, never Sam's; refused, nothing posted", async () => {
    const { lookup, hold } = holdFirst();
    const { fake, worker } = await warm("a", servicesWith({ csa: hold }));
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [ACCOUNT.b.email] });
    await vi.waitFor(() => expect(fake.count("csa")).toBe(1));

    await teamsShows(fake, "b");
    lookup.open();

    await answerOrWindow(fake, result);
    expect(windows(fake)).toBe(0);
    await expect(result).resolves.toEqual({ sent: false, reason: CHANGED_BEFORE });
    expect(posts(fake)).toEqual([]);
    // The "only me" judgement is for Alex, the account the send started with: Sam's profile is never asked for.
    const asked = fake.sent.filter((r) => r.service === "mt").flatMap((r) => r.body as string[]);
    expect(asked).not.toContain(`8:orgid:${ACCOUNT.b.oid}`);
  });
});
