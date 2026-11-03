// #96: the version and build id of the code that runs come from dist/build.json, written at build time,
// not from package.json, which a `git pull` can bump before the build runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
