/**
 * `mcp-teams setup`: everything installation needs, in one command that can be run
 * again at any time. It registers the server with the local AI apps (after asking),
 * installs the extension folder, walks the user through the one manual step per browser
 * (Load unpacked) and waits until Teams answers.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionBridge } from "./bridge.js";
import { applyPlan, planClients, type Plan, type ServerCommand } from "./clients.js";
import { EXTENSION_ORIGIN, installedVersion, syncExtension, writePairing } from "./extension.js";
import { loadConfig } from "./config.js";

const SERVER_SCRIPT = fileURLToPath(new URL("./index.js", import.meta.url));
const EXTENSION_WAIT_MS = 10 * 60_000;
const TEAMS_WAIT_MS = 120_000;

const ok = (text: string) => console.log(`✓ ${text}`);
const todo = (text: string) => console.log(`→ ${text}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/** The package from npm, always the latest release (npx keeps it cached). */
export const NPX_COMMAND: ServerCommand = { command: "npx", args: ["-y", "mcp-teams@latest"] };

/**
 * How AI apps start this server. Installed from npm (`npx mcp-teams setup`, or a
 * global install): through npx, so every start gets the latest release. A clone (a
 * developer copy): this Node and this copy.
 */
export const serverCommand = (script = SERVER_SCRIPT): ServerCommand =>
  script.includes(`${sep}node_modules${sep}`) ? NPX_COMMAND : { command: process.execPath, args: [script] };

// ------------------------------------------------------------------ AI apps

interface ClaudeCode {
  status: "unchanged" | "added" | "updated" | "foreign";
  scope?: string;
}

