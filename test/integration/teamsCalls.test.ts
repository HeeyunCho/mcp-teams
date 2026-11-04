// #103: the worker always keeps when the Teams tab last made a call, and when it last made a signed-in
// one (a bearer token), so get_version can tell a tab stuck at sign-in or asleep from a capture problem.
// Only the time and the host are kept, never a URL, header value or token.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, loadWorker, openedSockets, type FakeChrome } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.useRealTimers();
  openedSockets.length = 0;
});

/** The Teams tab calls `url`, with these request headers. */
const teamsCalls = (fake: FakeChrome, url: string, requestHeaders: { name: string; value: string }[] = []) =>
  fake.fire("beforeSendHeaders", { url, requestHeaders });

const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** Saved at most half a second after a change; wait past that. */
const settle = () => new Promise((r) => setTimeout(r, 800));

describe("#103: the Teams tab's last calls", () => {
  it("a tab that makes only calls without a bearer token has a last call, but no signed-in one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeChrome({ captured: [] });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    at("2026-10-01T10:25:58Z");
    await teamsCalls(fake, "https://go.trouter.teams.microsoft.com/v4/fictionalCheck");
    at("2026-10-01T10:26:37Z");
    await teamsCalls(fake, "https://teams.cloud.microsoft/diagnostics/network", [{ name: "Cookie", value: "fictional=1" }]);
    expect(await worker.handlers.status({})).toMatchObject({
      teamsTabs: 1,
      sessions: [{ sessionCaptured: false }],
      lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "teams.cloud.microsoft" },
      lastSignedInCall: null,
    });
  });

  it("a call with a bearer token is the last signed-in call, with recording off, and a restart of the worker keeps both", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeChrome({ captured: [] });
    const first = await loadWorker(fake);
    first.registerListeners();
    at("2026-10-01T10:00:00Z");
    await teamsCalls(fake, "https://teams.cloud.microsoft/api/csa/emea/api/v1/teams/users/me", [{ name: "Authorization", value: "Bearer fictional-token" }]);
    at("2026-10-01T10:00:05Z");
    await teamsCalls(fake, "https://config.teams.microsoft.com/config/v1/fictional");
    await settle();
    // Chrome stops the worker and starts it again; chrome.storage.session is kept.
    const worker = await loadWorker(fake);
    expect(await worker.handlers.status({})).toMatchObject({
      lastTeamsCall: { at: "2026-10-01T10:00:05.000Z", host: "config.teams.microsoft.com" },
      lastSignedInCall: { at: "2026-10-01T10:00:00.000Z", host: "teams.cloud.microsoft" },
    });
    expect((await first.handlers.apiTraffic({})).recorded).toBe(0);
  });

  it("only the times and hosts are stored: no URL, header value or token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeChrome({ captured: [] });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    at("2026-10-01T10:00:00Z");
    await teamsCalls(fake, "https://teams.cloud.microsoft/api/mt/emea/beta/users/fictional?secret=fictional-query", [
      { name: "Authorization", value: "Bearer fictional-token" },
    ]);
    await settle();
    expect(await fake.chrome.storage.session.get("teamsCalls")).toEqual({
      teamsCalls: {
        lastTeamsCall: { at: 1790848800000, host: "teams.cloud.microsoft" },
        lastSignedInCall: { at: 1790848800000, host: "teams.cloud.microsoft" },
      },
    });
  });

  it("a browser restart (a new chrome.storage.session) has no last calls", async () => {
    const worker = await loadWorker(createFakeChrome({ captured: [] }));
    expect(await worker.handlers.status({})).toMatchObject({ lastTeamsCall: null, lastSignedInCall: null });
  });
});
