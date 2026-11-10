// #123 (ADR 0001): the real extension worker (extension/background.js, under a fake chrome) and the
// real native host (dist/hub.js), joined as Chrome joins them: connectNative starts the host, and
// messages pass in Chrome's framing. Servers join the host over the hub socket. Runs the built
// file (`npm run build` first).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN } from "../helpers/bridgeHarness.js";
import { createFakeChrome, loadWorker, NativeWebSocket, openedSockets, stopWorkers, type FakeChrome } from "../helpers/fakeChrome.js";
import { chromeNativeHost, nativeHarness } from "../helpers/nativeHost.js";
import { until } from "../helpers/timing.js";

let h: Awaited<ReturnType<typeof nativeHarness>> | undefined;
let hosts: ReturnType<typeof chromeNativeHost> | undefined;
afterEach(async () => {
  stopWorkers();
  await hosts?.kill();
  await h?.cleanup();
  h = hosts = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** A worker whose pairing.json turns the native host on, connected through dist/hub.js. */
async function nativeWorker(harness: NonNullable<typeof h>): Promise<FakeChrome> {
  hosts = chromeNativeHost(harness.home, harness.socket);
  const fake = createFakeChrome({ nativeHost: hosts.attach });
  const worker = await loadWorker(fake);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "chrome-extension://fake-extension-id/pairing.json") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ token: TOKEN, nativeHost: true }), { status: 200 });
    }),
  );
  worker.registerListeners();
  vi.stubGlobal("WebSocket", NativeWebSocket);
  for (const l of fake.chrome.runtime.onStartup.listeners) l();
  await vi.waitFor(async () => expect(await fake.pageMessage("popup.html", { type: "popup:status" })).toMatchObject({ state: "connected" }), { timeout: 8_000 });
  return fake;
}

describe("#123: the extension worker and the native host", { timeout: 30_000 }, () => {
  it("connect by native messaging; a server's calls reach the worker, one over 1 MB in chunks", async () => {
    h = await nativeHarness();
    const fake = await nativeWorker(h);
    expect(openedSockets).toEqual([]);
    const server = await h.server();
    await until(() => server.connected, 5_000, "the server sees the extension");
    expect(server.extension?.transport).toBe("native");
    await expect(server.call("status", {}, 5_000)).resolves.toEqual(expect.any(Object));
    const text = "Hallo Sam, 안녕하세요! ".repeat(80_000); // about 2 MB of UTF-8: the host splits it
    await expect(server.call("noSuchMethod", { text }, 10_000)).rejects.toThrow(/Unknown method noSuchMethod/);
    expect(fake.nativePorts).toHaveLength(1);
  });

  it("connect through a relaying host: the welcome proves the worker's own nonce", async () => {
    h = await nativeHarness();
    // Another browser's host serves; the worker's host relays to it.
    await h.host({ browser: "Edge", instance: "profile-2" });
    await nativeWorker(h);
    const server = await h.server();
    await until(() => server.extensions.length === 2, 5_000, "both browsers");
    expect(server.extensions.map((e) => e.transport)).toEqual(["native", "native"]);
  });
});
