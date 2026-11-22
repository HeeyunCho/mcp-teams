/**
 * The browser extension as installed for Chrome/Edge: a fixed id, so the bridge can trust
 * it without pairing, and a fixed folder outside the package, which Chrome loads once
 * ("Load unpacked") and the server keeps up to date.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.js";

/**
 * The extension ids the server, the native host and setup trust as our extension (#216): the
 * sideloaded copy's, and each web store's once it is known. Every check that asks "is this our
 * extension?" goes through this list (isTrustedOrigin), and the native host manifest's
 * allowed_origins lists all of them (hostManifest in nativehost.ts).
 *
 * Adding a web store id is one line here. The ids come from the web store dashboards, assigned on the
 * first draft upload: the Chrome Web Store's from its Developer Dashboard (the item's id), Edge
 * Add-ons' from Partner Center (the extension's Store/CRX id). Don't guess one. After adding one,
 * run setup again on each computer: it rewrites the native host manifest's allowed_origins, and
 * until then Chrome or Edge refuses to start the native host for that id.
 * No environment variable or config file can add to this list.
 */
export const EXTENSION_IDS: Readonly<Record<string, string>> = Object.freeze({
  /** Chrome derives it from the manifest "key"; a test checks that they agree. */
  unpacked: "iolllncadcdlmihknnomfhcadbnnignl",
  // chromeWebStore: "<TODO(#216): the id from the Chrome Web Store dashboard after the first draft upload>",
  // edgeAddons: "<TODO(#216): the id from Partner Center after the first draft upload>",
});

/** The sideloaded ("Load unpacked") copy's id only: where "the unpacked copy" is meant (the key test, the legacy reload). */
export const EXTENSION_ID = EXTENSION_IDS.unpacked;
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** A trusted list of ids: the ids themselves, or a record of them like EXTENSION_IDS. */
export type ExtensionIds = Readonly<Record<string, string>> | readonly string[];

/** The trusted origins ("chrome-extension://<id>", no trailing slash) of a list of ids. */
export function trustedOrigins(ids: ExtensionIds = EXTENSION_IDS): string[] {
  return [...new Set(Object.values(ids))].map((id) => `chrome-extension://${id}`);
}

/**
 * Whether `origin` is one of our extension's: an exact match against the trusted list, after
 * dropping trailing slashes ("chrome-extension://<id>/", as Chrome passes it to a native host).
 * No prefix, substring, case-insensitive or wildcard match: the hub's origin check and the
 * bridge's "ours / another copy" rest on it.
 */
export function isTrustedOrigin(origin: unknown, ids: ExtensionIds = EXTENSION_IDS): origin is string {
  return typeof origin === "string" && trustedOrigins(ids).includes(origin.replace(/\/+$/, ""));
}

/**
 * The browsers where the sideloaded copy and a web store copy (another trusted id) are both connected
 * (#216). Both are served (they have different instances, so they look like two browsers), but one
 * browser needs only one: get_version and setup suggest removing the sideloaded one. Copies in
 * different browsers, or in two profiles of the same browser with the same id, aren't counted.
 */
export function browsersWithTwoCopies(extensions: readonly { origin?: string; browser?: string }[], ids: ExtensionIds = EXTENSION_IDS): string[] {
  const has = (browser: string | undefined, store: boolean) =>
    extensions.some((e) => e.browser === browser && isTrustedOrigin(e.origin, ids) && (e.origin !== EXTENSION_ORIGIN) === store);
  const browsers = new Set(extensions.map((e) => e.browser).filter((b): b is string => !!b));
  return [...browsers].filter((b) => has(b, false) && has(b, true));
}

/** What get_version and setup say about browsersWithTwoCopies (#216); null when there are none. */
export function twoCopiesNote(browsers: readonly string[]): string | null {
  if (!browsers.length) return null;
  return `Two copies of the mcp-teams extension are connected in ${browsers.join(" and ")}: the sideloaded one (Load unpacked) and one installed from a web store. Remove the sideloaded one on the browser's Extensions page.`;
}

/** The extension shipped with this package (next to dist/). */
export const PACKAGED_EXTENSION_DIR = fileURLToPath(new URL("../extension/", import.meta.url));
/** Where Chrome loads it from. */
export const INSTALLED_EXTENSION_DIR = join(CONFIG_DIR, "extension");
/** In the installed folder only: the pairing token, which the extension needs to prove itself to the server and check the server. */
export const PAIRING_FILE = "pairing.json";

/** An extension id from a manifest key: SHA-256 of the key, first 32 hex digits mapped to a–p. */
export function extensionIdFromKey(keyBase64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const filesIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => statSync(join(dir, f)).isFile())
        .map((f) => f.split("\\").join("/"))
    : [];

const sameFile = (a: string, b: string) => existsSync(b) && readFileSync(a).equals(readFileSync(b));

export const installedVersion = (dir = INSTALLED_EXTENSION_DIR): string | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
};

/**
 * Makes the installed folder match the packaged extension: copies new and changed files,
 * removes files the package no longer has. Files are replaced one by one, never the
 * folder, since Chrome keeps loading from it. Returns whether anything changed.
 */
export function syncExtension(from = PACKAGED_EXTENSION_DIR, to = INSTALLED_EXTENSION_DIR, copy: (src: string, dest: string) => void = copyFileSync): { changed: boolean; dir: string } {
  let changed = false;
  const wanted = new Set(filesIn(from));
  // manifest.json last: the extension reloads itself once the version in it is newer (#111),
  // so every other file must already be in place by then.
  const order = [...wanted].sort((a, b) => Number(a === "manifest.json") - Number(b === "manifest.json"));
  for (const file of order) {
    const target = join(to, file);
    if (sameFile(join(from, file), target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    copy(join(from, file), target);
    changed = true;
  }
  for (const file of filesIn(to)) {
    if (wanted.has(file) || file === PAIRING_FILE) continue;
    rmSync(join(to, file));
    changed = true;
  }
  return { changed, dir: to };
}

/**
 * Writes the pairing token into the installed extension folder (readable by this user only). Returns whether it changed.
 * With `nativeHost` (config.json, #123) it also says `"nativeHost": true`: only then does the
 * extension try the native host first. Off, the file is the token alone, as before.
 */
export function writePairing(token: string, dir = INSTALLED_EXTENSION_DIR, { nativeHost = false }: { nativeHost?: boolean } = {}): boolean {
  const file = join(dir, PAIRING_FILE);
  const text = `${JSON.stringify(nativeHost ? { token, nativeHost: true } : { token })}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync keeps the mode of a file that exists
  return true;
}
