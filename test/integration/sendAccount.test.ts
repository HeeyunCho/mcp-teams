// A send confirmed or judged as one account is never posted as another, also on a cold start:
// a send that begins before Teams has shown who is signed in (just after a browser start or an
// extension reload). The real worker (extension/background.js) under a fake chrome, with the
// account switching through Teams' own requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, TEAMS_ORIGIN, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

// Two fictional accounts in the same region: Alex Doe (a) and Sam Roe (b).
const ACCOUNT = {
  a: { oid: "00000000-0000-4000-8000-0000000000a1", name: "Alex Doe", email: "alex.doe@contoso.example" },
  b: { oid: "00000000-0000-4000-8000-0000000000b1", name: "Sam Roe", email: "sam.roe@fabrikam.example" },
};
type Account = keyof typeof ACCOUNT;
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
const CHANGED = "The signed-in Teams account changed since this was confirmed; nothing was sent.";

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

  it("cold start: to: my own address, with Alex shown just after the send read who is signed in: no post without a window", async () => {
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
    expect(windows(fake)).toBe(0);
    await expect(result).rejects.toThrow(/hasn't shown who is signed in/);
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

  it.each(NOTE)("a switch during the address lookup (%s): refused at the recheck, and nothing more goes to Teams", async (_, params) => {
    const lookup = gate();
    const { fake, worker } = await warm("a", servicesWith({ mt: () => lookup.opened }));
    const result = worker.handlers.requestSend(params);
    await vi.waitFor(() => expect(fake.count("mt")).toBe(1));

    await teamsShows(fake, "b");
    const switchedAt = fake.sent.length;
    lookup.open();

    await expect(result).resolves.toEqual({ sent: false, autoSent: true, reason: CHANGED });
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
