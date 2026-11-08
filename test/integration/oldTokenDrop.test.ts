// 77.2: a request Teams retries with the previous account's old token doesn't flip the extension
// back to that account. Within 30 s of a switch, a capture for the previous account whose token is
// older (`iat`) than the one that caused the switch is dropped: not stored, nothing cleared, no switch.
// The real worker (extension/background.js) under a fake chrome, the account showing through Teams' own requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, never, openedSockets, reply, TEAMS_ORIGIN, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";
import { fakeJwt } from "../helpers/jwt.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

// Three fictional accounts in the same region: Alex Doe, Sam Roe and Kim Poe.
const ACCOUNT = {
  alex: { oid: "00000000-0000-4000-8000-0000000000a1", chat: ["19:alpha@thread.v2", "Alpha launch"] },
  sam: { oid: "00000000-0000-4000-8000-0000000000b1", chat: ["19:beta@thread.v2", "Beta review"] },
  kim: { oid: "00000000-0000-4000-8000-0000000000c1", chat: ["19:gamma@thread.v2", "Gamma kickoff"] },
} as const;
type Account = keyof typeof ACCOUNT;

// When each token was issued (seconds since 1970): Alex's old token, then Sam's, which switches.
const ISSUED = 1_790_000_000;
const OLD = ISSUED;
const SWITCHING = ISSUED + 600;
const FRESH = ISSUED + 1200;

/** A bearer token for `t`, issued at `iat` (none: a token without `iat`). */
const bearer = (t: Account, iat?: number) => `Bearer ${fakeJwt({ oid: ACCOUNT[t].oid, ...(iat === undefined ? {} : { iat }) })}`;
/** The account whose token a request carried (its payload's oid). */
const accountOf = (req: SentRequest) => {
  const payload = String(req.headers.authorization ?? "").split(".")[1];
  const oid = payload ? JSON.parse(Buffer.from(payload, "base64url").toString()).oid : null;
  return (Object.keys(ACCOUNT) as Account[]).find((t) => ACCOUNT[t].oid === oid);
};

/** csa lists each account's own chat (whoever's token asks). */
const services = {
  csa: (req: SentRequest) => {
    const t = accountOf(req);
    return { teams: [], chats: t ? [{ id: ACCOUNT[t].chat[0], title: ACCOUNT[t].chat[1], chatType: "group" }] : [] };
  },
};

/** Teams in the tab makes a request to csa with this token, which the worker captures. */
const teamsSends = (fake: FakeChrome, token: string) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`, initiator: TEAMS_ORIGIN, requestHeaders: [{ name: "Authorization", value: token }] });

const csaReads = (fake: FakeChrome) => fake.count("csa");
const signedInAs = async (worker: Awaited<ReturnType<typeof loadWorker>>) => (await worker.handlers.status({})).signedInAs;
const chatsOf = async (worker: Awaited<ReturnType<typeof loadWorker>>) => (await worker.handlers.listChats({})).chats.map((c: { title: string }) => c.title);

/**
 * Alex signed in (old token), then Teams switches to Sam (`switching` token); Sam's chat list is
 * read and cached. Returns where the reads after the switch stand.
 */
async function switchedToSam(switching = bearer("sam", SWITCHING)) {
  const fake = createFakeChrome({ captured: [], services });
  fake.session.delete("oid");
  const worker = await loadWorker(fake);
  worker.registerListeners();
  await teamsSends(fake, bearer("alex", OLD));
  await teamsSends(fake, switching);
  expect(await chatsOf(worker)).toEqual(["Beta review"]);
  expect(await chatsOf(worker)).toEqual(["Beta review"]); // cached
  expect(csaReads(fake)).toBe(1);
  return { fake, worker };
}

/** The account the worker is signed in as now is `t`, its list read again (a switch) or not. */
async function expectSignedIn(fake: FakeChrome, worker: Awaited<ReturnType<typeof loadWorker>>, t: Account, { readAgain }: { readAgain: boolean }) {
  expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT[t].oid}`);
  expect(await chatsOf(worker)).toEqual([ACCOUNT[t].chat[1]]);
  expect(csaReads(fake)).toBe(readAgain ? 2 : 1);
}

