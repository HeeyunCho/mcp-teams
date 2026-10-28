import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import * as bump from "../../scripts/bump-version.mjs";

const { bumpFiles, increment, levelFor, nextVersion, writeAll } = bump;
const VERSION_FILE_NAMES: readonly string[] = bump.VERSION_FILE_NAMES;
const VERSION_SAMPLES: Readonly<Record<string, (version: string) => string>> = bump.VERSION_SAMPLES;

describe("bump-version VERSION_FILE_NAMES", () => {
  it("puts package.json, which holds the current version, first", () => {
    expect(VERSION_FILE_NAMES[0]).toBe("package.json");
  });

  it("lists each file once", () => {
    expect(new Set(VERSION_FILE_NAMES).size).toBe(VERSION_FILE_NAMES.length);
  });

  it("names files that exist in the repository", () => {
    for (const f of VERSION_FILE_NAMES) expect(existsSync(f), f).toBe(true);
  });
});

describe("bump-version VERSION_SAMPLES", () => {
  it("has a sample for each version file, in table order", () => {
    expect(Object.keys(VERSION_SAMPLES)).toEqual(VERSION_FILE_NAMES);
    for (const f of VERSION_FILE_NAMES) expect(typeof VERSION_SAMPLES[f], `${f} has no sample in VERSION_FILES`).toBe("function");
  });

  it("gives JSON that holds the version", () => {
    for (const f of VERSION_FILE_NAMES) {
      const text = VERSION_SAMPLES[f]("1.2.3");
      expect(() => JSON.parse(text), f).not.toThrow();
      expect(text, f).toContain('"1.2.3"');
    }
  });

  // A sample missing a field its entry's update must replace makes the bump throw ("has fewer than N
  // fields"); one holding the old version in a field the update skips doesn't match the new sample.
  // One bump serves every file's case: the first case to run makes it, the others reuse its result.
  let bumped: ReturnType<typeof runBump> | undefined;
  it.each(VERSION_FILE_NAMES)("%s sample round-trips through a real bump to the new version", async (f) => {
    const r = await (bumped ??= runBump("0.2.16", ["patch"]));
    expect(r.out).toBe("0.2.17");
    expect(r.texts[f]).toBe(VERSION_SAMPLES[f]("0.2.17"));
  });
});

// The helpers below take the file list and each file's fixture from the script (VERSION_FILE_NAMES and the
// entries' samples), so a new entry in its table, whatever its shape, gets its fixture, its folder, the
// round-trip check and the "every file holds the new version" check without a test edit. The writeAll
// success and failure cases take the file list as a parameter and also run with a fourth, fictional file;
// the failure cases derive which fs call to fail from the number of files (they assume only that there are
// at least three, so the 2nd rename is neither first nor last, and that package.json comes first, as the
// script requires). Still tied to the three current files, on purpose: the broken-file cases and the
// pkg/lock/manifest assertions.

/** The folders holding version files, relative to the root ("." for the root itself). */
const VERSION_DIRS = [...new Set(VERSION_FILE_NAMES.map((f) => dirname(f)))];

/** Each version file's fixture text at `version`: its table entry's sample. */
function fixtures(version: string): Record<string, string> {
  return Object.fromEntries(VERSION_FILE_NAMES.map((f) => [f, VERSION_SAMPLES[f](version)]));
}

type FileOverrides = Partial<Record<string, string | null>>;

/** Copies the script and writes the version files into a new temporary folder; `files` replaces a fixture, `null` leaves it out. */
function makeRoot(version: string, files: FileOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-teams-bump-"));
  mkdirSync(join(root, "scripts"));
  for (const d of VERSION_DIRS) mkdirSync(join(root, d), { recursive: true });
  copyFileSync("scripts/bump-version.mjs", join(root, "scripts", "bump-version.mjs"));
  const contents: Record<string, string | null | undefined> = { ...fixtures(version), ...files };
  for (const f of VERSION_FILE_NAMES) {
    const text = contents[f];
    if (text != null) writeFileSync(join(root, f), text);
  }
  return root;
}

