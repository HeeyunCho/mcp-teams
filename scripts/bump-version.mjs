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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function bumpLevel(messages) {
  if (messages.some((m) => /^BREAKING[ -]CHANGE:/m.test(m) || /^\w+(\([^)]*\))?!:/.test(m.trim()))) return "major";
  if (messages.some((m) => /^feat(\([^)]*\))?:/.test(m.trim()))) return "minor";
  return "patch";
}

export function increment(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Before 1.0.0 each kind of change moves one level down: breaking -> minor, feat -> patch. */
export function levelFor(version, level) {
  if (Number(version.split(".")[0]) >= 1) return level;
  return level === "major" ? "minor" : "patch";
}

export const nextVersion = (version, messages) => increment(version, levelFor(version, bumpLevel(messages)));

/** Replaces the first `count` "version" fields in place, keeping the file's formatting. */
function setVersion(file, version, count = 1) {
  const path = join(ROOT, file);
  let left = count;
  const text = readFileSync(path, "utf8").replace(/"version":\s*"[^"]*"/g, (m) =>
    left-- > 0 ? `"version": "${version}"` : m,
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
  setVersion("extension/manifest.json", next);
  console.log(next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