describe("77.2: an old token of the previous account doesn't switch back", () => {
  it("77.2: within 30 s of the switch, Alex's older token is dropped: Sam stays signed in, his list stays cached, and the drop is counted", async () => {
    const { fake, worker } = await switchedToSam();
    expect((await worker.handlers.status({})).droppedOldCaptures).toEqual({ count: 0, lastAt: null });

    await teamsSends(fake, bearer("alex", OLD));

    await expectSignedIn(fake, worker, "sam", { readAgain: false });
    // Sam's session is the one used: the list read (cached) went out with Sam's token.
    expect(fake.sent.map(accountOf)).not.toContain("alex");
    const { droppedOldCaptures } = await worker.handlers.status({});
    expect(droppedOldCaptures.count).toBe(1);
    expect(Date.now() - Date.parse(droppedOldCaptures.lastAt)).toBeLessThan(5_000);
  });

  it("77.2: 31 s after the switch, Alex's older token switches back, as before", async () => {
    const { fake, worker } = await switchedToSam();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);

    await teamsSends(fake, bearer("alex", OLD));

    await expectSignedIn(fake, worker, "alex", { readAgain: true });
    expect((await worker.handlers.status({})).droppedOldCaptures.count).toBe(0);
  });

  it("77.2: exactly 30 s after the switch, Alex's older token switches back (the window is the 30 s before)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still unless set
    const switchedAt = Date.now();
    const { fake, worker } = await switchedToSam();
    vi.setSystemTime(switchedAt + 30_000);

    await teamsSends(fake, bearer("alex", OLD));

    await expectSignedIn(fake, worker, "alex", { readAgain: true });
    expect((await worker.handlers.status({})).droppedOldCaptures.count).toBe(0);
  });

  it("77.2: within 30 s, a newer token of Alex's (a real switch back) switches back", async () => {
    const { fake, worker } = await switchedToSam();

    await teamsSends(fake, bearer("alex", FRESH));

    await expectSignedIn(fake, worker, "alex", { readAgain: true });
    expect((await worker.handlers.status({})).droppedOldCaptures.count).toBe(0);
  });

  it("77.2: within 30 s, a third account (Kim), even with an older token, switches", async () => {
    const { fake, worker } = await switchedToSam();

    await teamsSends(fake, bearer("kim", OLD));

    await expectSignedIn(fake, worker, "kim", { readAgain: true });
    expect((await worker.handlers.status({})).droppedOldCaptures.count).toBe(0);
  });

  it("77.2: within 30 s, a token of Alex's without iat switches back", async () => {
    const { fake, worker } = await switchedToSam();

    await teamsSends(fake, bearer("alex"));

    await expectSignedIn(fake, worker, "alex", { readAgain: true });
  });

  it("77.2: a switch caused by a token without iat drops nothing: Alex's old token switches back", async () => {
    const { fake, worker } = await switchedToSam(bearer("sam"));

    await teamsSends(fake, bearer("alex", OLD));

    await expectSignedIn(fake, worker, "alex", { readAgain: true });
  });

  it("77.2: the rule survives a restart of the worker: the next worker drops Alex's older token too", async () => {
    const { fake } = await switchedToSam();
    fake.stopWorker();
    const next = await loadWorker(fake);
    next.registerListeners();
    expect(await chatsOf(next)).toEqual(["Beta review"]); // its own list cache starts empty
    const reads = csaReads(fake);

    await teamsSends(fake, bearer("alex", OLD));

    expect(await signedInAs(next)).toBe(`8:orgid:${ACCOUNT.sam.oid}`);
    expect(await chatsOf(next)).toEqual(["Beta review"]);
    expect(csaReads(fake)).toBe(reads); // still cached: nothing was cleared
    expect((await next.handlers.status({})).droppedOldCaptures.count).toBe(1);
  });
});

