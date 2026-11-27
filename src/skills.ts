import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";

/**
 * Skills over MCP (io.modelcontextprotocol/skills, MCP 2026-07-28): playbooks for the Teams tools that
 * ship in the package's skills/ folder, one folder per skill with its SKILL.md. Clients that support
 * the extension list them (Claude Code shows them as /<server>:<skill>, e.g. /teams:meeting-recap) and
 * load one only when it is used; older (2025) clients never see them (see attachSkills).
 */
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

type Catalog = Awaited<ReturnType<typeof loadSkills>>;
type Warn = (message: string) => void;

/**
 * Loads the skills under `root`, or null when they can't be loaded: the tools work without them, so a
 * broken or missing folder never stops the server. A skill with a problem (its name differs from its
 * folder, a symlink in it) is left out with a warning, and the others still serve.
 */
export async function loadTeamsSkills(root: string = SKILLS_DIR, warn: Warn = (m) => console.error(m)): Promise<Catalog | null> {
  try {
    return await loadSkills(root, { onWarning: (w) => warn(`[mcp-teams] skill ${w.path}: ${w.message}`) });
  } catch (err) {
    warn(`[mcp-teams] skills not loaded: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Serves `catalog` on `server` (before it connects), but only on a modern (2026-07-28) connection:
 * the skills extension needs that revision, and a 2025 client keeps exactly the tools it had, with no
 * resources capability and no skill:// resources. `era` is what serveStdio hands its factory.
 * Nothing with no catalog.
 */
export function attachSkills(server: McpServer, catalog: Catalog | null, era: "legacy" | "modern"): void {
  if (era === "modern") catalog?.attach(server);
}
