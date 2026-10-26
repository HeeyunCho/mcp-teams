import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import { levelFor, nextVersion, VERSION_FILE_NAMES, writeAll } from "../../scripts/bump-version.mjs";

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

describe("bump-version test fixtures", () => {
  it("gives a version file without a specific fixture a generic one holding the version", () => {
    const contents = fixtures([...VERSION_FILE_NAMES, "extra/other.json"], "1.2.3", { version: "1.2.3" });
    expect(contents["extra/other.json"]).toBe(JSON.stringify({ version: "1.2.3" }, null, 2));
    expect(JSON.parse(contents["package.json"])).toEqual({ name: "x", version: "1.2.3" });
  });
});

// The helpers below take the file list from the script (VERSION_FILE_NAMES), so a new entry in its table
// gets a generic fixture, its folder and the "every file holds the new version" check without a test edit.
// Still tied to the three current files, on purpose: their specific fixtures in `fixtures`, the
// broken-file cases, the pkg/lock/manifest assertions and the writeAll failure-count cases (which count
// writes and renames for three files). A new file whose version isn't a top-level "version" field also
// needs its own fixture there.

/** The folders holding version files, relative to the root ("." for the root itself). */
const VERSION_DIRS = [...new Set(VERSION_FILE_NAMES.map((f: string) => dirname(f)))] as string[];

/** Each named file's fixture text at `version`: the three current files have specific ones, any other a generic one. */
function fixtures(names: readonly string[], version: string, manifest: Record<string, string>): Record<string, string> {
  const specific: Record<string, string> = {
    "package.json": JSON.stringify({ name: "x", version }, null, 2),
    "package-lock.json": JSON.stringify({ name: "x", version, packages: { "": { version }, "node_modules/y": { version: "9.9.9" } } }, null, 2),
    "extension/manifest.json": JSON.stringify(manifest, null, 2),
  };
  return Object.fromEntries(names.map((f) => [f, specific[f] ?? JSON.stringify({ version }, null, 2)]));
}

/** Copies the script and writes the version files into a new temporary folder; `null` leaves a file out. */
function makeRoot(version: string, manifest: Record<string, string>, files: Partial<Record<string, string | null>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-teams-bump-"));
  mkdirSync(join(root, "scripts"));
  for (const d of VERSION_DIRS) mkdirSync(join(root, d), { recursive: true });
  copyFileSync("scripts/bump-version.mjs", join(root, "scripts", "bump-version.mjs"));
  const contents: Record<string, string | null | undefined> = { ...fixtures(VERSION_FILE_NAMES, version, manifest), ...files };
  for (const f of VERSION_FILE_NAMES as string[]) {
    const text = contents[f];
    if (text != null) writeFileSync(join(root, f), text);
  }
  return root;
}

const runScript = (root: string, args: string[], stdin = "") =>
  execFileSync(process.execPath, [join(root, "scripts", "bump-version.mjs"), ...args], { input: stdin, encoding: "utf8", stdio: "pipe" }).trim();

