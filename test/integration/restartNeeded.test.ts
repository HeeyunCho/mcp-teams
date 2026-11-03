// #96: a running server reports the build it runs (dist/build.json at its start), and tells when the
// build on disk has changed under it: get_version says restartNeeded, and every tool error says to
// reconnect. The tools against a scripted bridge, the builds in a temporary folder.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";

let root: string;
let dist: string;
let client: Client | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-teams-restart-"));
  dist = join(root, "dist");
  mkdirSync(dist);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const writePackage = (version: string) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mcp-teams", version }));
const writeBuild = (version: string, buildId: string) => writeFileSync(join(dist, "build.json"), JSON.stringify({ version, buildId }));

/** A bridge with no extension connected, whose calls all fail with this message. */
const bridge = {
  connected: false,
  extension: null,
  extensions: [],
  listenError: null,
  role: "hub",
  port: 0,
  hubVersion: null,
  call: () => Promise.reject(new Error("No Teams tab is open.")),
} as unknown as Parameters<typeof registerTools>[1];

/** A client of tools whose running build is the one in `dist` now; `clock` is their time. */
async function start(clock = { now: 0 }) {
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN }, { build: { dir: dist, now: () => clock.now } });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const c = client;
  return {
    clock,
    version: async () => JSON.parse(((await c.callTool({ name: "get_version", arguments: {} })) as { content: { text: string }[] }).content[0].text),
    failing: async () => (await c.callTool({ name: "list_teams", arguments: {} })) as { isError?: boolean; content: { text: string }[] },
  };
}

describe("the running build", () => {
  it("get_version reports the built version, not a package.json bumped since", async () => {
    writePackage("0.9.2");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start();
    expect(await tools.version()).toMatchObject({ server: "0.9.1", build: "0a1b2c3d4e5f" });
  });
});

describe("restartNeeded", () => {
  it("is false while the build on disk is the running one, and tool errors stay as they were", async () => {
    writePackage("0.9.1");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start();
    const v = await tools.version();
    expect(v).toMatchObject({ server: "0.9.1", build: "0a1b2c3d4e5f", restartNeeded: false });
    expect(v).not.toHaveProperty("onDisk");
    expect(await tools.failing()).toEqual({ isError: true, content: [{ type: "text", text: "No Teams tab is open." }] });
  });
});
