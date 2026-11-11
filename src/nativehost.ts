/**
 * The native host's registration (#123 PR 4, ADR 0001): for each browser found, a host manifest
 * naming a host launcher that starts the Node that ran setup with this copy's dist/hub.js
 * (decision 4; the launcher of ADR 0002 replaces this in 0.5.0). macOS and Linux read the manifest
 * from a NativeMessagingHosts folder per browser, with the host launcher next to it; Windows reads
 * one manifest in %LOCALAPPDATA%\mcp-teams through an HKCU key per browser. Chrome then starts the
 * host only for our extension (allowed_origins).
 *
 * Ported from mcp-newoutlook src/nativehost.ts (commit 7c48bce), without the launcher entry
 * (launch.cjs hub) and refreshNativeHosts; batPath with the .bat fixes of 302a2d6 and ace7f02.
 * New here: hostNodeCheck, which reports a registration whose Node has gone (decision 11).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ORIGIN } from "./extension.js";

export const HOST_NAME = "com.mcp_teams.hub";
const MANIFEST_FILE = `${HOST_NAME}.json`;
/** The host entry built next to this file. */
export const HUB_SCRIPT = fileURLToPath(new URL("./hub.js", import.meta.url));

export type HostBrowser = "Chrome" | "Chromium" | "Edge";

/** Where to look and what to write; each defaults to this computer (tests pass temporary ones). */
export interface NativeHostOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** The Node the host launcher starts (default: the one running now, which ran setup). */
  node?: string;
  /** The dist/hub.js it runs (default: this copy's). */
  hubScript?: string;
  /** Runs `reg` with these arguments (Windows). */
  reg?: (args: string[]) => void;
}

interface Target {
  browser: HostBrowser;
  /** The browser counts as found when this folder (its user data) exists (decision 3). */
  profileDir: string;
  /** Where the manifest and host launcher go. */
  dir: string;
  registryKey?: string;
}

export interface HostInstall {
  browser: HostBrowser;
  manifest: string;
  hostLauncher: string;
  registryKey?: string;
  /** Whether a file or the registry was written (false: all already up to date). */
  changed: boolean;
  /** The Node the host launcher named before, which no longer exists (nvm, fnm: decision 11). */
  nodeWasMissing?: string;
}

/** A registration found on this computer, and whether the Node its host launcher starts is still there. */
export interface RegisteredHost {
  browser: HostBrowser;
  /** null: the host launcher names no Node this code can read back (edited by hand). */
  node: string | null;
  nodeExists: boolean | null;
}

export interface InstallResult {
  installed: HostInstall[];
  /** Browsers whose registration failed, and why. */
  failed?: { browser: HostBrowser; error: string }[];
  /** dist/hub.js isn't there (not built): nothing was written. */
  missingHub?: true;
  /** A path the .bat can't hold (decision 11): nothing was written. */
  nonAsciiPath?: string;
}

/** A string in double quotes for /bin/sh: \, ", $ and ` escaped. */
const shQuote = (s: string) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;

/** The folders a .bat may name through their variables, which cmd expands when it runs. */
export type BatEnv = { USERPROFILE?: string; LOCALAPPDATA?: string; APPDATA?: string };

/** A path a .bat can't hold: non-ASCII left over that no folder variable covers. */
export class NonAsciiBatPathError extends Error {
  constructor(readonly path: string) {
    super(`path has characters cmd.exe can't read: ${path}`);
    this.name = "NonAsciiBatPathError";
  }
}

const BAT_FOLDERS = ["USERPROFILE", "LOCALAPPDATA", "APPDATA"] as const;

/**
 * A path in double quotes for a .bat file. cmd.exe reads a .bat in the OEM code page (949 on
 * Korean Windows), not UTF-8, so a home like C:\Users\홍길동 written into it comes out garbled.
 * The longest of %LOCALAPPDATA%, %APPDATA% and %USERPROFILE% the path is in (case-insensitive)
 * is named by its variable instead; cmd expands it to the real, Unicode path when it runs. The
 * rest has % doubled, so cmd doesn't expand it as a variable. Throws NonAsciiBatPathError when
 * non-ASCII is left: such a path can't be written in a .bat at all.
 */
