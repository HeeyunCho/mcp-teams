// ~/.mcp-teams/config.json: autoSendTo (send_message without the window, to yourself alone).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAutoSendTo } from "../../src/config.js";

describe("autoSendTo", () => {
  it("is empty when missing", () => {
    expect(parseAutoSendTo(undefined)).toEqual([]);
    expect(parseAutoSendTo(null)).toEqual([]);
    expect(parseAutoSendTo([])).toEqual([]);
  });

  it("trims, lowercases and drops duplicates", () => {
    expect(parseAutoSendTo([" Pat.Lee@Contoso.example ", "pat.lee@contoso.example", "PAT@corp.contoso.example"])).toEqual([
      "pat.lee@contoso.example",
      "pat@corp.contoso.example",
    ]);
  });

  it("takes a single address as a list of one", () => {
    expect(parseAutoSendTo("pat.lee@contoso.example")).toEqual(["pat.lee@contoso.example"]);
  });

  it("refuses anything that isn't a list of email addresses", () => {
    expect(() => parseAutoSendTo({ me: "pat.lee@contoso.example" })).toThrow(/must be a list of email addresses/);
    expect(() => parseAutoSendTo(["Pat Lee"])).toThrow(/"Pat Lee" is not an email address/);
    expect(() => parseAutoSendTo([""])).toThrow(/not an email address/);
    expect(() => parseAutoSendTo([42])).toThrow(/42 is not an email address/);
  });
});

describe("loadConfig", () => {
  let home: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function load(stored: object) {
    home = mkdtempSync(join(tmpdir(), "mcp-teams-config-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", ...stored }));
    vi.stubEnv("TEAMS_MCP_HOME", home);
    vi.resetModules(); // CONFIG_DIR is read when the module loads
    return (await import("../../src/config.js")).loadConfig;
  }

  it("reads autoSendTo from config.json", async () => {
    const loadConfig = await load({ autoSendTo: ["Pat.Lee@Contoso.example"] });
    expect(loadConfig()).toMatchObject({ token: "tok", autoSendTo: ["pat.lee@contoso.example"] });
  });

  it("defaults to an empty list", async () => {
    const loadConfig = await load({});
    expect(loadConfig().autoSendTo).toEqual([]);
  });

  it("fails on an invalid autoSendTo", async () => {
    const loadConfig = await load({ autoSendTo: "not an address" });
    expect(() => loadConfig()).toThrow(/autoSendTo .* is not an email address/);
  });
});