/** Claude Code is configured through its CLI. */
function planClaudeCode(cmd: ServerCommand): ClaudeCode | null {
  let out: string;
  try {
    out = execFileSync("claude", ["mcp", "get", "teams"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : { status: "added" };
  }
  if (out.includes(cmd.command) && cmd.args.every((a) => out.includes(a))) return { status: "unchanged" };
  if (!out.includes("mcp-teams")) return { status: "foreign" };
  // Ours, from another copy or version: replace it in the same scope.
  const scope = /Scope:\s*(\w+)/i.exec(out)?.[1]?.toLowerCase();
  return { status: "updated", scope: scope === "user" || scope === "local" || scope === "project" ? scope : "user" };
}

function applyClaudeCode(plan: ClaudeCode, cmd: ServerCommand) {
  const scope = plan.scope ?? "user";
  if (plan.status === "updated") execFileSync("claude", ["mcp", "remove", "teams", "-s", scope], { stdio: "ignore" });
  execFileSync("claude", ["mcp", "add", "--scope", scope, "teams", "--", cmd.command, ...cmd.args], { stdio: "ignore" });
}

const STATUS_TEXT: Record<string, string> = {
  added: "will add",
  updated: "will update",
  unchanged: "registered",
  foreign: 'has another "teams" server: left alone',
  unreadable: "config file not plain JSON: left alone (add it by hand)",
};

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    todo("Not asked (no terminal). Run setup in a terminal, or with --yes, to make these changes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Shows what registering would change in each AI app, asks once, then does it. */
async function registerApps(yes: boolean) {
  const cmd = serverCommand();
  const claudeCode = planClaudeCode(cmd);
  const plans: Plan[] = planClients(cmd);
  console.log("AI apps on this computer:");
  if (claudeCode) console.log(`  ${"Claude Code".padEnd(15)} ${STATUS_TEXT[claudeCode.status]}`);
  for (const p of plans) console.log(`  ${p.client.name.padEnd(15)} ${STATUS_TEXT[p.status]}`);
  if (!claudeCode && !plans.length) {
    todo(`No AI app found. Register this stdio server with yours: ${[cmd.command, ...cmd.args].map(quote).join(" ")}`);
    return;
  }
  const changes = plans.filter((p) => p.text);
  const claudeChange = claudeCode && (claudeCode.status === "added" || claudeCode.status === "updated");
  if (!changes.length && !claudeChange) {
    ok("Registered with every AI app found");
    return;
  }
  if (!(await confirm("Add mcp-teams to these apps?", yes))) return;
  const done: string[] = [];
  if (claudeChange) {
    try {
      applyClaudeCode(claudeCode, cmd);
      done.push("Claude Code");
    } catch (err) {
      todo(`Claude Code: ${(err as Error).message}`);
    }
  }
  for (const p of changes) {
    try {
      applyPlan(p);
      done.push(p.client.name);
    } catch (err) {
      todo(`${p.client.name}: ${(err as Error).message}`);
    }
  }
  if (done.length) ok(`Registered with ${done.join(", ")}. Restart those apps (in Claude Code: /mcp) to load it.`);
}

// ------------------------------------------------------------------ browsers

interface Browser {
  name: "Chrome" | "Edge";
  page: string;
  /** Where Developer mode is on that page. */
  devMode: string;
}

/** Chrome and Edge, if installed. */
function installedBrowsers(): Browser[] {
  const chrome: Browser = { name: "Chrome", page: "chrome://extensions", devMode: "top right" };
  const edge: Browser = { name: "Edge", page: "edge://extensions", devMode: "in the left sidebar" };
  const has = (paths: string[]) => paths.some((p) => p && existsSync(p));
  const which = (bin: string) => {
    try {
      execFileSync("which", [bin], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin") {
    return [
      has(["/Applications/Google Chrome.app", join(process.env.HOME ?? "", "Applications/Google Chrome.app")]) && chrome,
      has(["/Applications/Microsoft Edge.app", join(process.env.HOME ?? "", "Applications/Microsoft Edge.app")]) && edge,
    ].filter((b): b is Browser => !!b);
  }
  if (process.platform === "win32") {
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      has(pf.map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"))) && chrome,
      has(pf.map((d) => join(d, "Microsoft", "Edge", "Application", "msedge.exe"))) && edge,
    ].filter((b): b is Browser => !!b);
  }
  return [
    (which("google-chrome") || which("google-chrome-stable") || which("chromium")) && chrome,
    (which("microsoft-edge") || which("microsoft-edge-stable")) && edge,
  ].filter((b): b is Browser => !!b);
}

/** Opens a folder, or a browser's internal page in that browser. Best effort. */
function open(target: string, browser?: Browser) {
  const app = browser && { darwin: { Chrome: "Google Chrome", Edge: "Microsoft Edge" }, win32: { Chrome: "chrome", Edge: "msedge" } };
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", browser ? ["-a", app!.darwin[browser.name], target] : [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', ...(browser ? [app!.win32[browser.name]] : []), target]]
        : [browser ? (browser.name === "Edge" ? "microsoft-edge" : "google-chrome") : "xdg-open", [target]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The instructions printed alongside say where to go.
  }
}

const ours = (bridge: ExtensionBridge) => bridge.extensions.filter((e) => e.origin === EXTENSION_ORIGIN);

async function waitFor(cond: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (cond()) return true;
  return cond();
}

/** Installs or updates the extension folder and waits until the extension connects. */
async function connectExtension(bridge: ExtensionBridge, serverVersion: string): Promise<boolean> {
  const { changed, dir } = syncExtension();
  writePairing(loadConfig().token, dir);
  ok(`Extension ${installedVersion(dir)} ${changed ? "installed in" : "up to date in"} ${dir}`);

  // An installed extension connects within seconds (it retries every 30 s).
  await waitFor(() => ours(bridge).length > 0 && bridge.connected, 3_000);
  const browsers = installedBrowsers();
  const connected = () => ours(bridge).map((e) => e.browser ?? "browser");
  if (connected().length) {
    if (changed) {
      const { after } = await bridge.reloadExtension();
      ok(`Extension reloaded (${after})`);
    }
    ok(`Extension connected in ${connected().join(" and ")}`);
    const missing = browsers.filter((b) => !connected().includes(b.name));
    for (const b of missing) {
      todo(`To use Teams in ${b.name} too: in ${b.page}, turn on Developer mode (${b.devMode}) and click Load unpacked: ${dir}`);
    }
    return true;
  }

  const targets = browsers.length ? browsers : [{ name: "Chrome", page: "chrome://extensions", devMode: "top right" } as Browser];
  for (const b of targets) open(b.page, b);
  open(dir);
  console.log(`
→ One step in ${targets.map((b) => b.name).join(" or ")} (the browser you use Teams in), on the Extensions page that just opened:
    1. Turn on "Developer mode" (${targets.map((b) => `${b.name}: ${b.devMode}`).join("; ")}).
    2. Click "Load unpacked" and choose this folder (also opened for you):
         ${dir}
    If an older "mcp-teams bridge" is listed, remove it.

  Waiting for the extension…`);
  if (bridge.role === "peer" && bridge.hubVersion !== serverVersion) {
    console.log(`
→ Another AI session runs mcp-teams ${bridge.hubVersion}, which can't connect the new extension.
  Run /mcp in your open Claude Code sessions (or restart those AI apps); setup continues as soon as they do.`);
  }
  if (!(await waitFor(() => ours(bridge).length > 0 && bridge.connected, EXTENSION_WAIT_MS))) {
    console.log("\n✗ The extension did not connect. Run setup again once it is loaded.");
    return false;
  }
  ok(`Extension connected in ${connected().join(" and ")}`);
  return true;
}

// ------------------------------------------------------------------ setup

export async function setup(bridge: ExtensionBridge, serverVersion: string, { yes = false } = {}): Promise<boolean> {
  console.log(`mcp-teams ${serverVersion} setup\n`);
  await registerApps(yes);
  console.log("");
  if (!(await connectExtension(bridge, serverVersion))) return false;

  // Opens Teams in a background tab if none is open, and waits for its session.
  try {
    const { teams } = await bridge.call<{ teams: unknown[] }>("listTeams", {}, TEAMS_WAIT_MS);
    ok(`Teams reachable (${teams.length} teams)`);
  } catch (err) {
    console.log(`\n✗ Teams: ${(err as Error).message}\n  Sign in to Teams in your browser, then run setup again.`);
    return false;
  }

  console.log("\nReady. Ask your AI app about your Teams chats (restart it first if setup just registered it).");
  return true;
}
