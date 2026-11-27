import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { SKILLS_EXTENSION_ID, SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Skills over MCP: the built server (dist/) over stdio serves the playbooks in skills/ to a
// 2026-07-28 client, and the same tools as before to a 2025 one, with no skills and no resources
// (src/index.ts attaches the skills only to the instance serveStdio builds for the modern era).
const SKILLS = ["catch-up", "meeting-recap", "troubleshoot"];

// Result fields the skills name, beyond tools and arguments. Each is checked against what the
// server or the extension returns.
const RESULT_FIELDS = [
  // send_message (src/tools.ts description; extension/background.js): a sent message's time, or
  // time: null with a timeNote when Teams' answer couldn't be read.
  "time",
  "timeNote",
  // list_meetings: external: true for a meeting another organization hosted (extension/teams.js).
  "external",
  // get_version (src/tools.ts): bridge, hint, extensionSupported and missingFeatures (supportOf),
  // restartNeeded (onDisk()), twoCopies, teams (the status read, with accountUnsure, or { error }
  // when the read fails) and the top-level note (noteOf(sessionNote(...))).
  "bridge",
  "hint",
  "extensionSupported",
  "missingFeatures",
  "restartNeeded",
  "twoCopies",
  "teams",
  "accountUnsure",
  "error",
  "note",
];
// Result fields that are passed back as an argument: read_messages' olderCursor as `cursor`,
// read_transcript's continueFrom as `from`, get_meeting's callId as read_transcript's `session`.
const PASSED_AS: Record<string, string> = { olderCursor: "cursor", continueFrom: "from", callId: "session" };

/** The identifiers a line names in backticks: `name`, `name: value`, `a.b: value`, `name: { a, b }`. */
const identifiersIn = (line: string): string[] =>
  [...line.matchAll(/`([^`]+)`/g)].flatMap(([, code]) => {
    if (/:\/\//.test(code) || /^[\w-]+(\.[\w-]+)*\.(com|microsoft)$/.test(code)) return []; // a URL or a host name
    const m = /^([a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*)(?::\s*(.*))?$/.exec(code);
    if (!m) return [];
    const inBraces = /^\{([^}]*)\}$/.exec(m[2]?.trim() ?? "")?.[1].split(",").map((x) => x.trim()) ?? [];
    return [...m[1].split("."), ...inBraces.filter((x) => /^[a-z][A-Za-z0-9_]*$/.test(x))];
  });
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

  it("names only tools, arguments and known result fields", async () => {
    // Every identifier in backticks (`list_chats`, `unread_only: true`, `olderCursor`,
    // `teams.accountUnsure: true`, `teams: { error }`) must be a tool, one of its arguments, a skill
    // or a result field above, so a renamed tool, argument or field can't leave a skill pointing at
    // something gone.
    const { tools } = await client.listTools();
    const fields = [...RESULT_FIELDS, ...Object.keys(PASSED_AS)];
    const known = new Set([...SKILLS, ...fields, ...tools.flatMap((t) => [t.name, ...Object.keys((t.inputSchema as any).properties ?? {})])]);
    const used = new Set<string>();
    const skillsClient = new SkillsClient(client);
    for (const s of (await skillsClient.list()).skills) {
      const text = (await skillsClient.read(s)).text ?? "";
      for (const line of text.split("\n")) {
        const named = identifiersIn(line);
        named.forEach((n) => used.add(n));
        expect(named.filter((n) => !known.has(n)), `${s.frontmatter.name}: ${line}`).toEqual([]);
        // A result field that is passed back as an argument is named together with that argument,
        // so a skill can't tell the AI app to pass the field itself (read_messages has no olderCursor).
        for (const [field, arg] of Object.entries(PASSED_AS)) {
          if (named.includes(field)) expect(named, `${s.frontmatter.name}: \`${field}\` without \`${arg}\`: ${line}`).toContain(arg);
        }
      }
    }
    // The allowlist stays small: every entry is one a skill names.
    expect(fields.filter((f) => !used.has(f))).toEqual([]);
  });

  it("still serves the tools", async () => {
    const r: any = await client.callTool({ name: "get_version", arguments: {} });
    expect(JSON.parse(r.content[0].text).server).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("a 2025 connection", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  }, 20_000);
  afterAll(async () => {
    await client?.close();
  });

  it("gets the tools as before", async () => {
    expect(client.getProtocolEra()).toBe("legacy");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_message");
  });

  it("is not offered the skills: no skills extension, no resources", () => {
    const caps = client.getServerCapabilities() as any;
    expect(caps?.extensions?.[SKILLS_EXTENSION_ID]).toBeUndefined();
    expect(caps?.resources).toBeUndefined();
  });

  it("finds no SKILL.md and no skill:// template among resources", async () => {
    // With no resources capability the request may be refused (counted as an empty list); if it is
    // answered, it must list nothing.
    const listed = await client.listResources().then(
      (r) => r.resources.map((x) => x.uri),
      () => [],
    );
    expect(listed).toEqual([]);
    const templates = await client.listResourceTemplates().then(
      (r) => r.resourceTemplates.map((x) => x.uriTemplate),
      () => [],
    );
    expect(templates.filter((t) => t.startsWith("skill://"))).toEqual([]);
  });
});