export function batPath(path: string, env: BatEnv = process.env): string {
  // cmd wants backslashes; a path may come with forward slashes (or from a POSIX join in tests).
  const p = path.replace(/\//g, "\\");
  let best: { name: string; length: number } | undefined;
  for (const name of BAT_FOLDERS) {
    const dir = env[name]?.replace(/\//g, "\\").replace(/\\+$/, "");
    if (!dir || p.length < dir.length || p.slice(0, dir.length).toLowerCase() !== dir.toLowerCase()) continue;
    // A whole folder only: C:\Users\ana is not in C:\Users\an.
    if (p.length > dir.length && p[dir.length] !== "\\") continue;
    if (!best || dir.length > best.length) best = { name, length: dir.length };
  }
  const rest = best ? p.slice(best.length) : p;
  if (!/^[\x20-\x7e]*$/.test(rest)) throw new NonAsciiBatPathError(path);
  return `"${best ? `%${best.name}%` : ""}${rest.replace(/%/g, "%%")}"`;
}

/**
 * The host launcher's text: starts `node` with dist/hub.js, passing on Chrome's arguments (the
 * caller's origin, and on Windows --parent-window). On Windows the paths go through batPath, with
 * env the variables cmd will expand.
 */
export function hostLauncherScript(platform: NodeJS.Platform, node: string, hubScript: string, env: BatEnv = process.env): string {
  if (platform === "win32") return `@echo off\r\n${batPath(node, env)} ${batPath(hubScript, env)} %*\r\n`;
  return `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(hubScript)} "$@"\n`;
}

/** Where each browser this platform may have reads the host manifest from. */
function targets(home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): Target[] {
  const hosts = (profileDir: string) => join(profileDir, "NativeMessagingHosts");
  const perBrowser = (list: { browser: HostBrowser; profileDir: string }[]) => list.map((t) => ({ ...t, dir: hosts(t.profileDir) }));
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return perBrowser([
      { browser: "Chrome", profileDir: join(support, "Google", "Chrome") },
      { browser: "Edge", profileDir: join(support, "Microsoft Edge") },
    ]);
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const dir = join(local, "mcp-teams");
    const key = (vendor: string) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`;
    return [
      { browser: "Chrome", profileDir: join(local, "Google", "Chrome", "User Data"), dir, registryKey: key("Google\\Chrome") },
      { browser: "Edge", profileDir: join(local, "Microsoft", "Edge", "User Data"), dir, registryKey: key("Microsoft\\Edge") },
    ];
  }
  const config = join(home, ".config");
  return perBrowser([
    { browser: "Chrome", profileDir: join(config, "google-chrome") },
    { browser: "Chromium", profileDir: join(config, "chromium") },
    { browser: "Edge", profileDir: join(config, "microsoft-edge") },
  ]);
}

export function hostManifest(hostLauncher: string): string {
  const manifest = {
    name: HOST_NAME,
    description: "mcp-teams hub: connects the browser extension with the mcp-teams MCP servers",
    path: hostLauncher,
    type: "stdio",
    allowed_origins: [`${EXTENSION_ORIGIN}/`],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Writes `text` unless the file already holds it; returns whether it wrote. */
function writeIfChanged(path: string, text: string, mode?: number): boolean {
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  if (!same) writeFileSync(path, text, mode === undefined ? undefined : { mode });
  // Also when unchanged: a host launcher must stay executable for its owner only.
  if (mode !== undefined) chmodSync(path, mode);
  return !same;
}

const defaultReg = (args: string[]) => void execFileSync("reg", args, { stdio: "ignore", windowsHide: true });

const hostLauncherName = (platform: NodeJS.Platform) => (platform === "win32" ? "mcp-teams-hub.bat" : "mcp-teams-hub");

/**
 * The Node a host launcher starts, read back from its text (hostLauncherScript's output); null if
 * it names none in that form. A .bat's folder variables are expanded with env and its doubled %
 * undone, as cmd would; a POSIX one has its shell escapes undone.
 */
export function launcherNode(text: string, platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env): string | null {
  if (platform === "win32") {
    const quoted = /^@echo off\r?\n"([^"]*)"/.exec(text)?.[1];
    if (quoted === undefined) return null;
    return quoted.replace(/%%|%(\w+)%/g, (m, name?: string) => (name === undefined ? "%" : (BAT_FOLDERS as readonly string[]).includes(name) && env[name] ? env[name].replace(/\//g, "\\").replace(/\\+$/, "") : m));
  }
  const quoted = /^#!\/bin\/sh\nexec "((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  return quoted === undefined ? null : quoted.replace(/\\(.)/g, "$1");
}

const resolveOptions = (o: NativeHostOptions) => ({
  home: o.home ?? homedir(),
  platform: o.platform ?? process.platform,
  env: o.env ?? process.env,
});

/** What each registration's host launcher (for each browser found) names as its Node. */
function readRegistrations(home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): (RegisteredHost & { target: Target })[] {
  const found: (RegisteredHost & { target: Target })[] = [];
  for (const target of targets(home, platform, env)) {
    if (!existsSync(target.profileDir) || !existsSync(join(target.dir, MANIFEST_FILE))) continue;
    let text = "";
    try {
      text = readFileSync(join(target.dir, hostLauncherName(platform)), "utf8");
    } catch {
      // No host launcher: it names no Node.
    }
    const node = launcherNode(text, platform, env);
    found.push({ target, browser: target.browser, node, nodeExists: node === null ? null : existsSync(node) });
  }
  return found;
}

/**
 * The host registrations on this computer and whether each one's Node is still there (decision
 * 11): get_version and setup say "run setup again" when it has gone. Reads files only.
 */
export function registeredHosts(o: Pick<NativeHostOptions, "home" | "platform" | "env"> = {}): RegisteredHost[] {
  const { home, platform, env } = resolveOptions(o);
  return readRegistrations(home, platform, env).map(({ browser, node, nodeExists }) => ({ browser, node, nodeExists }));
}

/** Registers the host for every browser whose profile folder exists (setup). */
export function installNativeHost(o: NativeHostOptions = {}): InstallResult {
  const { home, platform, env } = resolveOptions(o);
  const node = o.node ?? process.execPath;
  const hubScript = o.hubScript ?? HUB_SCRIPT;
  const reg = o.reg ?? defaultReg;
  if (!existsSync(hubScript)) return { installed: [], missingHub: true };
  const gone = new Map(readRegistrations(home, platform, env).flatMap((r) => (r.node !== null && r.nodeExists === false ? [[r.browser, r.node] as const] : [])));
  const found = targets(home, platform, env).filter((t) => existsSync(t.profileDir));
  if (!found.length) return { installed: [] };
  let script: string;
  try {
    script = hostLauncherScript(platform, node, hubScript, env);
  } catch (err) {
    // A path the .bat can't hold: nothing is written, and the extension keeps the TCP port.
    if (err instanceof NonAsciiBatPathError) return { installed: [], nonAsciiPath: err.path };
    throw err;
  }
  const result: InstallResult = { installed: [] };
  for (const t of found) {
    const manifest = join(t.dir, MANIFEST_FILE);
    const hostLauncher = join(t.dir, hostLauncherName(platform));
    try {
      mkdirSync(t.dir, { recursive: true });
      let changed = writeIfChanged(hostLauncher, script, platform === "win32" ? undefined : 0o700);
      changed = writeIfChanged(manifest, hostManifest(hostLauncher)) || changed;
      if (t.registryKey) {
        reg(["add", t.registryKey, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"]);
        changed = true;
      }
      const was = gone.get(t.browser);
      result.installed.push({
        browser: t.browser,
        manifest,
        hostLauncher,
        ...(t.registryKey ? { registryKey: t.registryKey } : {}),
        changed,
        ...(was !== undefined ? { nodeWasMissing: was } : {}),
      });
    } catch (err) {
      (result.failed ??= []).push({ browser: t.browser, error: (err as Error).message });
    }
  }
  return result;
}
