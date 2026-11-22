// #218: probe (npm run probe) is a development aid that GETs any path of a Teams service or any
// SharePoint URL with the user's session. Any server or peer could call it like any handler, so the
// worker refuses it unless a developer turned it on by hand in the extension's own console
// (chrome.storage.local devProbe: true), which no server can set.
import { afterEach, describe, expect, it } from "vitest";
import { createFakeChrome, loadWorker, openedSockets, SHAREPOINT_ORIGIN, type FakeChrome } from "../helpers/fakeChrome.js";

afterEach(() => {
  openedSockets.length = 0;
});

/** The worker's answer to a probe sent as the bridge sends it. */
async function probe(fake: FakeChrome, params: object) {
  const worker = await loadWorker(fake);
  const answers: { ok: boolean; result?: any; error?: string }[] = [];
  await worker.dispatch({ type: "request", id: "p1", method: "probe", params, timeoutMs: 10_000 }, (m: any) => answers.push(m));
  expect(answers).toHaveLength(1);
  return answers[0];
}

const services = {
  csa: () => ({ fictional: "csa answer" }),
  sharepoint: () => ({ fictional: "sharepoint answer" }),
};
const SERVICE_PROBE = { service: "csa", path: "/api/v1/teams/users/me" };
const SHAREPOINT_PROBE = { url: `${SHAREPOINT_ORIGIN}/personal/alex_contoso_example/_api/web` };

describe("#218: probe is refused unless the developer flag is set", () => {
  it("without the flag, a service probe is refused with how to turn it on, and nothing is sent", async () => {
    const fake = createFakeChrome({ services });
    const answer = await probe(fake, SERVICE_PROBE);
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/probe is off/);
    expect(answer.error).toContain("chrome.storage.local.set({ devProbe: true })");
    expect(fake.sent).toEqual([]);
  });

  it("without the flag, a SharePoint probe is refused, and no SharePoint tab opens", async () => {
    const fake = createFakeChrome({ services });
    const answer = await probe(fake, SHAREPOINT_PROBE);
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/probe is off/);
    expect(fake.sent).toEqual([]);
    expect(fake.spies.tabsCreate).not.toHaveBeenCalled();
  });

  it("a flag that isn't exactly true (e.g. the string \"true\") doesn't turn it on", async () => {
    const fake = createFakeChrome({ services, local: { devProbe: "true" } });
    expect((await probe(fake, SERVICE_PROBE)).ok).toBe(false);
    expect(fake.sent).toEqual([]);
  });

  it("with the flag, a service probe and a SharePoint probe work as before", async () => {
    const fake = createFakeChrome({ services, local: { devProbe: true } });
    const answer = await probe(fake, SERVICE_PROBE);
    expect(answer).toMatchObject({ ok: true, result: { status: 200 } });
    expect(JSON.parse(answer.result.text)).toEqual({ fictional: "csa answer" });
    expect(fake.count("csa", /^\/api\/v1\/teams\/users\/me$/)).toBe(1);

    const sp = await probe(fake, SHAREPOINT_PROBE);
    expect(sp).toMatchObject({ ok: true, result: { status: 200 } });
    expect(JSON.parse(sp.result.text)).toEqual({ fictional: "sharepoint answer" });
  });
});
