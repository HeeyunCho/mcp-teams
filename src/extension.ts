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

/** Chrome derives it from the manifest "key"; a test checks that they agree. */
export const EXTENSION_ID = "iolllncadcdlmihknnomfhcadbnnignl";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

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
export function syncExtension(from = PACKAGED_EXTENSION_DIR, to = INSTALLED_EXTENSION_DIR): { changed: boolean; dir: string } {
  let changed = false;
  const wanted = new Set(filesIn(from));
  for (const file of wanted) {
    const target = join(to, file);
    if (sameFile(join(from, file), target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(from, file), target);
    changed = true;
  }
  for (const file of filesIn(to)) {
    if (wanted.has(file) || file === PAIRING_FILE) continue;
    rmSync(join(to, file));
    changed = true;
  }
  return { changed, dir: to };
}

/** Writes the pairing token into the installed extension folder (readable by this user only). Returns whether it changed. */
export function writePairing(token: string, dir = INSTALLED_EXTENSION_DIR): boolean {
  const file = join(dir, PAIRING_FILE);
  const text = `${JSON.stringify({ token })}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync keeps the mode of a file that exists
  return true;
}
