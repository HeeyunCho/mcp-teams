// #216: setup counts any trusted extension id as our extension (a store install too), and says
// when one browser has both the sideloaded copy and a store copy connected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBridge } from "../src/bridge.js";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../src/extension.js";
import { setup } from "../src/setup.js";

// Doubles at the edges, as in setupOpensTeams.test.ts: no `claude` CLI is run, and no AI app's
// config, extension folder or mcp-teams config is read or written.
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

// A fictional store id (32 letters a–p).
const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`;
const trustedExtensionIds = { unpacked: EXTENSION_ID, chromeWebStore: STORE_ID };

describe("#216: setup with a store install", () => {
  let lines: string[];
  beforeEach(() => {
    vi.resetAllMocks();
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    doubles.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    doubles.planClients.mockReturnValue([]);
    doubles.syncExtension.mockReturnValue({ changed: false, dir: "/home/alex/.mcp-teams/extension" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bridgeWith = (extensions: { origin: string; browser: string }[]) =>
    ({ extensions, connected: true, call: vi.fn(async () => ({ teams: [] })) }) as unknown as ExtensionBridge;

  it("#216: sees a store copy (a second trusted id) connect, without waiting for a sideloaded one", { timeout: 15_000 }, async () => {
    const bridge = bridgeWith([{ origin: STORE_ORIGIN, browser: "Edge" }]);
    expect(await setup(bridge, "0.0.0", { yes: true, trustedExtensionIds })).toBe(true);
    expect(lines.join("\n")).toContain("Extension connected in Edge");
    // Not the first-time steps for a browser where no copy connected.
    expect(lines.join("\n")).not.toContain("Waiting for the extension");
  });

  it("#216: says when one browser has both the sideloaded copy and a store copy, and suggests removing the sideloaded one", async () => {
    const bridge = bridgeWith([
      { origin: EXTENSION_ORIGIN, browser: "Chrome" },
      { origin: STORE_ORIGIN, browser: "Chrome" },
    ]);
    expect(await setup(bridge, "0.0.0", { yes: true, trustedExtensionIds })).toBe(true);
    expect(lines.join("\n")).toMatch(/Two copies of the mcp-teams extension are connected in Chrome.*Remove the sideloaded one/);
  });

  it("#216: says nothing about two copies with only the sideloaded one", async () => {
    const bridge = bridgeWith([{ origin: EXTENSION_ORIGIN, browser: "Chrome" }]);
    expect(await setup(bridge, "0.0.0", { yes: true, trustedExtensionIds })).toBe(true);
    expect(lines.join("\n")).not.toContain("Two copies");
  });
});
