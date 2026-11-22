// The api_traffic log (3.4, #19): the worker records the Teams tab's API calls only while the
// AI has turned recording on with api_traffic({ record: true }). Only the sideloaded copy's manifest (the
// repo's) requests the hosts it listens on (#218, #239), so these tests run it (trafficHosts: true).
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS extension module without types
import { EXTENSION_HOSTS } from "../../extension/teams.js";
import { createFakeChrome, loadWorker, openedSockets, type FakeChrome } from "../helpers/fakeChrome.js";
import { until } from "../helpers/timing.js";

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
    const fake = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsCalls(fake, "users/ME/fictionalSettings");
    await teamsCalls(fake, "teams/users/ME/fictionalList");
    const r = await worker.handlers.apiTraffic({}); // the log's queued updates have run by now
    worker.savePendingTraffic(); // a save that would run half a second later, now
    expect(r).toMatchObject({ recording: false, recorded: 0, requests: [] });
    expect(r.note).toMatch(/record: true/);
    expect(trafficWrites(fake)).toBe(0);
  });

  it("3.4: record: true starts recording, record: false stops it, and what was recorded stays until clear", async () => {
    const fake = createFakeChrome({ trafficHosts: true });
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
    const fake = createFakeChrome({ trafficHosts: true });
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
    const fake = createFakeChrome({ trafficHosts: true });
    const first = await loadWorker(fake);
    await first.handlers.apiTraffic({ record: true });
    await settle();
    // Chrome stops the worker and starts it again; chrome.storage.session is kept.
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await teamsCalls(fake, "users/ME/fictionalSettings");
    expect(await worker.handlers.apiTraffic({})).toMatchObject({ recording: true, recorded: 1 });
  });

  // The log is saved half a second after a change. The save goes to the browser the request was
  // recorded in, even once another fake chrome (the next test's) has taken its place.
  it("a pending save of the log goes to the storage of the browser it was recorded in, not to the next one's", async () => {
    const first = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(first);
    worker.registerListeners();
    await worker.handlers.apiTraffic({ record: true });
    await teamsCalls(first, "users/ME/fictionalSettings");
    await worker.handlers.apiTraffic({}); // the log's queued updates (the request and its status) have run
    const next = createFakeChrome({ trafficHosts: true });
    await loadWorker(next);
    // The save's timer fires about half a second later; until's 3 s leaves a busy machine room for that.
    await until(() => trafficWrites(first) > 0, 3_000, "the pending save of the log");
    expect((await first.chrome.storage.session.get("traffic")).traffic).toHaveLength(1);
    expect(await next.chrome.storage.session.get("traffic")).toEqual({});
  });
});

// #200: the Teams tab also opens WebSockets (trouter) and sends beacons (navigator.sendBeacon, Chrome's
// "ping" type). Chrome reports a request to a webRequest listener only if the filter's types include its
// type, and a WebSocket handshake under its wss:// URL, which an https:// pattern doesn't match.
describe("#200: the traffic log records the Teams tab's websocket and ping requests", () => {
  const SOCKET = "wss://go.trouter.teams.microsoft.com/v4/c";
  const BEACON = "https://teams.cloud.microsoft/api/fictional/beacon";

  it("a websocket and a ping from the Teams tab are recorded while recording is on, with their type", async () => {
    const fake = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await worker.handlers.apiTraffic({ record: true });
    await fake.fire("beforeSendHeaders", { url: SOCKET, type: "websocket" });
    await fake.fire("beforeSendHeaders", { url: BEACON, method: "POST", type: "ping" });
    const r = await worker.handlers.apiTraffic({});
    expect(r).toMatchObject({ recording: true, recorded: 2 });
    expect(r.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", host: "go.trouter.teams.microsoft.com", path: "/v4/c", type: "websocket" }),
        expect.objectContaining({ method: "POST", host: "teams.cloud.microsoft", path: "/api/fictional/beacon", type: "ping" }),
      ]),
    );
  });

  it("a websocket handshake's status (101) is recorded when Chrome reports it completed", async () => {
    const fake = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await worker.handlers.apiTraffic({ record: true });
    await fake.fire("beforeSendHeaders", { url: SOCKET, type: "websocket" });
    await fake.fire("completed", { url: SOCKET, type: "websocket", statusCode: 101 });
    expect((await worker.handlers.apiTraffic({})).requests).toEqual([expect.objectContaining({ host: "go.trouter.teams.microsoft.com", type: "websocket", status: 101 })]);
  });

  // The Teams-origin gate stays (#122): Outlook on the web's sockets and beacons are not Teams'.
  it("a websocket or ping from another origin is not recorded", async () => {
    const fake = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await worker.handlers.apiTraffic({ record: true });
    const initiator = "https://outlook.office.com";
    await fake.fire("beforeSendHeaders", { url: "wss://substrate.office.com/fictional/socket", type: "websocket", initiator });
    await fake.fire("beforeSendHeaders", { url: "https://outlook.office.com/fictional/beacon", method: "POST", type: "ping", initiator });
    expect(await worker.handlers.apiTraffic({})).toMatchObject({ recording: true, recorded: 0 });
  });
});

// #218 #239: the web store copy's manifest requests only the five Teams and SharePoint hosts, not the hosts the
// traffic log listens on, so api_traffic isn't available there: it says so, and the worker doesn't listen.
describe("#218: api_traffic without the traffic hosts (the web store copy)", () => {
  const SHIPPED_HOSTS: string[] = [...EXTENSION_HOSTS];
  /** Whether a listener's pattern lies within one of the shipped hosts (the host itself, or a path below it). */
  const withinShipped = (pattern: string) => SHIPPED_HOSTS.some((host) => pattern === host || pattern.startsWith(host.slice(0, -1)));

  it("api_traffic({ record: true }) answers that it isn't available in this build, and nothing records", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const answers: { ok: boolean; error?: string }[] = [];
    await worker.dispatch({ type: "request", id: "t1", method: "apiTraffic", params: { record: true }, timeoutMs: 10_000 }, (m: any) => answers.push(m));
    expect(answers).toHaveLength(1);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].error).toMatch(/api_traffic isn't available in this build/);
    expect(answers[0].error).toMatch(/host_permissions/);
    await teamsCalls(fake, "users/ME/fictionalSettings");
    worker.savePendingTraffic();
    expect(await fake.chrome.storage.session.get(["traffic", "trafficUntil"])).toEqual({});
  });

  it("the worker registers no webRequest listener on a host the manifest doesn't request", async () => {
    const fake = createFakeChrome();
    const worker = await loadWorker(fake);
    worker.registerListeners();
    expect(fake.webRequestUrls().length).toBeGreaterThan(0);
    expect(fake.webRequestUrls().filter((p: string) => !withinShipped(p))).toEqual([]);
  });

  it("with the traffic hosts added to the manifest (the sideloaded copy), it listens on them and records as before", async () => {
    const fake = createFakeChrome({ trafficHosts: true });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    expect(fake.webRequestUrls()).toEqual(expect.arrayContaining(["https://*.microsoft.com/*", "wss://*.microsoft.com/*"]));
    expect(await worker.handlers.apiTraffic({ record: true })).toMatchObject({ recording: true });
  });
});
