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

describe("scripts/write-build-info.mjs", () => {
  /** A temporary project at 0.9.2 with a copy of the script and two built files (and a source map). */
  function project() {
    mkdirSync(join(root, "scripts"));
    copyFileSync("scripts/write-build-info.mjs", join(root, "scripts", "write-build-info.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version: "0.9.2" }));
    mkdirSync(join(dist, "sub"));
    writeFileSync(join(dist, "index.js"), "console.log('contoso');\n");
    writeFileSync(join(dist, "sub", "tools.js"), "export const x = 1;\n");
    writeFileSync(join(dist, "index.js.map"), "{}");
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
});
