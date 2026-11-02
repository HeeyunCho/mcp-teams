import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBridge } from "../src/bridge.js";
import { EXTENSION_ORIGIN } from "../src/extension.js";
import { setup } from "../src/setup.js";

// Doubles at the edges: no `claude` CLI is run, and no AI app's config, extension folder or
// mcp-teams config is read or written.
const doubles = vi.hoisted(() => ({ execFileSync: vi.fn(), planClients: vi.fn(), syncExtension: vi.fn() }));
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
  loadConfig: () => ({ token: "fake-token" }),
}));

describe("setup with no Teams tab open", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    doubles.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    doubles.planClients.mockReturnValue([]);
    doubles.syncExtension.mockReturnValue({ changed: false, dir: "/home/alex/.mcp-teams/extension" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the extension to open Teams, since a new user has no tab yet", async () => {
    const call = vi.fn(async () => ({ teams: [] }));
    const bridge = { extensions: [{ origin: EXTENSION_ORIGIN, browser: "Chrome" }], connected: true, call } as unknown as ExtensionBridge;
    expect(await setup(bridge, "0.0.0", { yes: true })).toBe(true);
    expect(call).toHaveBeenCalledWith("listTeams", { refresh: true, openTab: true }, expect.any(Number));
  });

  it("shows whose Teams it reached when that account is in no teams", async () => {
    const note = "Teams is signed in as Alex Doe (alex@contoso.example) and this account is in no teams.";
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void lines.push(line));
    const call = vi.fn(async () => ({ teams: [], note }));
    const bridge = { extensions: [{ origin: EXTENSION_ORIGIN, browser: "Chrome" }], connected: true, call } as unknown as ExtensionBridge;
    expect(await setup(bridge, "0.0.0", { yes: true })).toBe(true);
    expect(lines.join("\n")).toContain("Teams reachable (0 teams)");
    expect(lines.join("\n")).toContain(note);
  });
});
