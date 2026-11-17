#!/usr/bin/env node
// Bumps the two version lines (#219): the package's, in package.json and package-lock.json, on every
// release, and the extension's, in extension/manifest.json ("version" and "version_name"), only when
// files under extension/ changed since the extension's own tag. All three files are read and checked
// first; if any is missing, not valid JSON or lacks the "version" fields to update, none is written.
// The writes are all or nothing: if one fails, every file is left as it was.
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
// An explicit level is applied as given (`major` on 0.x makes 1.0.0), to the extension too when it
// changed. Prints `version=X.Y.Z` and `extension=X.Y.Z` (empty when the extension didn't move).
//
// The extension's level comes from the messages of the commits since its tag ("ext-vX.Y.Z") that
// touched extension/; a change to manifest.json's version fields alone doesn't count. A current
// extension version without its tag yet is released as it is (the first release of 1.0.0).
//
// A version whose tag ("vX.Y.Z", or "ext-vX.Y.Z" for the extension) already exists in the repository
// moves on by patches to the first free one, so a tag left by a failed release can't block the next.
// If the tags or the extension's changes can't be read, it throws and writes nothing.
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
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** `version`, or the first patch after it whose tag (`prefix` and the version) isn't in `tags`. */
export function nextFreeVersion(version, tags, prefix = "v") {
  const taken = new Set(tags);
  let free = version;
  while (taken.has(`${prefix}${free}`)) free = increment(free, "patch");
  return free;
}

/** The tag prefix of each version line (#219): the package's "vX.Y.Z", the extension's "ext-vX.Y.Z". */
export const TAG_PREFIX = Object.freeze({ package: "v", extension: "ext-v" });

const runGit = (root, args, what) => {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    throw new Error(`Cannot ${what} in ${root}: ${e.message}`);
  }
};

/** The tags of the git repository at `root`. Throws if git can't list them. */
function gitTags(root) {
  return runGit(root, ["tag", "--list"], "list the git tags").split(/\r?\n/).filter(Boolean);
}