/** Runs the script on a copy of the repository's version files in a temporary folder. */
function runCli(version: string, args: string[], stdin = "", manifest: Record<string, string> = { version }) {
  const root = makeRoot(version, manifest);
  try {
    const out = runScript(root, args, stdin);
    const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
    const texts: Record<string, string> = Object.fromEntries(
      VERSION_FILE_NAMES.map((f: string) => [f, readFileSync(join(root, f), "utf8")]),
    );
    return { out, texts, pkg: read("package.json"), lock: read("package-lock.json"), manifest: read("extension/manifest.json") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Runs `patch` with one version file left out (`null`), replaced, or made a directory (`"<dir>"`), from `version`;
 * returns the error and every file's bytes before and after.
 */
function runCliBroken(file: string, content: string | null, version = "0.2.16") {
  const root = makeRoot(version, { version }, { [file]: content === "<dir>" ? null : content });
  if (content === "<dir>") mkdirSync(join(root, file));
  const bytes = (f: string) => {
    const path = join(root, f);
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? "<dir>" : readFileSync(path).toString("hex");
  };
  const snapshot = () => Object.fromEntries(VERSION_FILE_NAMES.map((f: string) => [f, bytes(f)]));
  try {
    const before = snapshot();
    let error: (Error & { stderr?: string }) | undefined;
    try {
      runScript(root, ["patch"]);
    } catch (e) {
      error = e as Error & { stderr?: string };
    }
    return { error, before, after: snapshot() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bump-version CLI with a missing or broken version file", () => {
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
  ] as const)("fails on %s = %j, naming the file, and leaves every file untouched", (file, content, message) => {
    const r = runCliBroken(file, content);
    expect(r.error).toBeDefined();
    expect(r.error?.stderr).toMatch(message);
    expect(r.after).toEqual(r.before);
  });

  it("leaves every file untouched when the new version can't be computed", () => {
    const tooBig = runCliBroken("package.json", JSON.stringify({ name: "x", version: "1.2.65535" }, null, 2), "1.2.65535");
    expect(tooBig.error?.stderr).toMatch(/65535/);
    expect(tooBig.after).toEqual(tooBig.before);
    const invalid = runCliBroken("package.json", JSON.stringify({ name: "x", version: "1.2" }, null, 2));
    expect(invalid.error?.stderr).toMatch(/invalid version "1\.2"/i);
    expect(invalid.after).toEqual(invalid.before);
  });
});

type FsOp = "writeFileSync" | "renameSync" | "rmSync";

/**
 * Real fs whose listed calls (e.g. the 2nd renameSync) throw instead of running. A writeFileSync marked
 * `partial` writes the first half of its data before throwing, as a full disk or an interruption can.
 */
function failingFs(...fails: { op: FsOp; nth: number; partial?: true }[]) {
  const real = { writeFileSync, renameSync, rmSync };
  const calls = { writeFileSync: 0, renameSync: 0, rmSync: 0 };
  const wrap =
    (op: FsOp) =>
    (...args: unknown[]) => {
      const n = ++calls[op];
      const fail = fails.find((f) => f.op === op && f.nth === n);
      if (fail?.partial) {
        const [path, data] = args as [string, string];
        writeFileSync(path, data.slice(0, Math.floor(data.length / 2)));
      }
      if (fail) throw new Error(`injected ${op} failure #${n}`);
      return (real[op] as (...a: unknown[]) => unknown)(...args);
    };
  return { statSync, chmodSync, writeFileSync: wrap("writeFileSync"), renameSync: wrap("renameSync"), rmSync: wrap("rmSync") };
}

describe("bump-version writeAll", () => {
  /** A temp root with the three version files, and the writes a bump to 0.2.17 would make. */
  function setup() {
    const root = makeRoot("0.2.16", { version: "0.2.16" });
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const writes = VERSION_FILE_NAMES.map((file: string) => ({ file, text: read(file).replaceAll("0.2.16", "0.2.17"), original: read(file) }));
    const bytes = (f: string) => readFileSync(join(root, f)).toString("hex");
    const snapshot = () => Object.fromEntries(VERSION_FILE_NAMES.map((f: string) => [f, bytes(f)]));
    const leftovers = () => VERSION_DIRS.flatMap((d) => readdirSync(join(root, d))).filter((n) => n.endsWith(".tmp"));
    return { root, read, writes, bytes, snapshot, leftovers };
  }

  /** Runs `fn` and returns what it threw. */
  function thrown(fn: () => void) {
    try {
      fn();
    } catch (e) {
      return e as Error & { cause?: Error };
    }
    throw new Error("expected a throw");
  }

  it("writes every file and leaves no temp files", () => {
    const { root, read, writes, leftovers } = setup();
    try {
      writeAll(root, writes);
      for (const { file, text } of writes) expect(read(file)).toBe(text);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Windows has no POSIX mode bits to keep.
  it.skipIf(process.platform === "win32")("keeps the target's file mode", () => {
    const { root, writes } = setup();
    try {
      chmodSync(join(root, "package.json"), 0o755);
      writeAll(root, writes);
      expect(statSync(join(root, "package.json")).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["the 1st temp write", { op: "writeFileSync", nth: 1 }],
    ["the 3rd temp write", { op: "writeFileSync", nth: 3 }],
    ["the 1st rename", { op: "renameSync", nth: 1 }],
    ["the 2nd rename (rolls back the 1st)", { op: "renameSync", nth: 2 }],
    ["the 3rd rename (rolls back two)", { op: "renameSync", nth: 3 }],
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
      // Writes 1-3 make the temps; the 2nd rename fails; write 4 is the rollback temp of package.json.
      const e = thrown(() => writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "writeFileSync", nth: 4 })));
      expect(e.message).toMatch(/package\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #2");
      expect(leftovers()).toEqual([]);
      expect(bytes("package-lock.json")).toBe(before["package-lock.json"]);
      expect(bytes("extension/manifest.json")).toBe(before["extension/manifest.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores every other replaced file when one rollback write fails", () => {
    const { root, writes, bytes, snapshot } = setup();
    try {
      const before = snapshot();
      // The 3rd rename fails; write 4 (rollback temp of package.json) fails, write 5 and rename 4 (rollback of
      // package-lock.json) must still run.
      const e = thrown(() => writeAll(root, writes, failingFs({ op: "renameSync", nth: 3 }, { op: "writeFileSync", nth: 4 })));
      expect(e.message).toMatch(/package\.json/);
      expect(e.message).not.toMatch(/package-lock\.json/);
      expect(e.cause?.message).toBe("injected renameSync failure #3");
      expect(bytes("package-lock.json")).toBe(before["package-lock.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a target whole when its rollback write fails partway", () => {
    const { root, writes, read, leftovers } = setup();
    try {
      // Writes 1-3 make the temps; the 2nd rename fails; write 4, the rollback of package.json, writes half and throws.
      const e = thrown(() =>
        writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "writeFileSync", nth: 4, partial: true })),
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
      // Renames 1-2: package.json is replaced, then package-lock.json fails; rename 3, the rollback of package.json, fails.
      const e = thrown(() => writeAll(root, writes, failingFs({ op: "renameSync", nth: 2 }, { op: "renameSync", nth: 3 })));
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
      // The 3rd temp write fails; removing the 1st temp fails, the 2nd must still be removed.
      const e = thrown(() => writeAll(root, writes, failingFs({ op: "writeFileSync", nth: 3 }, { op: "rmSync", nth: 1 })));
      expect(e.cause?.message).toBe("injected writeFileSync failure #3");
      expect(e.message).toMatch(/package\.json\.bump-\d+\.tmp/);
      expect(leftovers()).toEqual([`package.json.bump-${process.pid}.tmp`]);
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bump-version CLI", () => {
  it("reads NUL-separated commit messages from stdin, prints the new version and writes all three files", () => {
    const r = runCli("0.2.16", [], "feat: autoSendTo\n\n\0fix: y\n\n\0");
    expect(r.out).toBe("0.2.17");
    expect(r.pkg.version).toBe("0.2.17");
    expect(r.lock.version).toBe("0.2.17");
    expect(r.lock.packages[""].version).toBe("0.2.17");
    expect(r.lock.packages["node_modules/y"].version).toBe("9.9.9");
    expect(r.manifest.version).toBe("0.2.17");
    for (const f of VERSION_FILE_NAMES) expect(r.texts[f], f).toContain('"0.2.17"');
  });

  it("takes an explicit level as given", () => {
    expect(runCli("0.2.16", ["minor"]).out).toBe("0.3.0");
    expect(runCli("0.2.16", ["major"]).out).toBe("1.0.0");
  });

  it("replaces a prerelease in every file, and a manifest version_name with the released version", () => {
    // Chrome's manifest "version" takes only 1-4 dot-separated integers; a prerelease can only sit in "version_name".
    const r = runCli("0.3.0-beta.1", [], "fix: y\n\n\0", { version: "0.3.0", version_name: "0.3.0-beta.1" });
    expect(r.out).toBe("0.3.0");
    expect(r.pkg.version).toBe("0.3.0");
    expect(r.lock.version).toBe("0.3.0");
    expect(r.lock.packages[""].version).toBe("0.3.0");
    expect(r.lock.packages["node_modules/y"].version).toBe("9.9.9");
    expect(r.manifest).toEqual({ version: "0.3.0", version_name: "0.3.0" });
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
    expect(runCli("0.3.0-beta.1", ["major"]).out).toBe("1.0.0");
    expect(runCli("1.0.0-rc.1", ["major"]).out).toBe("1.0.0");
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

  it("makes the CLI exit with an error naming the bad version", () => {
    expect(() => runCli("1.2", ["patch"])).toThrow(/invalid version "1\.2"/i);
  });
});
