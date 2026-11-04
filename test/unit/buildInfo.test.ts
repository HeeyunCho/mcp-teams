// #96: the version and build id of the code that runs come from dist/build.json, written at build time,
// not from package.json, which a `git pull` can bump before the build runs.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBuildInfo } from "../../src/buildInfo.js";

let root: string;
let dist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-teams-build-"));
  dist = join(root, "dist");
  mkdirSync(dist);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("readBuildInfo", () => {
  it("reports the built version when package.json was bumped but dist/ wasn't rebuilt", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version: "0.9.2" }));
    writeFileSync(join(dist, "build.json"), JSON.stringify({ version: "0.9.1", buildId: "0a1b2c3d4e5f" }));
    expect(readBuildInfo(dist)).toEqual({ version: "0.9.1", buildId: "0a1b2c3d4e5f" });
  });

  it("falls back to package.json's version and no build id without a build.json", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version: "0.9.2" }));
    expect(readBuildInfo(dist)).toEqual({ version: "0.9.2", buildId: null });
  });

  it("falls back the same way when build.json can't be read", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version: "0.9.2" }));
    writeFileSync(join(dist, "build.json"), "{ half written");
    expect(readBuildInfo(dist)).toEqual({ version: "0.9.2", buildId: null });
  });
});

// Each test starts node two or three times; a busy machine can make that take longer than 5 s.
describe("scripts/write-build-info.mjs", { timeout: 30_000 }, () => {
  /** An icon's first bytes: binary, with a \r\n in it. */
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /**
   * A temporary project at 0.9.2 with a copy of the script, two built files (and a source map) and an
   * extension of three files, one in a subfolder and one binary.
   */
  function project() {
    mkdirSync(join(root, "scripts"));
    copyFileSync("scripts/write-build-info.mjs", join(root, "scripts", "write-build-info.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version: "0.9.2" }));
    mkdirSync(join(dist, "sub"));
    writeFileSync(join(dist, "index.js"), "console.log('contoso');\n");
    writeFileSync(join(dist, "sub", "tools.js"), "export const x = 1;\n");
    writeFileSync(join(dist, "index.js.map"), "{}");
    mkdirSync(join(root, "extension", "icons"), { recursive: true });
    writeFileSync(join(root, "extension", "manifest.json"), '{"version":"0.9.2"}\n');
    writeFileSync(join(root, "extension", "background.js"), "// fabrikam\n// northwind\n");
    writeFileSync(join(root, "extension", "icons", "icon-16.png"), PNG);
  }

  /** Runs the copied script, as `npm run build` does after tsc, and returns the build.json it wrote. */
  function build() {
    execFileSync(process.execPath, [join(root, "scripts", "write-build-info.mjs")], { encoding: "utf8", stdio: "pipe" });
    return JSON.parse(readFileSync(join(dist, "build.json"), "utf8"));
  }

  it("writes dist/build.json with package.json's version and a 12-hex build id", () => {
    project();
    const info = build();
    expect(info.version).toBe("0.9.2");
    expect(info.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildInfo(dist)).toEqual(info);
  });

  it("gives a rebuild of unchanged code the same id, and changed code a new one", () => {
    project();
    const first = build().buildId;
    writeFileSync(join(dist, "index.js.map"), '{"changed":true}');
    expect(build().buildId).toBe(first);
    writeFileSync(join(dist, "sub", "tools.js"), "export const x = 2;\n");
    expect(build().buildId).not.toBe(first);
  });

  // #100: the build id covers the extension the server ships too, so an extension-only release changes it.
  it("gives a change to the extension alone a new id", () => {
    project();
    const first = build().buildId;
    writeFileSync(join(root, "extension", "background.js"), "// fabrikam\n// adventure works\n");
    expect(build().buildId).not.toBe(first);
  });

  it("gives a changed icon, or a new file in the extension, a new id", () => {
    project();
    const first = build().buildId;
    writeFileSync(join(root, "extension", "icons", "icon-16.png"), Buffer.concat([PNG, Buffer.from([0])]));
    const second = build().buildId;
    expect(second).not.toBe(first);
    writeFileSync(join(root, "extension", "icons", "icon-32.png"), PNG);
    expect(build().buildId).not.toBe(second);
  });

  it("ignores a pairing.json in the extension folder: only the installed copy has one, different per install", () => {
    project();
    const first = build().buildId;
    writeFileSync(join(root, "extension", "pairing.json"), JSON.stringify({ token: "fictional-token" }));
    expect(build().buildId).toBe(first);
  });

  it("gives text files checked out with CRLF line ends (git on Windows) the id of the LF ones", () => {
    project();
    const first = build().buildId;
    writeFileSync(join(root, "extension", "background.js"), "// fabrikam\r\n// northwind\r\n");
    writeFileSync(join(root, "extension", "manifest.json"), '{"version":"0.9.2"}\r\n');
    writeFileSync(join(dist, "index.js"), "console.log('contoso');\r\n");
    expect(build().buildId).toBe(first);
  });

  // The same id on every platform for the same files, so CI on Linux and Windows and the published
  // build.json agree with a local build: sha256 over each file, by its path from the repo root with "/" and
  // in sorted order, of path, NUL, content (text with LF line ends), NUL; its first 12 hex digits.
  it("is the same id on every platform for the same files", () => {
    project();
    expect(build().buildId).toBe("e91132d4e18d");
  });
});
