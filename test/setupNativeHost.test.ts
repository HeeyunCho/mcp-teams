// #123 PR 4: setup registers the native host when config.json says "nativeHost": true, and says
// what it did. Off (the default until PR 5), setup does exactly what it did before: no host
// manifest, no registry key, no line about it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBridge } from "../src/bridge.js";
import { EXTENSION_ORIGIN } from "../src/extension.js";
import { describeNativeHost, setup } from "../src/setup.js";

// Doubles at the edges: no `claude` CLI or `reg` is run, and no AI app's config, extension folder
// or mcp-teams config is read or written. The home is a temporary folder.
const doubles = vi.hoisted(() => ({ execFileSync: vi.fn(), planClients: vi.fn(), syncExtension: vi.fn(), nativeHost: false }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: doubles.execFileSync,
}));
vi.mock("../src/clients.js", async (original) => ({
  ...(await original<typeof import("../src/clients.js")>()),
  planClients: doubles.planClients,
}));
vi.mock("../src/extension.js", async (original) => ({
  ...(await original<typeof import("../src/extension.js")>()),
  syncExtension: doubles.syncExtension,
  writePairing: vi.fn(),
  installedVersion: () => "0.0.0",
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  loadConfig: () => ({ token: "fake-token", nativeHost: doubles.nativeHost }),
}));

