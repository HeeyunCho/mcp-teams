/**
 * The local AI apps mcp-teams can be registered with, and the edits to their config
 * files. Only our own "teams" entry is ever added or changed: an entry of that name
 * that runs something else, or a file that isn't plain JSON/TOML we understand, is left
 * alone. Web-only AIs (ChatGPT, claude.ai) can't reach a local server and aren't listed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerCommand {
  command: string;
  args: string[];
}

export type Status = "added" | "updated" | "unchanged" | "foreign" | "unreadable";

export interface Client {
  name: string;
  /** The app counts as installed when this folder exists. */
  dir: string;
  file: string;
  format: "json" | "toml";
  /** JSON: the object holding the servers. */
  section?: "mcpServers" | "servers";
  /** JSON: extra fields the app wants on an entry. */
  extra?: Record<string, string>;
}

const NAME = "teams";
/** An entry is ours when it runs mcp-teams (any version, any path). */
const isOurs = (entry: unknown) => JSON.stringify(entry ?? "").includes("mcp-teams");

/** Adds or updates our entry in a JSON config; text is null for a file that doesn't exist yet. */
export function upsertJson(
  text: string | null,
  section: "mcpServers" | "servers",
  entry: ServerCommand & Record<string, unknown>,
): { status: Status; text?: string } {
  let doc: Record<string, any> = {};
  if (text?.trim()) {
    try {
      doc = JSON.parse(text);
    } catch {
      return { status: "unreadable" };
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { status: "unreadable" };
  }
  const servers = doc[section] ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) return { status: "unreadable" };
  const current = servers[NAME];
  if (current !== undefined && !isOurs(current)) return { status: "foreign" };
  const same =
    current && Object.entries(entry).every(([k, v]) => JSON.stringify(current[k]) === JSON.stringify(v));
  if (same) return { status: "unchanged" };
  // Fields the user added to our entry (e.g. Gemini's "trust") are kept.
  doc[section] = { ...servers, [NAME]: { ...(current ?? {}), ...entry } };
  return { status: current ? "updated" : "added", text: `${JSON.stringify(doc, null, 2)}\n` };
}

const tomlString = (s: string) => JSON.stringify(s); // TOML basic strings escape like JSON

/** Adds or updates our [mcp_servers.teams] table in Codex's config.toml. */
export function upsertCodexToml(text: string | null, cmd: ServerCommand): { status: Status; text?: string } {
  const t = text ?? "";
  const table = `[mcp_servers.${NAME}]\ncommand = ${tomlString(cmd.command)}\nargs = [${cmd.args.map(tomlString).join(", ")}]\n`;
  const header = new RegExp(`^\\[mcp_servers\\.${NAME}\\][ \\t]*$`, "m").exec(t);
  if (!header) {
    const sep = !t ? "" : t.endsWith("\n\n") ? "" : t.endsWith("\n") ? "\n" : "\n\n";
    return { status: "added", text: `${t}${sep}${table}` };
  }
  const bodyStart = header.index + header[0].length;
  const next = t.slice(bodyStart).search(/^\[/m); // the next table (including our own subtables)
  const end = next === -1 ? t.length : bodyStart + next;
  const current = t.slice(header.index, end);
  if (!isOurs(current)) return { status: "foreign" };
  if (current.trim() === table.trim()) return { status: "unchanged" };
  return { status: "updated", text: `${t.slice(0, header.index)}${table}${end < t.length ? "\n" : ""}${t.slice(end)}` };
}

/** The AI apps with a config file we know, for this platform. */
export function knownClients(home = homedir(), platform = process.platform, env = process.env): Client[] {
  const appData =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
        : join(home, ".config");
  return [
    { name: "Claude Desktop", dir: join(appData, "Claude"), file: "claude_desktop_config.json", format: "json", section: "mcpServers" },
    { name: "Cursor", dir: join(home, ".cursor"), file: "mcp.json", format: "json", section: "mcpServers" },
    { name: "VS Code", dir: join(appData, "Code", "User"), file: "mcp.json", format: "json", section: "servers", extra: { type: "stdio" } },
    { name: "Windsurf", dir: join(home, ".codeium", "windsurf"), file: "mcp_config.json", format: "json", section: "mcpServers" },
    { name: "Gemini CLI", dir: join(home, ".gemini"), file: "settings.json", format: "json", section: "mcpServers" },
    { name: "Codex", dir: join(home, ".codex"), file: "config.toml", format: "toml" },
  ];
}

export interface Plan {
  client: Client;
  path: string;
  status: Status;
  text?: string;
}

/** What registering would do in each installed app; nothing is written. */
export function planClients(cmd: ServerCommand, clients = knownClients()): Plan[] {
  return clients
    .filter((c) => existsSync(c.dir))
    .map((client) => {
      const path = join(client.dir, client.file);
      const text = existsSync(path) ? readFileSync(path, "utf8") : null;
      const r =
        client.format === "toml"
          ? upsertCodexToml(text, cmd)
          : upsertJson(text, client.section!, { ...(client.extra ?? {}), ...cmd });
      return { client, path, ...r };
    });
}

/** Writes a planned change, after keeping a copy of the file as it was. */
export function applyPlan(plan: Plan) {
  if (!plan.text) return;
  mkdirSync(dirname(plan.path), { recursive: true });
  if (existsSync(plan.path)) copyFileSync(plan.path, `${plan.path}.mcp-teams.bak`);
  writeFileSync(plan.path, plan.text);
}
