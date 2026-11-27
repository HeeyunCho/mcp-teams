import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { SKILLS_EXTENSION_ID, SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Skills over MCP: the built server (dist/) over stdio serves the playbooks in skills/ to a
// 2026-07-28 client, and the same tools as before to a 2025 one.
const SKILLS = ["catch-up", "meeting-recap", "troubleshoot"];
const home = mkdtempSync(join(tmpdir(), "mcp-teams-skills-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", port: 0 }));

const connect = async (pin?: "2026-07-28") => {
  const client = new Client({ name: "test", version: "0" }, pin ? { versionNegotiation: { mode: { pin } } } : undefined);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, TEAMS_MCP_HOME: home } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  return client;
};

describe("skills over MCP, on a 2026-07-28 connection", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("2026-07-28");
  }, 20_000);
  afterAll(async () => {
    await client?.close();
  });

  it("declares the skills extension", () => {
    expect(client.getProtocolEra()).toBe("modern");
    expect((client.getServerCapabilities() as any)?.extensions?.[SKILLS_EXTENSION_ID]).toBeDefined();
  });

  it("lists the three skills, each with a name and a description", async () => {
    const { skills } = await new SkillsClient(client).list();
    expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(SKILLS);
    for (const s of skills) {
      expect(s.uri).toBe(`skill://${s.frontmatter.name}/SKILL.md`);
      expect(String(s.frontmatter.description).length).toBeGreaterThan(40);
    }
  });

  it("reads each SKILL.md, checked against its published digest", async () => {
    const skillsClient = new SkillsClient(client);
    for (const s of (await skillsClient.list()).skills) {
      const file = await skillsClient.read(s);
      expect(file.verified).toBe(true);
      expect(file.text).toMatch(/^---\nname: /);
    }
  });

  it("names only tools and arguments the server has", async () => {
    // Words in backticks that look like a tool or an argument (snake_case) must be one of them,
    // so a renamed tool or argument can't leave a skill pointing at something gone.
    const { tools } = await client.listTools();
    const known = new Set(tools.flatMap((t) => [t.name, ...Object.keys((t.inputSchema as any).properties ?? {})]));
    const skillsClient = new SkillsClient(client);
    for (const s of (await skillsClient.list()).skills) {
      const text = (await skillsClient.read(s)).text ?? "";
      const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)(?::[^`]*)?`/g)].map((m) => m[1]);
      expect(named.filter((n) => !known.has(n)), s.frontmatter.name).toEqual([]);
    }
  });

  it("still serves the tools", async () => {
    const r: any = await client.callTool({ name: "get_version", arguments: {} });
    expect(JSON.parse(r.content[0].text).server).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("a 2025 connection", () => {
  it("gets the tools as before", async () => {
    const client = await connect();
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_message");
    } finally {
      await client.close();
    }
  }, 20_000);
});
