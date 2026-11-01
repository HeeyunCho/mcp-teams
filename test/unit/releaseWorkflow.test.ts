import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** A new folder under the temporary root with the bump script and the version files at 0.2.16, not in any repository. */
function project(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync("scripts/bump-version.mjs", join(dir, "scripts", "bump-version.mjs"));
  for (const [file, sample] of Object.entries(VERSION_SAMPLES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), sample("0.2.16"));
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-teams-release-"));
  origin = join(root, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");

  const first = project("first");
  git(first, "init", "-q", "-b", "main");
  git(first, "add", ".");
  git(first, "commit", "-q", "-m", "chore: first");
  git(first, "push", "-q", origin, "main");
  seed = git(first, "rev-parse", "HEAD");
}, TIMEOUT_MS);

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
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

describe.skipIf(process.platform === "win32")("version.yml Bump version, then Commit and tag", { timeout: TIMEOUT_MS }, () => {
  // The state 2026-10-31 left: a tag for the next version on a commit that isn't on main. The clone sees it as
  // the workflow's checkout does (fetch-depth: 0 fetches every tag, on main or not).
  it("releases the next free version past a stray tag and leaves that tag where it is", () => {
    const other = clone("other");
    git(other, "commit", "-q", "--allow-empty", "-m", "chore(release): v0.2.17");
    git(other, "tag", "v0.2.17");
    git(other, "push", "-q", "origin", "v0.2.17");
    const stray = git(other, "rev-parse", "v0.2.17");
    git(other, "reset", "-q", "--hard", seed);
    merge(other, "fix: y");

    const work = clone("work");
    const output = join(root, "github-output");
    writeFileSync(output, "");
    runStep("Bump version", work, { BEFORE: seed, GITHUB_OUTPUT: output });
    expect(readFileSync(output, "utf8")).toBe("version=0.2.18\n");

    runStep("Commit and tag", work, { VERSION: "0.2.18" });
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("chore(release): v0.2.18");
    expect(git(origin, "rev-parse", "v0.2.18")).toBe(originMain());
    expect(JSON.parse(git(origin, "show", "main:package.json")).version).toBe("0.2.18");
    expect(git(origin, "rev-parse", "v0.2.17")).toBe(stray);
  });
});

describe("gitEnv test helper", { timeout: TIMEOUT_MS }, () => {
  // Git on Windows can't open os.devNull (\\.\nul) as a config file and every command dies, so it must be a real file.
  it("points git's user config at a real, empty file", () => {
    const config = gitEnv().GIT_CONFIG_GLOBAL as string;
    expect(statSync(config).isFile()).toBe(true);
    expect(statSync(config).size).toBe(0);
  });

  it("keeps user and system config out", () => {
    expect(gitEnv().GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(git(root, "config", "--global", "--list")).toBe("");
  });
});

describe("bump-version CLI and git tags", { timeout: TIMEOUT_MS }, () => {
  const runCli = (dir: string) =>
    execFileSync(process.execPath, [join(dir, "scripts", "bump-version.mjs"), "patch"], { env: gitEnv(), encoding: "utf8", stdio: "pipe" }).trim();

  it("moves past a tag in the repository it is in", () => {
    const work = clone("work");
    git(work, "tag", "v0.2.17");
    expect(runCli(work)).toBe("0.2.18");
  });

  it("fails without writing anything when it can't read the tags", () => {
    const plain = project("plain");
    expect(() => runCli(plain)).toThrow(/git tags/);
    expect(JSON.parse(readFileSync(join(plain, "package.json"), "utf8")).version).toBe("0.2.16");
  });
});
