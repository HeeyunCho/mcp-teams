#!/usr/bin/env node
// Bumps the version in package.json, package-lock.json and extension/manifest.json together.
//
//   node scripts/bump-version.mjs patch|minor|major     explicit bump
//   git log --format=%B%x00 A..B | node scripts/bump-version.mjs
//                                                      bump chosen from commit messages
//
// From commit messages: a "BREAKING CHANGE:" footer line or "type!:" -> major, "feat:" -> minor, else patch.
// Prints the new version.
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

export const nextVersion = (version, messages) => increment(version, bumpLevel(messages));

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
  const arg = process.argv[2];
  let level = arg;
  if (!["patch", "minor", "major"].includes(level)) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    level = bumpLevel(input.split("\0").filter((m) => m.trim()));
  }
  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const next = increment(current, level);
  setVersion("package.json", next);
  setVersion("package-lock.json", next, 2); // root + packages[""]
  setVersion("extension/manifest.json", next);
  console.log(next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