describe("#123: describeNativeHost (what setup says)", () => {
  const NODE = "C:\\nodejs\\node.exe";
  const install = { browser: "Chrome" as const, manifest: "C:\\x\\com.mcp_teams.hub.json", hostLauncher: "C:\\x\\mcp-teams-hub.bat", registryKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mcp_teams.hub" };

  it("#123: one line per browser registered or already up to date, naming the registry key (or the manifest)", () => {
    expect(
      describeNativeHost({ installed: [{ ...install, changed: true }, { browser: "Edge", manifest: "/m.json", hostLauncher: "/h", changed: false }] }, NODE),
    ).toEqual({ ok: [`Native host registered for Chrome: ${install.registryKey}`, "Native host up to date for Edge: /m.json"], todo: [] });
  });

  it("#123: says when the Node a registration started had gone (nvm, fnm), and which one it starts now", () => {
    expect(describeNativeHost({ installed: [{ ...install, changed: true, nodeWasMissing: "C:\\old\\node.exe" }] }, NODE)).toEqual({
      ok: [`Native host registered for Chrome: ${install.registryKey} (it started C:\\old\\node.exe, which no longer exists; now ${NODE})`],
      todo: [],
    });
  });

  it("#123: says when the hub.js a registration ran had gone (a pruned npx cache, a moved clone)", () => {
    expect(describeNativeHost({ installed: [{ ...install, changed: true, hubWasMissing: "C:\\old\\dist\\hub.js" }] }, NODE).ok).toEqual([
      `Native host registered for Chrome: ${install.registryKey} (it ran C:\\old\\dist\\hub.js, which no longer exists)`,
    ]);
  });

  it("#123: a path a .bat can't hold: nothing registered, and the extension uses the port", () => {
    expect(describeNativeHost({ installed: [], nonAsciiPath: "D:\\도구\\node.exe" }, NODE)).toEqual({
      ok: [],
      todo: ["Native host not registered: D:\\도구\\node.exe has characters a Windows .bat can't hold. The extension uses the local port."],
    });
  });

  it("#123: dist/hub.js missing, no browser profile, or a failure: said, with the port as the way the extension connects", () => {
    expect(describeNativeHost({ installed: [], missingHub: true }, NODE).todo).toEqual([
      "Native host not registered: dist/hub.js is missing (build first: npm run build). The extension uses the local port.",
    ]);
    expect(describeNativeHost({ installed: [] }, NODE).todo).toEqual(["Native host not registered: no Chrome or Edge profile found. The extension uses the local port."]);
    expect(describeNativeHost({ installed: [], failed: [{ browser: "Edge", error: "Access is denied." }] }, NODE).todo).toEqual([
      "Native host for Edge not registered (Access is denied.). The extension uses the local port there.",
    ]);
  });
});

describe("#123: setup and the nativeHost switch", () => {
  let home: string;
  let lines: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    home = mkdtempSync(join(tmpdir(), "mcp-teams-setup-native-"));
    // Every browser's profile folder, so a registration would find one on any OS.
    for (const dir of [
      ["AppData", "Local", "Google", "Chrome", "User Data"],
      ["Library", "Application Support", "Google", "Chrome"],
      [".config", "google-chrome"],
    ])
      mkdirSync(join(home, ...dir), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("LOCALAPPDATA", join(home, "AppData", "Local"));
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    doubles.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    doubles.planClients.mockReturnValue([]);
    doubles.syncExtension.mockReturnValue({ changed: false, dir: join(home, ".mcp-teams", "extension") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  const connected = () =>
    ({ extensions: [{ origin: EXTENSION_ORIGIN, browser: "Chrome" }], connected: true, call: vi.fn(async () => ({ teams: [] })) }) as unknown as ExtensionBridge;
  const regCalls = () => doubles.execFileSync.mock.calls.filter(([file]) => /(^|\\)reg(\.exe)?$/i.test(String(file)));

  it("#123: off (the default): no line about a native host, no registry key, no host folder", async () => {
    doubles.nativeHost = false;
    expect(await setup(connected(), "0.0.0", { yes: true })).toBe(true);
    expect(lines.filter((l) => /native host/i.test(l))).toEqual([]);
    expect(regCalls()).toEqual([]);
    expect(existsSync(join(home, "AppData", "Local", "mcp-teams"))).toBe(false);
    expect(existsSync(join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"))).toBe(false);
    expect(existsSync(join(home, ".config", "google-chrome", "NativeMessagingHosts"))).toBe(false);
  });

  it("#123: on, without a built dist/hub.js (run from src/): says the hub isn't built, registers nothing", async () => {
    doubles.nativeHost = true;
    expect(await setup(connected(), "0.0.0", { yes: true })).toBe(true);
    expect(lines.filter((l) => /native host/i.test(l))).toEqual([
      "→ Native host not registered: dist/hub.js is missing (build first: npm run build). The extension uses the local port.",
    ]);
    expect(regCalls()).toEqual([]);
  });

  it("#123: on: setup registers the host for the browser found (on Windows with reg add) and says so", async () => {
    doubles.nativeHost = true;
    // reg (Windows) succeeds; any other program (claude) isn't there.
    doubles.execFileSync.mockImplementation((file: string) => {
      if (/reg\.exe$/i.test(file)) return "";
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    });
    const hub = join(home, "mcp-teams", "dist", "hub.js");
    mkdirSync(join(hub, ".."), { recursive: true });
    writeFileSync(hub, "// hub");
    expect(await setup(connected(), "0.0.0", { yes: true, nativeHost: { hubScript: hub } })).toBe(true);
    const said = lines.filter((l) => /native host/i.test(l));
    if (process.platform === "win32") {
      const manifest = join(home, "AppData", "Local", "mcp-teams", "com.mcp_teams.hub.json");
      const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mcp_teams.hub";
      expect(regCalls().map(([file, args]) => [file, args])).toEqual([[expect.stringMatching(/\\System32\\reg\.exe$/i), ["add", key, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"]]]);
      expect(said).toEqual([`✓ Native host registered for Chrome: ${key}`]);
      expect(readFileSync(join(home, "AppData", "Local", "mcp-teams", "mcp-teams-hub.bat"), "utf8")).toContain('"%USERPROFILE%\\mcp-teams\\dist\\hub.js"');
    } else {
      const dir = process.platform === "darwin" ? ["Library", "Application Support", "Google", "Chrome"] : [".config", "google-chrome"];
      const manifest = join(home, ...dir, "NativeMessagingHosts", "com.mcp_teams.hub.json");
      expect(regCalls()).toEqual([]);
      expect(said).toEqual([`✓ Native host registered for Chrome: ${manifest}`]);
      expect(existsSync(manifest)).toBe(true);
    }
  });
});
