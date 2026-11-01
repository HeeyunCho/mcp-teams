import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import * as bump from "../../scripts/bump-version.mjs";
import { git, gitEnv } from "../helpers/gitRepo.js";

// The release steps of .github/workflows/version.yml, run from the YAML itself on temporary repositories: a bare
// "origin" and clones of it. Nothing here reaches the real repository, its tags or its version files.

const VERSION_SAMPLES: Readonly<Record<string, (version: string) => string>> = bump.VERSION_SAMPLES;

/** A spawn of bash, git and node per step; a busy machine can make these slow. */
const TIMEOUT_MS = 60_000;

/** The `run: |` block of a step in version.yml, without its indentation. */
function stepScript(name: string) {
  const lines = readFileSync(".github/workflows/version.yml", "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const run = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  if (start < 0 || run < 0) throw new Error(`version.yml has no step "${name}" with a run block`);
  const indent = lines[run].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
}

/** Runs a step as the runner does (`bash -e`), in `cwd`, with `node` being the Node that runs this test. */
function runStep(name: string, cwd: string, env: Record<string, string>) {
  const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
  return execFileSync("bash", ["-e", "-c", stepScript(name)], { cwd, env: { ...gitEnv(), PATH, ...env }, encoding: "utf8", stdio: "pipe" });
}

let root: string;
let origin: string;
/** The commit on origin's main that every clone starts from. */
let seed: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-teams-release-"));
  origin = join(root, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");

  const first = join(root, "first");
  mkdirSync(first);
  git(first, "init", "-q", "-b", "main");
  mkdirSync(join(first, "scripts"));
  copyFileSync("scripts/bump-version.mjs", join(first, "scripts", "bump-version.mjs"));
  for (const [file, sample] of Object.entries(VERSION_SAMPLES)) {
    mkdirSync(dirname(join(first, file)), { recursive: true });
    writeFileSync(join(first, file), sample("0.2.16"));
  }
  git(first, "add", ".");
  git(first, "commit", "-q", "-m", "chore: first");
  git(first, "push", "-q", origin, "main");
  seed = git(first, "rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function clone(name: string) {
  const dir = join(root, name);
  git(root, "clone", "-q", origin, dir);
  return dir;
}

/** A commit on top of the clone's HEAD, pushed to origin's main. Returns its id. */
function merge(dir: string, message: string) {
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  git(dir, "push", "-q", "origin", "HEAD:main");
  return git(dir, "rev-parse", "HEAD");
}

/** What the bump step leaves in a clone: the version files changed, nothing committed. */
function bumpVersionFiles(dir: string, version: string) {
  for (const [file, sample] of Object.entries(VERSION_SAMPLES)) writeFileSync(join(dir, file), sample(version));
}

const originMain = () => git(origin, "rev-parse", "main");
const originTags = () => git(origin, "tag", "--list").split("\n").filter(Boolean);

// The steps run under bash, as on the workflow's ubuntu-latest; the Windows CI job doesn't run the workflow.
describe.skipIf(process.platform === "win32")("version.yml Commit and tag", { timeout: TIMEOUT_MS }, () => {
  it("pushes the release commit to main and the tag together", () => {
    const work = clone("work");
    bumpVersionFiles(work, "0.2.17");
    runStep("Commit and tag", work, { VERSION: "0.2.17" });

    expect(originMain()).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("chore(release): v0.2.17");
    expect(git(origin, "rev-parse", "v0.2.17")).toBe(originMain());
  });

  // 2026-10-31: main moved during the run; main was refused, but the tag landed and blocked every later release.
  it("leaves no tag on origin when main moved on and the push is refused", () => {
    const work = clone("work");
    const moved = merge(clone("other"), "fix: merged during the run");

    bumpVersionFiles(work, "0.2.17");
    expect(() => runStep("Commit and tag", work, { VERSION: "0.2.17" })).toThrow();

    expect(originMain()).toBe(moved);
    expect(originTags()).toEqual([]);
  });

  it("leaves main alone when the tag appeared on origin after the checkout", () => {
    const work = clone("work");
    const other = clone("other");
    git(other, "tag", "v0.2.17");
    git(other, "push", "-q", "origin", "v0.2.17");

    bumpVersionFiles(work, "0.2.17");
    expect(() => runStep("Commit and tag", work, { VERSION: "0.2.17" })).toThrow();

    expect(originMain()).toBe(seed);
    expect(git(origin, "rev-parse", "v0.2.17")).toBe(seed);
  });
});
