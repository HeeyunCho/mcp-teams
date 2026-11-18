#!/usr/bin/env node
/**
 * Packages extension/ as the zip to upload to the Chrome Web Store and Edge Add-ons (#216):
 *
 *   node scripts/package-extension.mjs [out.zip]     (default: artifacts/mcp-teams-extension-<version>.zip)
 *
 * - Only the files in ALLOWED go in. A file it doesn't name (and isn't in SOURCE_ONLY) stops it,
 *   so a new file is shipped, or left out, on purpose.
 * - pairing.json (the pairing token, written into the installed copy only) stops it.
 * - manifest.json goes in without "key". The key stays in the repo: it fixes the sideloaded copy's id
 *   (EXTENSION_IDS.unpacked in src/extension.ts), while each store assigns its own id and refuses
 *   an upload with a key it didn't issue.
 *
 * extension/ itself is never changed. The zip is written with Node alone (deflate, no dependency).
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

/** What the extension runs: the manifest, the service worker and its modules, the pages, the icons. */
export const ALLOWED = Object.freeze([
  "manifest.json",
  "background.js",
  "chunks.js",
  "features.js",
  "sizes.js",
  "teams.js",
  "confirm.html",
  "confirm.js",
  "popup.html",
  "popup.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
]);
/** In extension/ but not for the stores: the drawing the icons are rendered from (scripts/render-icons.sh). */
export const SOURCE_ONLY = Object.freeze(["icons/icon.svg"]);
const PAIRING_FILE = "pairing.json";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const filesIn = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1).split("\\").join("/"));

// ------------------------------------------------------------------ zip

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `entries` ([name, data]), deflated, with a fixed date (1980-01-01) so the same files give the same bytes. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date: 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ------------------------------------------------------------------ package

/** Writes the store zip of `from` to `out`; returns its path and the files in it. Throws, writing nothing, on pairing.json or a file not allowed. */
export function packageExtension({ from = join(ROOT, "extension"), out } = {}) {
  const src = resolve(from);
  const present = filesIn(src);
  if (present.includes(PAIRING_FILE)) throw new Error(`${join(src, PAIRING_FILE)} holds the pairing token and must never be packaged: remove it first.`);
  const unknown = present.filter((f) => !ALLOWED.includes(f) && !SOURCE_ONLY.includes(f));
  if (unknown.length) throw new Error(`Not in the allowlist of scripts/package-extension.mjs: ${unknown.join(", ")}. Add each to ALLOWED (shipped) or SOURCE_ONLY (not shipped).`);
  const missing = ALLOWED.filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`Missing from ${src}: ${missing.join(", ")}`);

  const { key: _key, ...manifest } = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  const entries = ALLOWED.map((f) => [f, f === "manifest.json" ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") : readFileSync(join(src, f))]);
  const file = resolve(out ?? join(ROOT, "artifacts", `mcp-teams-extension-${manifest.version}.zip`));
  mkdirSync(dirname(file), { recursive: true });
  // Written next to the target, then renamed: no half-written zip under the real name.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, zip(entries));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { file, files: [...ALLOWED] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { file, files } = packageExtension({ out: process.argv[2] });
    console.log(`${file}: ${files.length} files, manifest.json without "key"`);
  } catch (err) {
    console.error(`package-extension: ${err.message}`);
    process.exit(1);
  }
}
