#!/usr/bin/env node
// Writes dist/build.json after tsc: the version in package.json at build time and a build id, a hash of the
// code this server runs and ships: every dist/**/*.js and every file under extension/ (which the server copies
// to the installed extension), by path in sorted order. A rebuild that changes nothing gets the same id, and so
// does a release that changed only the extension get a new one (#100). A running server compares its own build
// id with the one on disk to tell that it needs a restart (#96).
//
// The same files give the same id on every platform: paths are taken from the repo root with "/", sorted as
// strings, and text files are hashed with LF line ends (git on Windows may check them out with CRLF). Left out:
// extension/pairing.json, which only the installed copy has (one per install, written by the server).
//
//   node scripts/write-build-info.mjs   (run by npm run build)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const EXTENSION = join(ROOT, "extension");

/** Text files, hashed with LF line ends; any other file is hashed as it is. */
const TEXT = /\.(js|mjs|json|html|css|svg|txt|md)$/i;

/** Every file under `dir` (if it exists) that `keep` keeps, as a path from the repo root with "/". */
const filesUnder = (dir, keep) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(ROOT, join(e.parentPath ?? e.path, e.name)).split(sep).join("/"))
        .filter(keep)
    : [];

const files = [
  ...filesUnder(DIST, (f) => f.endsWith(".js")),
  ...filesUnder(EXTENSION, (f) => f !== "extension/pairing.json"),
].sort();

const content = (file) => {
  const bytes = readFileSync(join(ROOT, file));
  return TEXT.test(file) ? Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : bytes;
};

const hash = createHash("sha256");
for (const file of files) hash.update(file).update("\0").update(content(file)).update("\0");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const info = { version, buildId: hash.digest("hex").slice(0, 12) };
writeFileSync(join(DIST, "build.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`dist/build.json: ${info.version} ${info.buildId}`);
