// #96: a running server reports the build it runs (dist/build.json at its start), and tells when the
// build on disk has changed under it: get_version says restartNeeded, and every tool error says to
// reconnect. The tools against a scripted bridge, the builds in a temporary folder.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("is true with the build on disk once it differs, and every tool error ends with the hint", async () => {
    writePackage("0.9.1");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start();
    writePackage("0.9.2");
    writeBuild("0.9.2", "f5e4d3c2b1a0");
    expect(await tools.version()).toMatchObject({
      server: "0.9.1",
      build: "0a1b2c3d4e5f",
      restartNeeded: true,
      onDisk: { version: "0.9.2", build: "f5e4d3c2b1a0" },
    });
    expect(await tools.failing()).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text:
            "No Teams tab is open.\n" +
            "mcp-teams was updated on disk (running 0.9.1 0a1b2c3d4e5f, on disk 0.9.2 f5e4d3c2b1a0): reconnect it with /mcp, then reload the extension.",
        },
      ],
    });
  });

  it("is true for a rebuild of the same version too", async () => {
    writePackage("0.9.1");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start();
    writeBuild("0.9.1", "99aa88bb77cc");
    expect(await tools.version()).toMatchObject({ restartNeeded: true, onDisk: { version: "0.9.1", build: "99aa88bb77cc" } });
  });

  // #100: every release bumps the version, so a new version on disk needs a restart even when the build id
  // didn't change (a build id that misses part of what was released).
  it("is true for a new version on disk with the same build id, and tool errors end with the hint", async () => {
    writePackage("0.9.1");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start();
    writePackage("0.9.2");
    writeBuild("0.9.2", "0a1b2c3d4e5f");
    expect(await tools.version()).toMatchObject({
      server: "0.9.1",
      build: "0a1b2c3d4e5f",
      restartNeeded: true,
      onDisk: { version: "0.9.2", build: "0a1b2c3d4e5f" },
    });
    expect((await tools.failing()).content[0].text).toBe(
      "No Teams tab is open.\n" +
        "mcp-teams was updated on disk (running 0.9.1 0a1b2c3d4e5f, on disk 0.9.2 0a1b2c3d4e5f): reconnect it with /mcp, then reload the extension.",
    );
  });

  it("is never reported for a build without build.json, even once one appears on disk", async () => {
    writePackage("0.9.1");
    const tools = await start();
    expect(await tools.version()).toMatchObject({ server: "0.9.1", build: null, restartNeeded: false });
    writePackage("0.9.2");
    writeBuild("0.9.2", "f5e4d3c2b1a0");
    const v = await tools.version();
    expect(v).toMatchObject({ server: "0.9.1", build: null, restartNeeded: false });
    expect(v).not.toHaveProperty("onDisk");
    expect(await tools.failing()).toEqual({ isError: true, content: [{ type: "text", text: "No Teams tab is open." }] });
  });
});

// #100: builds written by scripts/write-build-info.mjs (a copy of it in the temporary project), as
// `npm run build` writes them after tsc.
describe("restartNeeded after a rebuild", () => {
  function project() {
    mkdirSync(join(root, "scripts"));
    copyFileSync("scripts/write-build-info.mjs", join(root, "scripts", "write-build-info.mjs"));
    writePackage("0.9.1");
    writeFileSync(join(dist, "index.js"), "console.log('contoso');\n");
    mkdirSync(join(root, "extension"));
    writeFileSync(join(root, "extension", "manifest.json"), '{"version":"0.9.1"}\n');
    writeFileSync(join(root, "extension", "background.js"), "// fabrikam\n");
  }
  const rebuild = () => execFileSync(process.execPath, [join(root, "scripts", "write-build-info.mjs")], { stdio: "pipe" });

  it("is true once only the extension changed and was rebuilt, and tool errors end with the hint", async () => {
    project();
    rebuild();
    const tools = await start();
    const { build } = await tools.version();
    writeFileSync(join(root, "extension", "background.js"), "// fabrikam, fixed\n");
    rebuild();
    tools.clock.now = 10_000; // past the reused read
    const v = await tools.version();
    expect(v).toMatchObject({ server: "0.9.1", build, restartNeeded: true, onDisk: { version: "0.9.1" } });
    expect(v.onDisk.build).not.toBe(build);
    expect((await tools.failing()).content[0].text).toBe(
      "No Teams tab is open.\n" +
        `mcp-teams was updated on disk (running 0.9.1 ${build}, on disk 0.9.1 ${v.onDisk.build}): reconnect it with /mcp, then reload the extension.`,
    );
  });

  it("stays false after a rebuild that changes nothing", async () => {
    project();
    rebuild();
    const tools = await start();
    await tools.version();
    rebuild();
    tools.clock.now = 10_000; // past the reused read
    const v = await tools.version();
    expect(v).toMatchObject({ restartNeeded: false });
    expect(v).not.toHaveProperty("onDisk");
    expect((await tools.failing()).content[0].text).toBe("No Teams tab is open.");
  });
});

describe("reading the build on disk", () => {
  it("reuses a read for 5 s, so a change within that time shows after it", async () => {
    writePackage("0.9.1");
    writeBuild("0.9.1", "0a1b2c3d4e5f");
    const tools = await start({ now: 1_000 });
    expect(await tools.version()).toMatchObject({ restartNeeded: false });
    writeBuild("0.9.2", "f5e4d3c2b1a0");
    tools.clock.now = 5_999;
    expect(await tools.version()).toMatchObject({ restartNeeded: false });
    expect((await tools.failing()).content[0].text).toBe("No Teams tab is open.");
    tools.clock.now = 6_000;
    expect(await tools.version()).toMatchObject({ restartNeeded: true, onDisk: { version: "0.9.2", build: "f5e4d3c2b1a0" } });
  });
});