// Each run of the script is a new node process: ~0.2 s on an idle machine, but 0.8 s (up to 2.6 s) with the CPU
// oversubscribed and 6-18 s once memory runs short, as in a full `npm test` on a busy Windows machine. Two in one
// test took 5.2 s there, past vitest's 5 s timeout. So the bumps run in-process (bumpFiles), and only the tests
// of the command line itself (arguments, stdin, exit code) start the script, once each.
const MAX_SCRIPT_RUNS_PER_TEST = 1;
const MAX_SCRIPT_RUNS = 3;
let spawns = 0;
let totalSpawns = 0;
beforeEach(() => {
  spawns = 0;
});
afterEach(() => {
  expect(spawns, "script runs (node processes) in this test; split the test or test in-process").toBeLessThanOrEqual(MAX_SCRIPT_RUNS_PER_TEST);
});
afterAll(() => {
  expect(totalSpawns, "script runs (node processes) in this file; test the bump in-process with bumpFiles").toBeLessThanOrEqual(MAX_SCRIPT_RUNS);
});

const runScript = (root: string, args: string[], stdin = "") => {
  spawns++;
  totalSpawns++;
  return execFileSync(process.execPath, [join(root, "scripts", "bump-version.mjs"), ...args], { input: stdin, encoding: "utf8", stdio: "pipe" }).trim();
};

/** How a test runs a bump on a root: in-process through bumpFiles, as the CLI does, or as the CLI itself (a new process). */
type Via = "bumpFiles" | "process";

type RunBumpOptions = {
  /** What the CLI would read on stdin: NUL-separated commit messages. */
  stdin?: string;
  /** Fixture overrides, as in makeRoot. */
  files?: FileOverrides;
  /** In-process (the default) or as a new process. */
  via?: Via;
};

/**
 * Runs a bump with the CLI's arguments on a copy of the repository's version files in a temporary folder;
 * `out` is what the CLI prints (the new version).
 */
