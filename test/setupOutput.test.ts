import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAddCommand, noAppHint, registerApps, serverCommand } from "../src/setup.js";

// Doubles at the edges: no `claude` CLI is run and no AI app's config is read or written.
const doubles = vi.hoisted(() => ({ execFileSync: vi.fn(), planClients: vi.fn(), applyPlan: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: doubles.execFileSync,
}));
vi.mock("../src/clients.js", async (original) => ({
  ...(await original<typeof import("../src/clients.js")>()),
  planClients: doubles.planClients,
  applyPlan: doubles.applyPlan,
}));

const HEADER = "AI apps on this computer:";
const unchangedApp = { client: { name: "Example App" }, path: "/home/alex/example.json", status: "unchanged" };

/** `claude` can't be started with this code. On Windows, where.exe finds it first. */
const claudeFails = (code: string) =>
  doubles.execFileSync.mockImplementation((file: string) => {
    if (file === "where.exe") return "";
    throw Object.assign(new Error(`spawn claude ${code}`), { code });
  });

describe("#24: the header of `setup`'s app list", () => {
  let lines: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("#24: none-found: no header above the hint", async () => {
    claudeFails("ENOENT");
    doubles.planClients.mockReturnValue([]);
    await registerApps(false);
    expect(lines).toEqual([`→ ${noAppHint(serverCommand())}`]);
  });

  it("#24: stop with no rows: no header after Claude Code's hint", async () => {
    claudeFails("EACCES");
    doubles.planClients.mockReturnValue([]);
    await registerApps(false);
    expect(lines).toEqual([`→ Claude Code: could not run its CLI (spawn claude EACCES). Register by hand: ${claudeAddCommand(serverCommand())}`]);
  });

  it("#24: stop with a row: the header comes before that row", async () => {
    claudeFails("EACCES");
    doubles.planClients.mockReturnValue([unchangedApp]);
    await registerApps(false);
    expect(lines).toEqual([
      `→ Claude Code: could not run its CLI (spawn claude EACCES). Register by hand: ${claudeAddCommand(serverCommand())}`,
      HEADER,
      "  Example App     registered",
    ]);
  });

  it("#24: Claude Code's row alone gets the header too", async () => {
    const cmd = serverCommand();
    doubles.execFileSync.mockReturnValue([cmd.command, ...cmd.args].join(" "));
    doubles.planClients.mockReturnValue([]);
    await registerApps(false);
    expect(lines).toEqual([HEADER, "  Claude Code     registered", "✓ Registered with every AI app found"]);
  });
});
