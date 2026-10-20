#!/usr/bin/env node
// Bumps the version in package.json, package-lock.json and extension/manifest.json together.
//
//   node scripts/bump-version.mjs patch|minor|major     explicit bump
//   git log --format=%B%x00 A..B | node scripts/bump-version.mjs
//                                                      bump chosen from commit messages
//
// From commit messages (the biggest change wins):
//
//   change                                               before 1.0.0   from 1.0.0
//   "type!:" / "type(scope)!:" or a "BREAKING CHANGE:"
//     or "BREAKING-CHANGE:" footer line                  minor          major
//   "feat:" / "feat(scope):"                             patch          minor
//   anything else                                        patch          patch
//
// An explicit level is applied as given (`major` on 0.x makes 1.0.0). Prints the new version.
//
// Versions follow semver 2.0.0: MAJOR.MINOR.PATCH[-prerelease][+build], numeric parts without
// leading zeros. Anything else throws, so the workflow fails instead of committing a broken version.
// Build metadata is dropped. A bump from a prerelease releases it, as `npm version` / semver.inc do:
//
//   level   from X.Y.Z-pre                                 e.g.
//   patch   X.Y.Z                                          0.3.0-beta.1 -> 0.3.0
//   minor   X.Y.0 if Z is 0, else X.(Y+1).0                0.3.0-beta.1 -> 0.3.0, 0.3.1-beta.1 -> 0.4.0
//   major   X.0.0 if Y and Z are 0, else (X+1).0.0         2.0.0-alpha  -> 2.0.0, 1.2.3-rc.1   -> 2.0.0
//
// "Before 1.0.0" means below 1.0.0 in semver order, so every 0.x prerelease and 1.0.0-rc.1 count
// (feat: on 1.0.0-rc.1 is a patch bump and releases 1.0.0).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function bumpLevel(messages) {
  if (messages.some((m) => /^BREAKING[ -]CHANGE:/m.test(m) || /^\w+(\([^)]*\))?!:/.test(m.trim()))) return "major";
  if (messages.some((m) => /^feat(\([^)]*\))?:/.test(m.trim()))) return "minor";
  return "patch";
}

// semver.org 2.0.0 grammar: numeric parts without leading zeros, dot-separated prerelease and build identifiers.
const NUM = "0|[1-9]\\d*";
const PRE_ID = `${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*`;
const SEMVER = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-((?:${PRE_ID})(?:\\.(?:${PRE_ID}))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

function parse(version) {
  const m = SEMVER.exec(version);
  const [major, minor, patch] = [m?.[1], m?.[2], m?.[3]].map(Number);
  // Too large to count exactly (semver rejects these too).
  if (!m || ![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Invalid version "${version}": expected MAJOR.MINOR.PATCH[-prerelease][+build]`);
  }
  return { major, minor, patch, pre: m[4] };
}

// Chrome's manifest "version" takes integers up to 65535.
const MAX_PART = 65535;

export function increment(version, level) {
  const next = step(parse(version), level);
  if (next.split(".").some((n) => Number(n) > MAX_PART)) {
    throw new Error(`Bumping "${version}" gives ${next}, but extension/manifest.json takes version parts up to ${MAX_PART}.`);
  }
  return next;
}

function step({ major, minor, patch, pre }, level) {
  if (level === "major") return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
  if (level === "minor") return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
  if (pre) return `${major}.${minor}.${patch}`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Before 1.0.0 each kind of change moves one level down: breaking -> minor, feat -> patch. */
export function levelFor(version, level) {
  const { major, minor, patch, pre } = parse(version);
  const belowOne = major === 0 || (major === 1 && minor === 0 && patch === 0 && pre !== undefined);
  if (!belowOne) return level;
  return level === "major" ? "minor" : "patch";
}

export const nextVersion = (version, messages) => increment(version, levelFor(version, bumpLevel(messages)));

/**
 * Replaces the first `count` `field` fields in place, keeping the file's formatting. The value
 * pattern takes any string, so a prerelease or build-metadata version in the file is replaced too.
 */
function setVersion(file, version, count = 1, field = "version") {
  const path = join(ROOT, file);
  let left = count;
  const text = readFileSync(path, "utf8").replace(new RegExp(`"${field}":\\s*"[^"]*"`, "g"), (m) =>
    left-- > 0 ? `"${field}": "${version}"` : m,
  );
  writeFileSync(path, text);
}

async function main() {
  const level = process.argv[2];
  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  let next;
  if (["patch", "minor", "major"].includes(level)) {
    next = increment(current, level);
  } else {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    next = nextVersion(current, input.split("\0").filter((m) => m.trim()));
  }
  setVersion("package.json", next);
  setVersion("package-lock.json", next, 2); // root + packages[""]
  // A bump is always plain MAJOR.MINOR.PATCH, as Chrome's "version" needs; a prerelease label can only
  // be in "version_name", so one left from a hand-set prerelease is set to the release too.
  setVersion("extension/manifest.json", next);
  setVersion("extension/manifest.json", next, 1, "version_name");
  console.log(next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