async function runBump(version: string, args: string[], { stdin = "", files = {}, via = "bumpFiles" }: RunBumpOptions = {}) {
  const root = makeRoot(version, files);
  try {
    const out: string = via === "process" ? runScript(root, args, stdin) : await bumpFiles(root, args[0], async () => stdin);
    const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
    const texts: Record<string, string> = Object.fromEntries(
      VERSION_FILE_NAMES.map((f) => [f, readFileSync(join(root, f), "utf8")]),
    );
    return { out, texts, pkg: read("package.json"), lock: read("package-lock.json"), manifest: read("extension/manifest.json") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Runs `patch` with one version file left out (`null`), replaced, or made a directory (`"<dir>"`), from `version`;
 * returns the error (its message is what the CLI prints) and every file's bytes before and after.
 */
async function runBumpBroken(file: string, content: string | null, version = "0.2.16") {
  const root = makeRoot(version, { [file]: content === "<dir>" ? null : content });
  if (content === "<dir>") mkdirSync(join(root, file));
  const bytes = (f: string) => {
    const path = join(root, f);
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? "<dir>" : readFileSync(path).toString("hex");
  };
  const snapshot = () => Object.fromEntries(VERSION_FILE_NAMES.map((f) => [f, bytes(f)]));
  try {
    const before = snapshot();
    let error: Error | undefined;
    try {
      await bumpFiles(root, "patch", async () => "");
    } catch (e) {
      error = e as Error;
    }
    return { error, before, after: snapshot() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bump-version bumpFiles with a missing or broken version file", () => {
  it.each([
    ["package-lock.json", null, /package-lock\.json/],
    ["extension/manifest.json", null, /manifest\.json/],
    ["package-lock.json", "<dir>", /package-lock\.json/],
    ["extension/manifest.json", "<dir>", /manifest\.json/],
    ["package-lock.json", "{ not json", /package-lock\.json/],
    ["extension/manifest.json", "{ not json", /manifest\.json/],
    ["package.json", "{ not json", /package\.json/],
    ["package-lock.json", JSON.stringify({ name: "x", packages: {} }, null, 2), /package-lock\.json/],
    ["package-lock.json", JSON.stringify({ name: "x", version: "0.2.16", packages: {} }, null, 2), /package-lock\.json/],
    ["extension/manifest.json", JSON.stringify({ name: "x" }, null, 2), /manifest\.json/],
  ] as const)("fails on %s = %j, naming the file, and leaves every file untouched", async (file, content, message) => {
    const r = await runBumpBroken(file, content);
    expect(r.error).toBeDefined();
    expect(r.error?.message).toMatch(message);
    expect(r.after).toEqual(r.before);
  });

  it.each([
    ["1.2.65535", /65535/],
    ["1.2", /invalid version "1\.2"/i],
  ] as const)("leaves every file untouched when the new version can't be computed from %s", async (version, message) => {
    const r = await runBumpBroken("package.json", JSON.stringify({ name: "x", version }, null, 2), version);
    expect(r.error?.message).toMatch(message);
    expect(r.after).toEqual(r.before);
  });
});

type FsOp = "writeFileSync" | "renameSync" | "rmSync" | "chmodSync";

/** One call to fail; only a writeFileSync can fail `partial`ly. */
type FsFailure = { op: "writeFileSync"; nth: number; partial?: true } | { op: Exclude<FsOp, "writeFileSync">; nth: number };

/**
 * Real fs whose listed calls (e.g. the 2nd renameSync) throw instead of running. A writeFileSync marked
 * `partial` writes the first half of its data before throwing, as a full disk or an interruption can.
 */
function failingFs(...fails: FsFailure[]) {
  const real = { writeFileSync, renameSync, rmSync, chmodSync };
  const calls = { writeFileSync: 0, renameSync: 0, rmSync: 0, chmodSync: 0 };
  const wrap =
    (op: FsOp) =>
    (...args: unknown[]) => {
      const n = ++calls[op];
      const fail = fails.find((f) => f.op === op && f.nth === n);
      if (fail?.op === "writeFileSync" && fail.partial) {
        const [path, data] = args as [string, string];
        writeFileSync(path, data.slice(0, Math.floor(data.length / 2)));
      }
      if (fail) throw new Error(`injected ${op} failure #${n}`);
      return (real[op] as (...a: unknown[]) => unknown)(...args);
    };
  return {
    statSync,
    chmodSync: wrap("chmodSync"),
    writeFileSync: wrap("writeFileSync"),
    renameSync: wrap("renameSync"),
    rmSync: wrap("rmSync"),
  };
}

describe("bump-version failingFs test helper", () => {
  it("takes a partial failure only on writeFileSync", () => {
    expect(() => failingFs({ op: "writeFileSync", nth: 1, partial: true })).not.toThrow();
    // @ts-expect-error a partial write only makes sense for writeFileSync
    expect(() => failingFs({ op: "renameSync", nth: 1, partial: true })).not.toThrow();
  });
});

/** Runs `fn` and returns what it threw. */
function thrown(fn: () => void) {
  try {
    fn();
  } catch (e) {
    return e as Error & { cause?: Error };
  }
  throw new Error("expected a throw");
}

/**
 * A temp root with the version files in `names`, and the writes a bump to 0.2.17 would make. `extra` gives the
 * text of a file that isn't in the script's table (a fictional one, to run the cases with more files).
 */
function writeAllSetup(names: readonly string[], extra: Record<string, string> = {}) {
  const root = makeRoot("0.2.16");
  for (const [f, text] of Object.entries(extra)) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const writes = names.map((file) => ({ file, text: read(file).replaceAll("0.2.16", "0.2.17"), original: read(file) }));
  const bytes = (f: string) => readFileSync(join(root, f)).toString("hex");
  const snapshot = () => Object.fromEntries(names.map((f) => [f, bytes(f)]));
  const dirs = [...new Set(names.map((f) => dirname(f)))];
  const leftovers = () => dirs.flatMap((d) => readdirSync(join(root, d))).filter((n) => n.endsWith(".tmp"));
  return { root, read, writes, bytes, snapshot, leftovers };
}

describe("bump-version writeAll", () => {
  successCases(VERSION_FILE_NAMES);
  failureCases(VERSION_FILE_NAMES);
});

describe("bump-version writeAll with a fourth, fictional version file", () => {
  const names = [...VERSION_FILE_NAMES, "extra/other.json"];
  const extra = { "extra/other.json": '{ "version": "0.2.16" }\n' };
  successCases(names, extra);
  failureCases(names, extra);
});

/** Registers writeAll's success cases for the version files in `names` (`extra` as in writeAllSetup). */
function successCases(names: readonly string[], extra: Record<string, string> = {}) {
  const setup = () => writeAllSetup(names, extra);

  it("writes every file and leaves no temp files", () => {
    const { root, read, writes, leftovers } = setup();
    try {
      writeAll(root, writes);
      for (const { file, text } of writes) expect(read(file), file).toBe(text);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Windows has no POSIX mode bits to keep.
  it.skipIf(process.platform === "win32")("keeps each target's file mode", () => {
    const { root, writes } = setup();
    // A different mode per file, so a file given another file's mode shows.
    const modes = [0o755, 0o600, 0o640, 0o700];
    const modeOf = (i: number) => modes[i % modes.length];
    try {
      names.forEach((f, i) => chmodSync(join(root, f), modeOf(i)));
      writeAll(root, writes);
      names.forEach((f, i) => expect(statSync(join(root, f)).mode & 0o777, f).toBe(modeOf(i)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/** Registers writeAll's failure cases for the version files in `names` (`extra` as in writeAllSetup). */
function failureCases(names: readonly string[], extra: Record<string, string> = {}) {
  const setup = () => writeAllSetup(names, extra);

  // Which call of each fs function a step is, for n files (see writeAll): the n forward temp writes, each
  // followed by its chmod, then the n renames; on failure, each replaced file k (0-based, in order) is
  // restored by one more write + chmod, then one more rename.
  const n = names.length;
  const lastTempWrite = n;
  const lastRename = n;
  /** The writeFileSync that stages the restore of replaced file k. */
  const restoreWrite = (k: number) => n + 1 + k;
  /** The chmodSync on the restore temp of replaced file k. */
  const restoreChmod = (k: number) => n + 1 + k;
  /** The renameSync that restores replaced file k, after rename `failedRename` failed. */
  const restoreRename = (failedRename: number, k: number) => failedRename + 1 + k;

  it.each([
    ["the 1st temp write", { op: "writeFileSync", nth: 1 }],
    ["the last temp write", { op: "writeFileSync", nth: lastTempWrite }],
    ["the 1st rename", { op: "renameSync", nth: 1 }],
    ["the 2nd rename (rolls back the 1st)", { op: "renameSync", nth: 2 }],
    ["the last rename (rolls back all but the last)", { op: "renameSync", nth: lastRename }],
  ] as const)("fails on %s, rethrows and leaves every file untouched with no temp files", (_, fail) => {
    const { root, writes, snapshot, leftovers } = setup();
    try {
      const before = snapshot();
      expect(() => writeAll(root, writes, failingFs(fail))).toThrow(`injected ${fail.op} failure`);
      expect(snapshot()).toEqual(before);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still cleans up when a rollback write fails, naming the file and keeping the cause", () => {
    const { root, writes, bytes, snapshot, leftovers } = setup();
    try {
      const before = snapshot();
      // The 2nd rename fails; the first restore write, the rollback temp of package.json, fails.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "writeFileSync", nth: restoreWrite(0) })),
      );
      expect(e.message).toMatch(/package\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #2");
      expect(leftovers()).toEqual([]);
      for (const f of names.slice(1)) expect(bytes(f), f).toBe(before[f]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores every other replaced file when one rollback write fails", () => {
    const { root, writes, bytes, snapshot } = setup();
    try {
      const before = snapshot();
      // The last rename fails; the first restore write (rollback temp of package.json) fails, the restores of
      // the other replaced files (package-lock.json, ...) must still run.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: lastRename }, { op: "writeFileSync", nth: restoreWrite(0) })),
      );
      expect(e.message).toMatch(/package\.json/);
      expect(e.message).not.toMatch(/package-lock\.json/);
      expect(e.cause?.message).toBe(`injected renameSync failure #${lastRename}`);
      for (const f of names.slice(1)) {
        expect(e.message, f).not.toContain(`restore ${f}`);
        expect(bytes(f), f).toBe(before[f]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a target whole when its rollback write fails partway", () => {
    const { root, writes, read, leftovers } = setup();
    try {
      // The 2nd rename fails; the first restore write, the rollback of package.json, writes half and throws.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "writeFileSync", nth: restoreWrite(0), partial: true })),
      );
      expect(e.message).toMatch(/could not restore package\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #2");
      // Not restored, but complete: it still holds the new text rather than half of the original.
      expect(read("package.json")).toBe(writes[0].text);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a target whole and removes the restore temp when its rollback rename fails", () => {
    const { root, writes, read, leftovers } = setup();
    try {
      // Renames 1-2: package.json is replaced, then package-lock.json fails; the first restore rename, the
      // rollback of package.json, fails.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "renameSync", nth: restoreRename(2, 0) })),
      );
      expect(e.message).toMatch(/could not restore package\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #2");
      expect(read("package.json")).toBe(writes[0].text);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a target whole when its rollback chmod fails", () => {
    const { root, writes, read, leftovers } = setup();
    try {
      // The 2nd rename fails; the first restore chmod, on the rollback temp of package.json, fails.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "chmodSync", nth: restoreChmod(0) })),
      );
      expect(e.message).toMatch(/could not restore package\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #2");
      expect(read("package.json")).toBe(writes[0].text);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still removes the other temps when removing one fails, and keeps the original error", () => {
    const { root, writes, snapshot, leftovers } = setup();
    try {
      const before = snapshot();
      // The last temp write fails; removing the 1st temp fails, the others must still be removed.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "writeFileSync", nth: lastTempWrite }, { op: "rmSync", nth: 1 })),
      );
      expect(e.cause?.message).toBe(`injected writeFileSync failure #${lastTempWrite}`);
      expect(e.message).toMatch(/package\.json\.bump-\d+\.tmp/);
      expect(leftovers()).toEqual([`package.json.bump-${process.pid}.tmp`]);
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

describe("bump-version CLI", () => {
  // A real process: the script's entry, stdin and stdout, as the version workflow runs it.
  it("reads NUL-separated commit messages from stdin, prints the new version and writes all three files", async () => {
    const r = await runBump("0.2.16", [], { stdin: "feat: autoSendTo\n\n\0fix: y\n\n\0", via: "process" });
    expect(r.out).toBe("0.2.17");
    expect(r.pkg.version).toBe("0.2.17");
    expect(r.lock.version).toBe("0.2.17");
    expect(r.lock.packages[""].version).toBe("0.2.17");
    expect(r.lock.packages["node_modules/y"].version).toBe("9.9.9");
    expect(r.manifest.version).toBe("0.2.17");
    for (const f of VERSION_FILE_NAMES) expect(r.texts[f], f).toContain('"0.2.17"');
  });

  it.each([
    ["minor", "0.3.0"],
    ["major", "1.0.0"],
  ])("takes an explicit level as given (%s)", async (level, expected) => {
    expect((await runBump("0.2.16", [level])).out).toBe(expected);
  });

  it("replaces a prerelease in every file, and a manifest version_name with the released version", async () => {
    // Chrome's manifest "version" takes only 1-4 dot-separated integers; a prerelease can only sit in "version_name".
    const r = await runBump("0.3.0-beta.1", [], {
      stdin: "fix: y\n\n\0",
      files: { "extension/manifest.json": JSON.stringify({ version: "0.3.0", version_name: "0.3.0-beta.1" }, null, 2) },
    });
    expect(r.out).toBe("0.3.0");
    expect(r.pkg.version).toBe("0.3.0");
    expect(r.lock.version).toBe("0.3.0");
    expect(r.lock.packages[""].version).toBe("0.3.0");
    expect(r.lock.packages["node_modules/y"].version).toBe("9.9.9");
    expect(r.manifest).toEqual({ version: "0.3.0", version_name: "0.3.0" });
  });

  // argv[1] keeps a symlinked path, import.meta.url is the real one (macOS's TMPDIR is under the /var symlink).
  // Windows may need privileges to create a symlink.
  it.skipIf(process.platform === "win32")("runs when started through a symlinked path", () => {
    const root = realpathSync(makeRoot("0.2.16"));
    const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-teams-bump-link-")));
    try {
      const link = join(linkDir, "root");
      symlinkSync(root, link, "dir");
      expect(runScript(link, ["patch"])).toBe("0.2.17");
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nextVersion before 1.0.0", () => {
  it("bumps the patch for fixes and other commits", () => {
    expect(nextVersion("0.1.0", ["Fix search"])).toBe("0.1.1");
    expect(nextVersion("0.1.0", ["fix: x", "docs: y"])).toBe("0.1.1");
  });

  it("bumps the patch for feat:, as PR #47 should have (0.2.16 -> 0.2.17)", () => {
    expect(nextVersion("0.2.16", ["feat: autoSendTo config"])).toBe("0.2.17");
    expect(nextVersion("0.1.3", ["fix: x", "feat(search): folders"])).toBe("0.1.4");
  });

  it("bumps the minor for type!: and BREAKING CHANGE footers", () => {
    expect(nextVersion("0.2.16", ["feat!: drop old config"])).toBe("0.3.0");
    expect(nextVersion("0.2.16", ["fix(bridge)!: new port"])).toBe("0.3.0");
    expect(nextVersion("0.2.16", ["fix: x\n\nBREAKING CHANGE: y"])).toBe("0.3.0");
    expect(nextVersion("0.2.16", ["chore: x\n\nBREAKING-CHANGE: y", "feat: z"])).toBe("0.3.0");
  });

  it("doesn't take BREAKING CHANGE in the middle of a line as a footer", () => {
    expect(nextVersion("0.1.0", ["feat: x\n\n- major for\n  BREAKING CHANGE / type!:, minor for feat:"])).toBe("0.1.1");
  });
});

describe("nextVersion from 1.0.0 on (standard semver)", () => {
  it("bumps the patch for fixes, the minor for feat: and the major for breaking changes", () => {
    expect(nextVersion("1.2.3", ["fix: x"])).toBe("1.2.4");
    expect(nextVersion("1.2.3", ["feat(search): folders"])).toBe("1.3.0");
    expect(nextVersion("1.2.3", ["feat!: x"])).toBe("2.0.0");
    expect(nextVersion("1.2.3", ["fix: x\n\nBREAKING CHANGE: y"])).toBe("2.0.0");
  });
});

// Expected values checked against semver.inc (semver 7.8.5, the copy bundled with npm).
describe("nextVersion from a prerelease (semver.inc / npm version)", () => {
  it("releases the prerelease on a patch bump (0.3.0-beta.1 -> 0.3.0)", () => {
    expect(nextVersion("0.3.0-beta.1", ["fix: x"])).toBe("0.3.0");
    expect(nextVersion("1.2.3-rc.1", ["fix: x"])).toBe("1.2.3");
  });

  it("releases X.Y.0 on a minor bump when the patch is 0, else moves to the next minor", () => {
    expect(nextVersion("0.3.0-beta.1", ["feat!: x"])).toBe("0.3.0");
    expect(nextVersion("0.3.1-beta.1", ["feat!: x"])).toBe("0.4.0");
    expect(nextVersion("1.2.0-rc.1", ["feat: x"])).toBe("1.2.0");
    expect(nextVersion("1.2.3-rc.1", ["feat: x"])).toBe("1.3.0");
  });

  it("releases X.0.0 on a major bump when minor and patch are 0, else moves to the next major", () => {
    expect(nextVersion("2.0.0-alpha", ["feat!: x"])).toBe("2.0.0");
    expect(nextVersion("1.2.3-rc.1", ["feat!: x"])).toBe("2.0.0");
    // An explicit `major`, as the CLI applies it (see "takes an explicit level as given").
    expect(increment("0.3.0-beta.1", "major")).toBe("1.0.0");
    expect(increment("1.0.0-rc.1", "major")).toBe("1.0.0");
  });

  it("drops build metadata", () => {
    expect(nextVersion("1.2.3+build.5", ["fix: x"])).toBe("1.2.4");
    expect(nextVersion("1.2.3-beta.1+b", ["feat: x"])).toBe("1.3.0");
  });

  it("counts every 0.x prerelease and 1.0.0-rc as below 1.0.0, as semver orders them", () => {
    expect(levelFor("0.3.0-beta.1", "minor")).toBe("patch");
    expect(levelFor("1.0.0-rc.1", "major")).toBe("minor");
    expect(levelFor("1.0.0-rc.1", "minor")).toBe("patch");
    expect(levelFor("1.0.0", "major")).toBe("major");
    expect(levelFor("1.0.1-rc.1", "major")).toBe("major");
  });
});

describe("nextVersion with an invalid version", () => {
  it.each(["1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "a.b.c", ""])("throws on %j instead of producing NaN", (v) => {
    expect(() => nextVersion(v, ["fix: x"])).toThrow(/invalid version/i);
  });

  it("throws on numbers too large to count exactly, as semver does", () => {
    expect(() => nextVersion("99999999999999999.0.0", ["fix: x"])).toThrow(/invalid version/i);
    expect(() => nextVersion("1.2.9007199254740993", ["fix: x"])).toThrow(/invalid version/i);
  });

  it("throws rather than give a part Chrome's manifest can't take (above 65535)", () => {
    expect(nextVersion("0.0.65534", ["fix: x"])).toBe("0.0.65535");
    expect(() => nextVersion("0.0.65535", ["fix: x"])).toThrow(/65535/);
  });

  // A real process: the workflow relies on the script exiting non-zero.
  it("makes the CLI exit with an error naming the bad version", async () => {
    await expect(runBump("1.2", ["patch"], { via: "process" })).rejects.toThrow(/invalid version "1\.2"/i);
  });
});
