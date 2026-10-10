import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const SERVER_VERSION: string = pkg.version;

export interface Config {
  port: number;
  token: string;
}

export const CONFIG_DIR = process.env.TEAMS_MCP_HOME ?? join(homedir(), ".mcp-teams");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** Loads ~/.mcp-teams/config.json, creating it (with a fresh pairing token) on first run. */
export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  }
  if (!stored.token) {
    stored.token = randomBytes(24).toString("base64url");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  return {
    port: Number(process.env.TEAMS_MCP_PORT ?? stored.port ?? 47393),
    token: stored.token,
  };
}

export const CONFIG_PATH = CONFIG_FILE;
