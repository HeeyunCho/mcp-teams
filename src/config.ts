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
  /**
   * Addresses (the user's own email or UPN) that send_message may post to without the
   * confirmation window: only when the message goes to the signed-in user alone, which the
   * extension checks itself. Trimmed and lowercased; empty (the default) keeps the window for
   * every send.
   */
  autoSendTo: string[];
}

export const CONFIG_DIR = process.env.TEAMS_MCP_HOME ?? join(homedir(), ".mcp-teams");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * `autoSendTo` from config.json: a list of email addresses, trimmed, lowercased and without
 * duplicates. Missing (or null) is an empty list. Anything else that isn't a list of addresses
 * is an error, so a mistyped allowlist is noticed rather than quietly ignored.
 */
export function parseAutoSendTo(value: unknown): string[] {
  if (value == null) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`autoSendTo in ${CONFIG_FILE} must be a list of email addresses.`);
  const out: string[] = [];
  for (const v of list) {
    const address = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (!EMAIL.test(address)) throw new Error(`autoSendTo in ${CONFIG_FILE}: ${JSON.stringify(v)} is not an email address.`);
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

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
    autoSendTo: parseAutoSendTo(stored.autoSendTo),
  };
}

export const CONFIG_PATH = CONFIG_FILE;
