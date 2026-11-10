// The repo's own .gitattributes checks text files out with LF everywhere, so a Windows checkout
// (CI's test-windows, or a clone without a global eol setting) reads the same source text as
// Linux. Tests that read source text (lostCall.test.ts, extension.test.ts) depend on it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let empty: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-teams-attrs-"));
  empty = join(dir, "attributes");
  writeFileSync(empty, "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `git check-attr` as the repo alone says it: the user's global attributes file is replaced by an
 * empty one and the system one is ignored. (A repo-local `.git/info/attributes` can't be switched off.)
 */
function repoAttr(attr: string, path: string): string {
  const out = execFileSync("git", ["-c", `core.attributesFile=${empty}`, "check-attr", attr, "--", path], {
    encoding: "utf8",
    env: { ...process.env, GIT_ATTR_NOSYSTEM: "1" },
  });
  return out.trim().split(": ").pop() ?? "";
}

describe("line endings", () => {
  it.each(["src/bridge.ts", "extension/background.js", "test/integration/lostCall.test.ts", "docs/testing.md"])(
    "%s is checked out with LF by the repo's own attributes",
    (path) => {
      expect(repoAttr("eol", path)).toBe("lf");
      expect(repoAttr("text", path)).toBe("auto");
    },
  );
});
