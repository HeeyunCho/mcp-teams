// #216: one trusted list of extension ids (sideload, Chrome Web Store, Edge Add-ons). The hub's
// origin check (dist/hub.js) and the bridge's "ours / another copy" both ask isTrustedOrigin, so
// it must match exactly: no prefix, substring, case or wildcard match.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browsersWithTwoCopies, EXTENSION_ID, EXTENSION_IDS, isTrustedOrigin, normalizeOrigin, trustedOrigins } from "../../src/extension.js";

// Fictional ids: 32 letters a–p, as Chrome's are.
const WEB_STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
const IDS = { unpacked: EXTENSION_ID, chromeWebStore: WEB_STORE_ID };

describe("#216: the trusted extension ids", () => {
  it("#216: holds the sideload id, which the manifest key gives, and nothing but ids", () => {
    expect(EXTENSION_IDS.unpacked).toBe(EXTENSION_ID);
    for (const id of Object.values(EXTENSION_IDS)) expect(id).toMatch(/^[a-p]{32}$/);
  });

  it("#216: trusts a second id in the list, with or without Chrome's trailing slash", () => {
    expect(isTrustedOrigin(`chrome-extension://${WEB_STORE_ID}`, IDS)).toBe(true);
    expect(isTrustedOrigin(`chrome-extension://${WEB_STORE_ID}/`, IDS)).toBe(true);
    expect(isTrustedOrigin(`chrome-extension://${EXTENSION_ID}/`, IDS)).toBe(true);
    expect(trustedOrigins(IDS)).toEqual([`chrome-extension://${EXTENSION_ID}`, `chrome-extension://${WEB_STORE_ID}`]);
  });

  it("#216: still refuses an id that isn't in the list, and the web store id when the list doesn't name it", () => {
    expect(isTrustedOrigin(`chrome-extension://${OTHER_ID}`, IDS)).toBe(false);
    expect(isTrustedOrigin(`chrome-extension://${WEB_STORE_ID}`, { unpacked: EXTENSION_ID })).toBe(false);
    expect(isTrustedOrigin(undefined, IDS)).toBe(false);
    expect(isTrustedOrigin("", IDS)).toBe(false);
  });

  it("#216: matches exactly: no prefix, substring, case, scheme or wildcard match", () => {
    const near = [
      `chrome-extension://${WEB_STORE_ID.slice(0, 31)}`, // a prefix of the id
      `chrome-extension://${WEB_STORE_ID}x`, // the id plus more
      `chrome-extension://${WEB_STORE_ID}/popup.html`, // a path after it
      `chrome-extension://${WEB_STORE_ID.toUpperCase()}`,
      `CHROME-EXTENSION://${WEB_STORE_ID}`,
      `extension://${WEB_STORE_ID}`,
      `moz-extension://${WEB_STORE_ID}`,
      `https://${WEB_STORE_ID}`,
      ` chrome-extension://${WEB_STORE_ID}`,
      `chrome-extension://${WEB_STORE_ID} `,
      `xchrome-extension://${WEB_STORE_ID}`,
      `chrome-extension://*`,
      `chrome-extension://`,
      WEB_STORE_ID,
    ];
    for (const origin of near) expect(isTrustedOrigin(origin, IDS), origin).toBe(false);
  });

  it("#216: finds the browsers where a web store copy and the sideloaded copy are both connected", () => {
    const sideloaded = { origin: `chrome-extension://${EXTENSION_ID}`, browser: "Chrome" };
    const webStore = { origin: `chrome-extension://${WEB_STORE_ID}`, browser: "Chrome" };
    expect(browsersWithTwoCopies([sideloaded, webStore], IDS)).toEqual(["Chrome"]);
    // Different browsers (sideloaded in Chrome, web store copy in Edge): one copy each, nothing to say.
    expect(browsersWithTwoCopies([sideloaded, { ...webStore, browser: "Edge" }], IDS)).toEqual([]);
    // Two profiles with the sideloaded copy, or one copy alone: nothing to say.
    expect(browsersWithTwoCopies([sideloaded, { ...sideloaded }], IDS)).toEqual([]);
    expect(browsersWithTwoCopies([webStore], IDS)).toEqual([]);
    // A copy whose id isn't trusted isn't "a web store copy".
    expect(browsersWithTwoCopies([sideloaded, { origin: `chrome-extension://${OTHER_ID}`, browser: "Chrome" }], IDS)).toEqual([]);
    // With today's list (no web store id yet) nothing is a second copy.
    expect(browsersWithTwoCopies([sideloaded, webStore])).toEqual([]);
  });

  it("#253: groups the two copies by profile when both name one, and by browser when one doesn't", () => {
    const sideloaded = { origin: `chrome-extension://${EXTENSION_ID}`, browser: "Chrome" };
    const webStore = { origin: `chrome-extension://${WEB_STORE_ID}`, browser: "Chrome" };
    // Both copies in one profile: the note.
    expect(browsersWithTwoCopies([{ ...sideloaded, profile: "p1" }, { ...webStore, profile: "p1" }], IDS)).toEqual(["Chrome"]);
    // One copy in each of two profiles of Chrome: both are wanted, nothing to say.
    expect(browsersWithTwoCopies([{ ...sideloaded, profile: "p1" }, { ...webStore, profile: "p2" }], IDS)).toEqual([]);
    // One or both from an extension that doesn't send it: per browser, as before.
    expect(browsersWithTwoCopies([{ ...sideloaded, profile: "p1" }, webStore], IDS)).toEqual(["Chrome"]);
    expect(browsersWithTwoCopies([sideloaded, { ...webStore, profile: "p2" }], IDS)).toEqual(["Chrome"]);
    expect(browsersWithTwoCopies([sideloaded, webStore], IDS)).toEqual(["Chrome"]);
    // A profile value is no reason to pair copies across browsers.
    expect(browsersWithTwoCopies([{ ...sideloaded, profile: "p1" }, { ...webStore, browser: "Edge", profile: "p1" }], IDS)).toEqual([]);
    // Three copies: the web store copy in the sideloaded one's profile counts, another profile's doesn't hide it.
    expect(browsersWithTwoCopies([{ ...sideloaded, profile: "p1" }, { ...webStore, profile: "p2" }, { ...webStore, profile: "p1" }], IDS)).toEqual(["Chrome"]);
  });

  it("#245: drops trailing slashes from an origin, as Chrome passes it to a native host", () => {
    expect(normalizeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop/")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(normalizeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop//")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(normalizeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(normalizeOrigin("")).toBe("");
  });

  it("#216: has no way in from the environment: src/extension.ts reads no process.env", () => {
    expect(readFileSync("src/extension.ts", "utf8")).not.toMatch(/process\.env/);
  });
});
