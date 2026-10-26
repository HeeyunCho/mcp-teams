import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import { levelFor, nextVersion, writeAll } from "../../scripts/bump-version.mjs";

const VERSION_FILES = ["package.json", "package-lock.json", "extension/manifest.json"] as const;
type VersionFile = (typeof VERSION_FILES)[number];

/** Copies the script and writes the version files into a new temporary folder; `null` leaves a file out. */
function makeRoot(version: string, manifest: Record<string, string>, files: Partial<Record<VersionFile, string | null>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-teams-bump-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "extension"));
  copyFileSync("scripts/bump-version.mjs", join(root, "scripts", "bump-version.mjs"));
  const contents: Record<VersionFile, string | null> = {
    "package.json": JSON.stringify({ name: "x", version }, null, 2),
    "package-lock.json": JSON.stringify({ name: "x", version, packages: { "": { version }, "node_modules/y": { version: "9.9.9" } } }, null, 2),
    "extension/manifest.json": JSON.stringify(manifest, null, 2),
    ...files,
  };
  for (const f of VERSION_FILES) {
    const text = contents[f];
    if (text !== null) writeFileSync(join(root, f), text);
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
    return { out, pkg: read("package.json"), lock: read("package-lock.json"), manifest: read("extension/manifest.json") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Runs `patch` with one version file left out (`null`), replaced, or made a directory (`"<dir>"`), from `version`;
 * returns the error and every file's bytes before and after.
 */
function runCliBroken(file: VersionFile, content: string | null, version = "0.2.16") {
  const root = makeRoot(version, { version }, { [file]: content === "<dir>" ? null : content });
  if (content === "<dir>") mkdirSync(join(root, file));
  const bytes = (f: string) => {
    const path = join(root, f);
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? "<dir>" : readFileSync(path).toString("hex");
  };
  const snapshot = () => Object.fromEntries(VERSION_FILES.map((f) => [f, bytes(f)]));
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

/** Real fs whose `fail` call (e.g. the 2nd renameSync) throws instead of running. */
function failingFs(fail: { op: "writeFileSync" | "renameSync"; nth: number }) {
  const calls = { writeFileSync: 0, renameSync: 0 };
  const wrap =
    <K extends "writeFileSync" | "renameSync">(op: K) =>
    (...args: Parameters<(typeof fs)[K]>) => {
      if (op === fail.op && ++calls[op] === fail.nth) throw new Error(`injected ${op} failure`);
      return (fs[op] as (...a: unknown[]) => unknown)(...args);
    };
  return { ...fs, writeFileSync: wrap("writeFileSync"), renameSync: wrap("renameSync") };
}

describe("bump-version writeAll", () => {
  /** A temp root with the three version files, and the writes a bump to 0.2.17 would make. */
  function setup() {
    const root = makeRoot("0.2.16", { version: "0.2.16" });
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const writes = VERSION_FILES.map((f) => [f, read(f).replaceAll("0.2.16", "0.2.17"), read(f)] as const);
    const snapshot = () => Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(root, f)).toString("hex")]));
    const leftovers = () => [...readdirSync(root), ...readdirSync(join(root, "extension"))].filter((n) => n.endsWith(".tmp"));
    return { root, read, writes, snapshot, leftovers };
  }

  it("writes every file and leaves no temp files", () => {
    const { root, read, writes, leftovers } = setup();
    try {
      writeAll(root, writes);
      for (const [f, text] of writes) expect(read(f)).toBe(text);
      expect(leftovers()).toEqual([]);
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