describe("77.2: a request is never sent again with the headers of an account that is no longer signed in", () => {
  const WAITED = /account changed while a request waited to be sent; it's now signed in as another account/;

  it("77.2: Teams switches to Sam while a read of Alex's waits out a 429: the read fails as account changed, and Alex's headers aren't sent again", async () => {
    let switched: Promise<unknown> | null = null;
    const fake: FakeChrome = createFakeChrome({
      captured: [],
      services: {
        csa: (req) => {
          if (switched) return services.csa(req);
          // Throttled; Teams switches to Sam while the read waits.
          switched = new Promise((r) => setTimeout(r, 100)).then(() => teamsSends(fake, bearer("sam", SWITCHING)));
          return reply(429, { message: "Too many requests" }, { headers: { "retry-after": "1" } });
        },
      },
    });
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsSends(fake, bearer("alex", OLD));

    await expect(worker.handlers.listChats({})).rejects.toThrow(WAITED);
    await switched;
    expect(fake.sent.map(accountOf)).toEqual(["alex"]); // the throttled one, never again
    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.sam.oid}`);
  });

  it("77.2: Teams switches to Sam and the tab closes under a read of Alex's: the read isn't sent again in the other tab, and fails as account changed", async () => {
    const fake = createFakeChrome({ captured: [], services: { csa: () => never() } });
    fake.tabs.push({ id: 2, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsSends(fake, bearer("alex", OLD));
    const read = worker.handlers.listChats({});
    await vi.waitFor(() => expect(csaReads(fake)).toBe(1));

    await teamsSends(fake, bearer("sam", SWITCHING));
    fake.closeTab(1);

    await expect(read).rejects.toThrow(WAITED);
    expect(fake.sent.map((r) => [accountOf(r), r.tabId])).toEqual([["alex", 1]]); // never again, in tab 2
  });

  it("77.2: the tab closes under a read of Alex's while Teams' switch to Sam is still being stored: the retry waits for that capture and fails as account changed", async () => {
    // Tab 1 never answers; tab 2 answers whoever's token asks, so a retry as Alex would succeed.
    const fake = createFakeChrome({ captured: [], services: { csa: (req) => (req.tabId === 1 ? never() : services.csa(req)) } });
    fake.tabs.push({ id: 2, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" });
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsSends(fake, bearer("alex", OLD));
    const read = worker.handlers.listChats({});
    await vi.waitFor(() => expect(csaReads(fake)).toBe(1));

    // Sam's capture is held at its first storage read, so it is still queued when the retry checks.
    const get = vi.mocked(fake.chrome.storage.session.get);
    const realGet = get.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding = true;
    get.mockImplementation(async (keys) => {
      if (holding && Array.isArray(keys) && keys.includes("accountSwitch")) {
        holding = false;
        await held;
      }
      return realGet(keys);
    });
    const switching = teamsSends(fake, bearer("sam", SWITCHING));
    fake.closeTab(1);
    // Only unblocks the capture: the outcome doesn't depend on when.
    setTimeout(release, 50);

    await expect(read).rejects.toThrow(WAITED);
    await switching;
    expect(fake.sent.map((r) => [accountOf(r), r.tabId])).toEqual([["alex", 1]]); // never again, in tab 2
    expect(await signedInAs(worker)).toBe(`8:orgid:${ACCOUNT.sam.oid}`);
  });

  it("77.2: Teams switches to Sam while a read of Alex's waits for the gate another read's 429 closed: its first send fails as account changed, and Alex's headers go out only once", async () => {
    let throttled = false;
    const fake = createFakeChrome({
      captured: [],
      services: {
        csa: (req) => {
          if (throttled) return services.csa(req);
          throttled = true;
          return reply(429, { message: "Too many requests" }, { headers: { "retry-after": "1" } });
        },
      },
    });
    fake.session.delete("oid");
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsSends(fake, bearer("alex", OLD));
    // The first read is throttled: the gate shuts for a second.
    const first = worker.handlers.listChats({});
    void first.catch(() => {});
    await vi.waitFor(() => expect(csaReads(fake)).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    // The second read, as Alex, waits behind the gate before its first send.
    const second = worker.handlers.listChats({ refresh: true });
    await new Promise((r) => setTimeout(r, 100));

    await teamsSends(fake, bearer("sam", SWITCHING));

    await expect(second).rejects.toThrow(WAITED);
    await expect(first).rejects.toThrow(WAITED);
    expect(fake.sent.map(accountOf)).toEqual(["alex"]); // only the throttled one
  });
});
