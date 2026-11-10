// #122: only the Teams page's own requests are captured as Teams' sessions. A request to a Teams
// service from elsewhere (Outlook on the web searching substrate.office.com in the same Chrome, the
// browser, another extension) neither marks the stored session as sent again nor replaces it, as
// it already counts as no call of the Teams tab (recordRequest, #103).
// The real worker (extension/background.js) under a fake chrome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, TEAMS_ORIGIN, type FakeChrome } from "../helpers/fakeChrome.js";
import { fakeJwt } from "../helpers/jwt.js";

afterEach(() => {
  vi.useRealTimers();
  openedSockets.length = 0;
});

// Fictional accounts: Alex Doe (signed in to Teams) and Sam Roe.
const ALEX = "00000000-0000-4000-8000-0000000000a1";
const SAM = "00000000-0000-4000-8000-0000000000b1";
const OUTLOOK_ORIGIN = "https://outlook.office.com";

const bearer = (oid: string, iat: number) => [{ name: "Authorization", value: `Bearer ${fakeJwt({ oid, iat })}` }];
const TEAMS_TOKEN = bearer(ALEX, 1_790_000_000);

const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** A request to substrate from `initiator` (undefined: none, as the browser or another extension sends). */
const substrateRequest = (fake: FakeChrome, initiator: string | undefined, requestHeaders: { name: string; value: string }[]) =>
  fake.fire("beforeSendHeaders", { url: `${BASES.substrate}/search/api/v2/query`, initiator, requestHeaders });

type Capture = { headers: Record<string, string>; at: number; oid: string | null };
const storedSubstrate = async (fake: FakeChrome) => (await fake.chrome.storage.session.get("capture:substrate"))["capture:substrate"] as Capture;

/** Teams sends substrate (and chatsvc) at 15:26:46 as Alex; returns the worker and the stored substrate capture. */
async function teamsSentAt152646() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fake = createFakeChrome({ captured: [] });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  at("2026-11-10T15:26:46Z");
  await fake.fire("beforeSendHeaders", { url: `${BASES.substrate}/search/api/v1/suggestions`, initiator: TEAMS_ORIGIN, requestHeaders: TEAMS_TOKEN });
  await fake.fire("beforeSendHeaders", { url: `${BASES.chatsvc}/v1/users/ME/conversations`, initiator: TEAMS_ORIGIN, requestHeaders: TEAMS_TOKEN });
  const before = await storedSubstrate(fake);
  expect(before.headers).toEqual(expect.objectContaining({ authorization: TEAMS_TOKEN[0].value }));
  at("2026-11-10T15:41:43Z");
  return { fake, worker, before };
}

describe("#122: a session is captured only from the Teams page", () => {
  it("a request from Outlook with the same token leaves substrate's time and capture as Teams sent them", async () => {
    const { fake, worker, before } = await teamsSentAt152646();
    await substrateRequest(fake, OUTLOOK_ORIGIN, TEAMS_TOKEN);
    expect(await worker.handlers.status({})).toMatchObject({
      services: { substrate: "2026-11-10T15:26:46.000Z" },
      lastSignedInCall: { at: "2026-11-10T15:26:46.000Z" },
    });
    expect(await storedSubstrate(fake)).toEqual(before);
  });

  it("a request with no origin (the browser, another extension) leaves substrate's time and capture unchanged", async () => {
    const { fake, worker, before } = await teamsSentAt152646();
    await substrateRequest(fake, undefined, TEAMS_TOKEN);
    expect(await worker.handlers.status({})).toMatchObject({ services: { substrate: "2026-11-10T15:26:46.000Z" } });
    expect(await storedSubstrate(fake)).toEqual(before);
  });

  it("Outlook's own token (a different token of the same user) is not stored as substrate's session", async () => {
    const { fake, worker, before } = await teamsSentAt152646();
    await substrateRequest(fake, OUTLOOK_ORIGIN, bearer(ALEX, 1_790_000_600));
    expect(await worker.handlers.status({})).toMatchObject({ services: { substrate: "2026-11-10T15:26:46.000Z" } });
    expect(await storedSubstrate(fake)).toEqual(before);
  });

  it("an Outlook token of another user is no account switch: Teams' sessions and account stay", async () => {
    const { fake, worker, before } = await teamsSentAt152646();
    const account = () => fake.chrome.storage.session.get(["oid", "accountSwitch"]);
    const accountBefore = await account();
    expect(accountBefore).toHaveProperty("oid", ALEX);
    await substrateRequest(fake, OUTLOOK_ORIGIN, bearer(SAM, 1_790_000_600));
    expect(await worker.handlers.status({})).toMatchObject({
      services: { substrate: "2026-11-10T15:26:46.000Z", chatsvc: "2026-11-10T15:26:46.000Z" },
    });
    expect(await storedSubstrate(fake)).toEqual(before);
    expect(await account()).toEqual(accountBefore);
  });

  it("the Teams page sending the same session again marks it sent now, and a new Teams token replaces it", async () => {
    const { fake, worker } = await teamsSentAt152646();
    await substrateRequest(fake, TEAMS_ORIGIN, TEAMS_TOKEN);
    expect(await worker.handlers.status({})).toMatchObject({ services: { substrate: "2026-11-10T15:41:43.000Z" } });
    at("2026-11-10T15:45:00Z");
    const fresh = bearer(ALEX, 1_790_000_900);
    await fake.fire("beforeSendHeaders", { url: `${BASES.substrate}/search/api/v2/query`, initiator: "https://teams.microsoft.com", requestHeaders: fresh });
    expect(await worker.handlers.status({})).toMatchObject({ services: { substrate: "2026-11-10T15:45:00.000Z" } });
    expect((await storedSubstrate(fake)).headers).toEqual(expect.objectContaining({ authorization: fresh[0].value }));
  });
});
