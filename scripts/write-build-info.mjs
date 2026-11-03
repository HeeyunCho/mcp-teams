#!/usr/bin/env node
// Writes dist/build.json after tsc: the version in package.json at build time and a build id, a hash of the
// built code (every dist/**/*.js, by path in sorted order). A rebuild that changes nothing gets the same id.
// A running server compares its own build id with the one on disk to tell that it needs a restart (#96).
//
//   node scripts/write-build-info.mjs   (run by npm run build)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".js"))
  .map((e) => relative(DIST, join(e.parentPath ?? e.path, e.name)).split(sep).join("/"))
  .sort();

const hash = createHash("sha256");
for (const file of files) hash.update(file).update("\0").update(readFileSync(join(DIST, file))).update("\0");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const info = { version, buildId: hash.digest("hex").slice(0, 12) };
writeFileSync(join(DIST, "build.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`dist/build.json: ${info.version} ${info.buildId}`);
