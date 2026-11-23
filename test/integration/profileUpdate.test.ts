// #253: a copy of the extension that sees its profile's Teams account only after its welcome (a
// browser start, or a reload) names it then with {type:"profile"}. The hub records it, and its
// peers see it through ext-state, so get_version and setup group two copies by profile.
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHarness, TOKEN, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { keyedProfile } from "../helpers/profile.js";
import { until } from "../helpers/timing.js";

let h: BridgeHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

// Two accounts' values, as the extension works them out.
const HASHED = keyedProfile(TOKEN, "00000000-0000-4000-8000-000000000001");
const OTHER = keyedProfile(TOKEN, "00000000-0000-4000-8000-000000000002");

describe("#253: the profile named after the welcome", () => {
  it("#253: the hub records a profile sent after the welcome, a later one replaces it, and a peer sees it", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const peer = await h.session();
    const ext = await h.extension();
    await until(() => hub.extensions.length === 1 && peer.extensions.length === 1, 3_000, "the extension on both");
    expect(hub.extensions[0].profile).toBeUndefined();
    ext.ws.send(JSON.stringify({ type: "profile", profile: HASHED }));
    await until(() => hub.extensions[0]?.profile === HASHED, 2_000, "the profile on the hub");
    await until(() => peer.extensions[0]?.profile === HASHED, 2_000, "the profile on the peer");
    // Another account in that profile (a switch): the new value.
    ext.ws.send(JSON.stringify({ type: "profile", profile: OTHER }));
    await until(() => hub.extensions[0]?.profile === OTHER && peer.extensions[0]?.profile === OTHER, 2_000, "the new profile");
  });

  it("#253: a profile update that isn't a keyed hash's shape is ignored, and the connection stays", async () => {
    h = await bridgeHarness();
    const hub = await h.session();
    const ext = await h.extension();
    await until(() => hub.extensions.length === 1, 3_000, "the extension");
    ext.ws.send(JSON.stringify({ type: "profile", profile: HASHED }));
    await until(() => hub.extensions[0]?.profile === HASHED, 2_000, "the profile");
    for (const bad of ["00000000-0000-4000-8000-000000000001", "someone@contoso.example", 42, null]) ext.ws.send(JSON.stringify({ type: "profile", profile: bad }));
    // A request after them is answered: they were read (in order) and changed nothing.
    await expect(hub.call("status", {}, 2_000)).resolves.toEqual({ ok: true });
    expect(hub.extensions[0].profile).toBe(HASHED);
    expect(hub.connected).toBe(true);
  });
});
