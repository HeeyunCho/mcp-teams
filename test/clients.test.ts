import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, knownClients, planClients, upsertCodexToml, upsertJson } from "../src/clients.js";

const cmd = { command: "/usr/local/bin/node", args: ["/opt/mcp-teams/dist/index.js"] };

describe("upsertJson", () => {
  it("creates a config file that doesn't exist yet", () => {
    const r = upsertJson(null, "mcpServers", cmd);
    expect(r.status).toBe("added");
    expect(JSON.parse(r.text!)).toEqual({ mcpServers: { teams: cmd } });
  });

  it("adds our entry and keeps everything else (shape as in Gemini's settings.json)", () => {
    const text = JSON.stringify({ ui: { theme: "dark" }, mcpServers: { notion: { command: "npx", args: ["notion"], trust: true } } });
    const r = upsertJson(text, "mcpServers", cmd);
    expect(r.status).toBe("added");
    expect(JSON.parse(r.text!)).toEqual({
      ui: { theme: "dark" },
      mcpServers: { notion: { command: "npx", args: ["notion"], trust: true }, teams: cmd },
    });
  });

  it("adds an mcpServers section where there is none (Claude Desktop)", () => {
    const r = upsertJson(JSON.stringify({ preferences: { a: 1 } }), "mcpServers", cmd);
    expect(JSON.parse(r.text!)).toEqual({ preferences: { a: 1 }, mcpServers: { teams: cmd } });
  });

  it("uses VS Code's 'servers' with type stdio", () => {
    const r = upsertJson(JSON.stringify({ servers: {} }), "servers", { type: "stdio", ...cmd });
    expect(JSON.parse(r.text!).servers.teams).toEqual({ type: "stdio", ...cmd });
  });

  it("leaves an up-to-date entry alone, updates an old copy of ours and keeps fields added to it", () => {
    const same = JSON.stringify({ mcpServers: { teams: { ...cmd, trust: true } } });
    expect(upsertJson(same, "mcpServers", cmd)).toEqual({ status: "unchanged" });
    const old = JSON.stringify({ mcpServers: { teams: { command: "node", args: ["/old/mcp-teams/dist/index.js"], trust: true } } });
    const r = upsertJson(old, "mcpServers", cmd);
    expect(r.status).toBe("updated");
    expect(JSON.parse(r.text!).mcpServers.teams).toEqual({ ...cmd, trust: true });
  });

  it("never touches someone else's 'teams' or a file it can't parse", () => {
    expect(upsertJson(JSON.stringify({ mcpServers: { teams: { command: "other-tool" } } }), "mcpServers", cmd)).toEqual({ status: "foreign" });
    expect(upsertJson("{ // comments\n}", "mcpServers", cmd)).toEqual({ status: "unreadable" });
    expect(upsertJson("[]", "mcpServers", cmd)).toEqual({ status: "unreadable" });
  });
});

describe("upsertCodexToml", () => {
  const table = '[mcp_servers.teams]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/mcp-teams/dist/index.js"]\n';

  it("appends our table, then leaves it alone", () => {
    const text = 'model = "o4"\n\n[mcp_servers.web-mcp]\ncommand = "web"\n';
    const r = upsertCodexToml(text, cmd);
    expect(r).toEqual({ status: "added", text: `${text}\n${table}` });
    expect(upsertCodexToml(r.text!, cmd)).toEqual({ status: "unchanged" });
    expect(upsertCodexToml(null, cmd)).toEqual({ status: "added", text: table });
  });

  it("updates an old copy of ours and keeps the tables after it", () => {
    const text = '[mcp_servers.teams]\ncommand = "node"\nargs = ["/old/mcp-teams/dist/index.js"]\n\n[desktop]\nx = 1\n';
    expect(upsertCodexToml(text, cmd)).toEqual({ status: "updated", text: `${table}\n[desktop]\nx = 1\n` });
  });

  it("escapes Windows paths and leaves someone else's table alone", () => {
    const win = upsertCodexToml(null, { command: "C:\\node\\node.exe", args: ["C:\\mcp-teams\\dist\\index.js"] });
    expect(win.text).toContain('command = "C:\\\\node\\\\node.exe"');
    expect(upsertCodexToml('[mcp_servers.teams]\ncommand = "other"\n', cmd)).toEqual({ status: "foreign" });
  });
});

describe("knownClients and planClients", () => {
  it("knows where each app keeps its config on each platform", () => {
    const mac = Object.fromEntries(knownClients("/Users/a", "darwin", {}).map((c) => [c.name, join(c.dir, c.file)]));
    expect(mac["Claude Desktop"]).toBe("/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
    expect(mac["VS Code"]).toBe("/Users/a/Library/Application Support/Code/User/mcp.json");
    expect(mac.Codex).toBe("/Users/a/.codex/config.toml");
    const win = Object.fromEntries(knownClients("C:/Users/a", "win32", { APPDATA: "C:/Users/a/AppData/Roaming" }).map((c) => [c.name, c.dir]));
    expect(win["Claude Desktop"]).toBe(join("C:/Users/a/AppData/Roaming", "Claude"));
  });

  it("plans only for installed apps, and applying keeps a backup", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-teams-home-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { rigour: { command: "r", args: [] } } }));
    mkdirSync(join(home, ".codex"));
    const plans = planClients(cmd, knownClients(home, "linux", {}));
    expect(plans.map((p) => [p.client.name, p.status])).toEqual([["Cursor", "added"], ["Codex", "added"]]);
    for (const p of plans) applyPlan(p);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({ rigour: { command: "r", args: [] }, teams: cmd });
    expect(existsSync(join(home, ".cursor", "mcp.json.mcp-teams.bak"))).toBe(true);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.teams]");
    expect(planClients(cmd, knownClients(home, "linux", {})).map((p) => p.status)).toEqual(["unchanged", "unchanged"]);
  });
});

describe("serverCommand", () => {
  it("registers npx for a copy installed from npm, and this copy otherwise", async () => {
    const { serverCommand, NPX_COMMAND } = await import("../src/setup.js");
    const { sep, join } = await import("node:path");
    const npm = join(sep, "home", "u", ".npm", "_npx", "abc", "node_modules", "mcp-teams", "dist", "index.js");
    expect(serverCommand(npm)).toEqual(NPX_COMMAND);
    const clone = join(sep, "home", "u", "mcp-teams", "dist", "index.js");
    expect(serverCommand(clone)).toEqual({ command: process.execPath, args: [clone] });
  });
});
