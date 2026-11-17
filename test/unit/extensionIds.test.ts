// #216: one trusted list of extension ids (sideload, Chrome Web Store, Edge Add-ons). The hub's
// origin check (dist/hub.js) and the bridge's "ours / another copy" both ask isTrustedOrigin, so
// it must match exactly: no prefix, substring, case or wildcard match.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browsersWithTwoCopies, EXTENSION_ID, EXTENSION_IDS, isTrustedOrigin, trustedOrigins } from "../../src/extension.js";

// Fictional ids: 32 letters a–p, as Chrome's are.
const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
const IDS = { unpacked: EXTENSION_ID, chromeWebStore: STORE_ID };

describe("#216: the trusted extension ids", () => {
  it("#216: holds the sideload id, which the manifest key gives, and nothing but ids", () => {
    expect(EXTENSION_IDS.unpacked).toBe(EXTENSION_ID);
    for (const id of Object.values(EXTENSION_IDS)) expect(id).toMatch(/^[a-p]{32}$/);
  });

  it("#216: trusts a second id in the list, with or without Chrome's trailing slash", () => {
    expect(isTrustedOrigin(`chrome-extension://${STORE_ID}`, IDS)).toBe(true);
    expect(isTrustedOrigin(`chrome-extension://${STORE_ID}/`, IDS)).toBe(true);
    expect(isTrustedOrigin(`chrome-extension://${EXTENSION_ID}/`, IDS)).toBe(true);
    expect(trustedOrigins(IDS)).toEqual([`chrome-extension://${EXTENSION_ID}`, `chrome-extension://${STORE_ID}`]);
  });

  it("#216: still refuses an id that isn't in the list, and the store id when the list doesn't name it", () => {
    expect(isTrustedOrigin(`chrome-extension://${OTHER_ID}`, IDS)).toBe(false);
    expect(isTrustedOrigin(`chrome-extension://${STORE_ID}`, { unpacked: EXTENSION_ID })).toBe(false);
    expect(isTrustedOrigin(undefined, IDS)).toBe(false);
    expect(isTrustedOrigin("", IDS)).toBe(false);
  });

  it("#216: matches exactly: no prefix, substring, case, scheme or wildcard match", () => {
    const near = [
      `chrome-extension://${STORE_ID.slice(0, 31)}`, // a prefix of the id
      `chrome-extension://${STORE_ID}x`, // the id plus more
      `chrome-extension://${STORE_ID}/popup.html`, // a path after it
      `chrome-extension://${STORE_ID.toUpperCase()}`,
      `CHROME-EXTENSION://${STORE_ID}`,
      `extension://${STORE_ID}`,
      `moz-extension://${STORE_ID}`,
      `https://${STORE_ID}`,
      ` chrome-extension://${STORE_ID}`,
      `chrome-extension://${STORE_ID} `,
      `xchrome-extension://${STORE_ID}`,
      `chrome-extension://*`,
      `chrome-extension://`,
      STORE_ID,
    ];
    for (const origin of near) expect(isTrustedOrigin(origin, IDS), origin).toBe(false);
  });

  it("#216: finds the browsers where a store copy and the sideloaded copy are both connected", () => {
    const sideloaded = { origin: `chrome-extension://${EXTENSION_ID}`, browser: "Chrome" };
    const store = { origin: `chrome-extension://${STORE_ID}`, browser: "Chrome" };
    expect(browsersWithTwoCopies([sideloaded, store], IDS)).toEqual(["Chrome"]);
    // Different browsers (sideloaded in Chrome, store copy in Edge): one copy each, nothing to say.
    expect(browsersWithTwoCopies([sideloaded, { ...store, browser: "Edge" }], IDS)).toEqual([]);
    // Two profiles with the sideloaded copy, or one copy alone: nothing to say.
    expect(browsersWithTwoCopies([sideloaded, { ...sideloaded }], IDS)).toEqual([]);
    expect(browsersWithTwoCopies([store], IDS)).toEqual([]);
    // A copy whose id isn't trusted isn't "a store copy".
    expect(browsersWithTwoCopies([sideloaded, { origin: `chrome-extension://${OTHER_ID}`, browser: "Chrome" }], IDS)).toEqual([]);
    // With today's list (no store id yet) nothing is a second copy.
    expect(browsersWithTwoCopies([sideloaded, store])).toEqual([]);
  });

  it("#216: has no way in from the environment: src/extension.ts reads no process.env", () => {
    expect(readFileSync("src/extension.ts", "utf8")).not.toMatch(/process\.env/);
  });
});
