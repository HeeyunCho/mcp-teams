// #111: a server updated the extension's folder, but its reload never got through (the hub
// restarted while it asked, or its session ended first). The extension then ran its old code
// against the new files, without a connection, until someone reloaded it by hand. Now, on each
// reconnect alarm, it compares its folder on disk (manifest.json, read fresh) with what it runs
// and reloads itself into a newer version. The real worker runs under a fake chrome; its folder
// on disk is a stubbed fetch of chrome-extension://…/manifest.json.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, EXTENSION_VERSION, loadWorker, openedSockets, stopWorkers, type FakeChrome } from "../helpers/fakeChrome.js";

afterEach(() => {
  stopWorkers();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

const [major, minor, patch] = EXTENSION_VERSION.split(".").map(Number);
const NEWER = `${major}.${minor}.${patch + 1}`;
const OLDER = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`;

/** The extension's folder on disk holds `version` (or can't be read, with null). */
function folderHolds(version: string | null) {
  const fetch = vi.fn(async (url: string) => {
    if (url !== "chrome-extension://fake-extension-id/manifest.json" || version === null) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ manifest_version: 3, version }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function worker(fake: FakeChrome = createFakeChrome()) {
  const w = await loadWorker(fake);
  return { fake, w };
}

describe("the extension reloads itself into a newer version on disk (#111)", () => {
  it("reloads when the folder's manifest is newer than the running version, and remembers the try", async () => {
    folderHolds(NEWER);
    const { fake, w } = await worker();
    expect(await w.reloadIfUpdatedOnDisk(1_000)).toBe(true);
    expect(fake.spies.runtimeReload).toHaveBeenCalledTimes(1);
    expect(fake.local.get("selfUpdateTried")).toEqual({ version: NEWER, at: 1_000 });
  });

  it("does nothing when the folder holds the same or an older version, or can't be read", async () => {
    for (const version of [EXTENSION_VERSION, OLDER, "not-a-version", null]) {
      folderHolds(version);
      const { fake, w } = await worker();
      expect(await w.reloadIfUpdatedOnDisk()).toBe(false);
      expect(fake.spies.runtimeReload).not.toHaveBeenCalled();
    }
  });

  it("doesn't reload into the same version again for 10 minutes (a version Chrome can't load makes no reload loop)", async () => {
    folderHolds(NEWER);
    const fake = createFakeChrome({ local: { selfUpdateTried: { version: NEWER, at: 1_000 } } });
    const { w } = await worker(fake);
    expect(await w.reloadIfUpdatedOnDisk(1_000 + w.SELF_UPDATE_RETRY_MS - 1)).toBe(false);
    expect(fake.spies.runtimeReload).not.toHaveBeenCalled();
    expect(await w.reloadIfUpdatedOnDisk(1_000 + w.SELF_UPDATE_RETRY_MS)).toBe(true);
    expect(fake.spies.runtimeReload).toHaveBeenCalledTimes(1);
  });

  it("a version newer than the one tried last is reloaded into at once", async () => {
    folderHolds(`${major}.${minor}.${patch + 2}`);
    const fake = createFakeChrome({ local: { selfUpdateTried: { version: NEWER, at: 1_000 } } });
    const { w } = await worker(fake);
    expect(await w.reloadIfUpdatedOnDisk(1_001)).toBe(true);
  });

  it("waits while a send's confirmation window is open (a reload would close it)", async () => {
    folderHolds(NEWER);
    const { fake, w } = await worker();
    const send = w.dispatch(
      { type: "request", id: "s1", method: "requestSend", params: { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" }, timeoutMs: 60_000 },
      () => {},
    );
    await vi.waitFor(() => expect(w.pendingSendCount()).toBe(1));
    expect(await w.reloadIfUpdatedOnDisk()).toBe(false);
    expect(fake.spies.runtimeReload).not.toHaveBeenCalled();
    void send;
  });

  it("runs on the reconnect alarm", async () => {
    folderHolds(NEWER);
    const { fake, w } = await worker();
    w.registerListeners();
    for (const l of fake.chrome.alarms.onAlarm.listeners) l({ name: "reconnect" });
    await vi.waitFor(() => expect(fake.spies.runtimeReload).toHaveBeenCalledTimes(1));
  });
});