/** A manifest's text without its version fields, to tell a version-only change from a real one; null if it isn't JSON. */
function withoutVersion(text) {
  try {
    const { version, version_name, ...rest } = JSON.parse(text);
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

/**
 * The commit messages of the extension's changes since its tag `tag` (the CLI's `readExtension`): none when no
 * file under extension/ differs between the tag and HEAD, except manifest.json's version fields (a release
 * commit). Otherwise the messages of the commits since the tag that touched extension/. Throws if git fails.
 */
function gitExtensionChanges(root, tag) {
  const changed = runGit(root, ["diff", "--name-only", tag, "HEAD", "--", "extension"], "compare extension/ with its tag")
    .split(/\r?\n/)
    .filter(Boolean);
  const manifest = "extension/manifest.json";
  const real = changed.some((f) => f !== manifest) ||
    (changed.includes(manifest) &&
      withoutVersion(runGit(root, ["show", `${tag}:${manifest}`], "read the tagged manifest")) !== withoutVersion(runGit(root, ["show", `HEAD:${manifest}`], "read the manifest")));
  if (!real) return [];
  return runGit(root, ["log", "--format=%B%x00", `${tag}..HEAD`, "--", "extension"], "read the extension's commits").split("\0").filter((m) => m.trim());
}

/**
 * Replaces the first `count` `field` fields in a file's text, keeping its formatting. The value
 * pattern takes any string, so a prerelease or build-metadata version in the file is replaced too.
 * Throws, naming the file, if it has fewer than `count` such fields, unless the field is `optional`.
 */
function setVersion(file, text, version, count = 1, field = "version", optional = false) {
  let left = count;
  const out = text.replace(new RegExp(`"${field}":\\s*"[^"]*"`, "g"), (m) => (left-- > 0 ? `"${field}": "${version}"` : m));
  if (left > 0 && !optional) throw new Error(`${file} has fewer than ${count} "${field}" field(s) to update.`);
  return out;
}

/** Reads a version file under `root` and checks it is JSON, throwing an error that names the file. */
function readJson(root, file) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

/**
 * Writes `{ file, text, original }` entries under `root` all or nothing: each text goes to a temp file next
 * to its target, with the target's mode, then the temps are renamed over the targets. If a step fails,
 * targets already replaced get their `original` text back the same way (written to their temp, whose
 * name is free again once renamed, then renamed over the target), so a restore that fails leaves the
 * target holding the new text whole rather than half a file. Then every temp file is removed and the
 * error is rethrown. If some of that cleanup fails too, it throws an error naming what is left, with
 * the first error as its `cause`. `fs` is for tests.
 */
export function writeAll(root, writes, fs = { chmodSync, renameSync, rmSync, statSync, writeFileSync }) {
  const temps = writes.map(({ file }) => join(root, `${file}.bump-${process.pid}.tmp`));
  /** Writes `text` to `temp` with `file`'s mode, ready to be renamed over `file`. */
  const stage = (file, temp, text) => {
    fs.writeFileSync(temp, text);
    fs.chmodSync(temp, fs.statSync(join(root, file)).mode & 0o7777);
  };
  let renamed = 0;
  try {
    writes.forEach(({ file, text }, i) => stage(file, temps[i], text));
    for (; renamed < writes.length; renamed++) fs.renameSync(temps[renamed], join(root, writes[renamed].file));
  } catch (e) {
    const left = [];
    const attempt = (what, step) => {
      try {
        step();
      } catch {
        left.push(what);
      }
    };
    for (let i = 0; i < renamed; i++) {
      const { file, original } = writes[i];
      attempt(`could not restore ${file}`, () => {
        stage(file, temps[i], original);
        fs.renameSync(temps[i], join(root, file));
      });
    }
    for (const temp of temps) attempt(`could not remove ${temp}`, () => fs.rmSync(temp, { force: true }));
    if (left.length) throw new Error(`${e.message}; then ${left.join("; ")}`, { cause: e });
    throw e;
  }
}

/** Formats a test sample (see `sample` below) as pretty-printed JSON. Bumps never use it: `update` edits text in place. */
const sampleJson = (value) => JSON.stringify(value, null, 2);

/**
 * The version files, each with its version line (#219) and how its new text is made from the old. package.json
 * must stay first, and the extension's manifest.json is the extension line's only file (see bumpFiles).
 * `sample` is for tests: a minimal file holding `version` in every field `update` must replace.
 */
const VERSION_FILES = [
  { file: "package.json", line: "package", update: setVersion, sample: (version) => sampleJson({ name: "x", version }) },
  {
    file: "package-lock.json",
    line: "package",
    update: (file, text, next) => setVersion(file, text, next, 2), // root + packages[""]
    // Also holds a dependency's version, which the update must leave alone.
    sample: (version) => sampleJson({ name: "x", version, packages: { "": { version }, "node_modules/y": { version: "9.9.9" } } }),
  },
  // A bump is always plain MAJOR.MINOR.PATCH, as Chrome's "version" needs; a prerelease label can only
  // be in "version_name", so one left from a hand-set prerelease is set to the release too.
  {
    file: "extension/manifest.json",
    line: "extension",
    update: (file, text, next) => setVersion(file, setVersion(file, text, next), next, 1, "version_name", true),
    sample: (version) => sampleJson({ version }),
  },
];

/** The version files' paths from the root, in table order (package.json first). */
export const VERSION_FILE_NAMES = VERSION_FILES.map((f) => f.file);

/** Each version file's `sample`, keyed by path, in table order. For tests. */
export const VERSION_SAMPLES = Object.fromEntries(VERSION_FILES.map((f) => [f.file, f.sample]));

/**
 * Bumps the version files under `root`, each version line on its own (#219), and returns
 * `{ version, extension }`: the package's new version, and the extension's, or null when it didn't move.
 *
 * - The package line (package.json, package-lock.json) moves on every bump: by `level` if it is patch, minor or
 *   major, else from the commit messages in the string `readInput()` resolves to, NUL-separated (called only then),
 *   past any "v" tag in the list `readTags()` resolves to.
 * - The extension line (extension/manifest.json) moves only when the extension changed since its own tag,
 *   "ext-v" and its current version: `readExtension(tag)` resolves to the messages of those changes (none: it
 *   didn't change, and the manifest is left untouched). It moves by `level` if given, else by those messages, past
 *   any "ext-v" tag. A current version without its tag yet is released as it is, so it never goes down.
 *
 * What the CLI runs, with the repository root, stdin and git; tests call it on a temporary root, in-process.
 */
export async function bumpFiles(root, level, readInput, readTags, readExtension = async () => []) {
  const files = VERSION_FILES.map((f) => ({ ...f, ...readJson(root, f.file) }));
  const explicit = ["patch", "minor", "major"].includes(level);
  const current = files[0].json.version; // package.json, the first entry, holds the current version
  let next;
  if (explicit) {
    next = increment(current, level);
  } else {
    const input = await readInput();
    next = nextVersion(current, input.split("\0").filter((m) => m.trim()));
  }
  const tags = await readTags();
  next = nextFreeVersion(next, tags, TAG_PREFIX.package);

  const manifest = files.find((f) => f.line === "extension");
  const extCurrent = manifest.json.version;
  if (typeof extCurrent !== "string") throw new Error(`${manifest.file} has no "version" field to update.`);
  parse(extCurrent); // throws on an invalid version before anything is written
  let extension = null;
  if (!tags.includes(`${TAG_PREFIX.extension}${extCurrent}`)) {
    extension = extCurrent;
  } else {
    const changes = await readExtension(`${TAG_PREFIX.extension}${extCurrent}`);
    if (changes.length) extension = nextFreeVersion(explicit ? increment(extCurrent, level) : nextVersion(extCurrent, changes), tags, TAG_PREFIX.extension);
  }

  const versionOf = { package: next, extension };
  const writes = files.filter(({ line }) => versionOf[line] !== null);
  writeAll(root, writes.map(({ file, text, update, line }) => ({ file, text: update(file, text, versionOf[line]), original: text })));
  return { version: next, extension };
}

/** Reads all of stdin as one string (the CLI's `readInput`). */
async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/** Prints `version=X.Y.Z` and `extension=X.Y.Z` (empty when the extension didn't move), as the workflow's step outputs. */
async function main() {
  const { version, extension } = await bumpFiles(ROOT, process.argv[2], readStdin, () => gitTags(ROOT), (tag) => gitExtensionChanges(ROOT, tag));
  console.log(`version=${version}\nextension=${extension ?? ""}`);
}

// Compares real paths: argv[1] keeps any symlink in the path the script was started by, import.meta.url doesn't.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
