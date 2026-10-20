// The api_traffic log (3.4, #19): the worker records the Teams tab's API calls only while the
// AI has turned recording on with api_traffic({ record: true }).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, loadWorker, openedSockets, type FakeChrome } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.useRealTimers();
  openedSockets.length = 0;
});

/** The Teams tab calls an mt endpoint, and Chrome reports the request and its answer. */
async function teamsCalls(fake: FakeChrome, path: string) {
  const url = `https://teams.cloud.microsoft/api/mt/emea/beta/${path}`;
  await fake.fire("beforeSendHeaders", { url, requestHeaders: [{ name: "Authorization", value: "Bearer fictional" }] });
  await fake.fire("completed", { url, statusCode: 200 });
}

/** The log is saved half a second after the last change; wait past that. */
const settle = () => new Promise((r) => setTimeout(r, 800));

const trafficWrites = (fake: FakeChrome) => fake.chrome.storage.session.set.mock.calls.filter(([items]: [Record<string, unknown>]) => "traffic" in items).length;

describe("3.4: the traffic log records only while api_traffic turned it on", () => {
  it("3.4: before api_traffic turns recording on, Teams' calls are neither recorded nor written to storage", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsCalls(fake, "users/ME/fictionalSettings");
    await teamsCalls(fake, "teams/users/ME/fictionalList");
    await settle();
    const r = await worker.handlers.apiTraffic({});
    await settle();
    expect(r).toMatchObject({ recording: false, recorded: 0, requests: [] });
    expect(r.note).toMatch(/record: true/);
    expect(trafficWrites(fake)).toBe(0);
  });

  it("3.4: record: true starts recording, record: false stops it, and what was recorded stays until clear", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    expect(await worker.handlers.apiTraffic({ record: true })).toMatchObject({ recording: true, recorded: 0 });
    await teamsCalls(fake, "users/ME/fictionalSettings");
    const on = await worker.handlers.apiTraffic({});
    expect(on).toMatchObject({ recording: true, recorded: 1 });
    expect(on.requests[0]).toMatchObject({ host: "teams.cloud.microsoft", status: 200 });

    expect(await worker.handlers.apiTraffic({ record: false })).toMatchObject({ recording: false, recorded: 1 });
    await teamsCalls(fake, "teams/users/ME/fictionalList");
    expect(await worker.handlers.apiTraffic({ clear: true })).toMatchObject({ recording: false, recorded: 1 });
    expect(await worker.handlers.apiTraffic({})).toMatchObject({ recording: false, recorded: 0 });
  });

  it("3.4: recording stops by itself 30 minutes after it was turned on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const r = await worker.handlers.apiTraffic({ record: true });
    expect(r.recordingUntil).toBe("2026-10-01T10:30:00.000Z");
    await teamsCalls(fake, "users/ME/fictionalSettings");
    vi.setSystemTime(new Date("2026-10-01T10:30:01Z"));
    await teamsCalls(fake, "teams/users/ME/fictionalList");
    expect(await worker.handlers.apiTraffic({})).toMatchObject({ recording: false, recorded: 1 });
  });

  it("3.4: recording that was turned on survives a restart of the service worker", async () => {
    const fake = createFakeChrome();
    const first = await loadWorker(fake);
    await first.handlers.apiTraffic({ record: true });
    await settle();
    // Chrome stops the worker and starts it again; chrome.storage.session is kept.
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsCalls(fake, "users/ME/fictionalSettings");
    expect(await worker.handlers.apiTraffic({})).toMatchObject({ recording: true, recorded: 1 });
  });
});
