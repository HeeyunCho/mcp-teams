import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { describe, expect, it } from "vitest";
import { SKILLS_DIR, loadTeamsSkills } from "../../src/skills.js";

const skillFolder = (root: string, folder: string, name = folder) => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: A test skill that does something useful.\n---\n\n# ${name}\n`);
};

describe("the skills shipped in skills/", () => {
  it("load with no problem, even under strict", async () => {
    const catalog = await loadSkills(SKILLS_DIR, { strict: true });
    expect(catalog.entries.map((s) => s.frontmatter.name)).toEqual(["catch-up", "meeting-recap", "troubleshoot"]);
  });

  it("fit Claude Code's limits: 100 KB a file, 400 KB a skill", async () => {
    const catalog = await loadSkills(SKILLS_DIR, { strict: true });
    for (const s of catalog.entries) {
      const files = s.resources === "dynamic" ? [] : s.resources;
      expect(files.every((f) => f.size <= 100 * 1024)).toBe(true);
      expect(files.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(400 * 1024);
    }
  });
});

describe("loadTeamsSkills", () => {
  it("leaves out a skill whose name differs from its folder, with a warning, and serves the others", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-teams-skills-"));
    skillFolder(root, "good");
    skillFolder(root, "bad", "other-name");
    const warnings: string[] = [];
    const catalog = await loadTeamsSkills(root, (m) => warnings.push(m));
    expect(catalog?.entries.map((s) => s.frontmatter.name)).toEqual(["good"]);
    expect(warnings.join("\n")).toMatch(/\[mcp-teams\] skill .*bad/);
  });

  it("gives null for a folder that isn't there, so the server starts without skills", async () => {
    const warnings: string[] = [];
    expect(await loadTeamsSkills(join(tmpdir(), "mcp-teams-no-such-folder"), (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
