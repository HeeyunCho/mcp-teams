// #123 decision 11: get_version says when the Node the native host's launcher names no longer
// exists (nvm, fnm moved it), so the browser can't start the host: run setup again. Only with
// "nativeHost": true; off, get_version is as before. The tools against a scripted bridge, the
// registrations in a temporary home.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installNativeHost } from "../../src/nativehost.js";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";

let home: string;
let hub: string;
let client: Client | undefined;
// The macOS layout on every host: it reads back the same anywhere (a .bat's paths need Windows).
const where = () => ({ home, platform: "darwin" as const });
const CHROME = ["Library", "Application Support", "Google", "Chrome"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-teams-hostversion-"));
  hub = join(home, "mcp-teams", "dist", "hub.js");
  mkdirSync(join(hub, ".."), { recursive: true });
  writeFileSync(hub, "// hub");
  mkdirSync(join(home, ...CHROME), { recursive: true });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

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

async function version(nativeHost: boolean) {
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN, nativeHost }, { nativeHost: where() });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return JSON.parse(((await client.callTool({ name: "get_version", arguments: {} })) as { content: { text: string }[] }).content[0].text);
}

const fakeNode = () => {
  const node = join(home, "nvm", "v20", "bin", "node");
  mkdirSync(join(node, ".."), { recursive: true });
  writeFileSync(node, "");
  return node;
};

describe("#123: get_version and the native host's registration", () => {
  it("#123: nativeHost off: no nativeHost field, whatever is registered", async () => {
    const node = fakeNode();
    installNativeHost({ ...where(), node, hubScript: hub });
    rmSync(node);
    expect(await version(false)).not.toHaveProperty("nativeHost");
  });

  it("#123: on, registered with a Node that is there: which browsers, and nothing to do", async () => {
    installNativeHost({ ...where(), node: fakeNode(), hubScript: hub });
    expect((await version(true)).nativeHost).toEqual({ registered: ["Chrome"] });
  });

  it("#123: on, the Node is gone: names it and says to run setup again", async () => {
    const node = fakeNode();
    installNativeHost({ ...where(), node, hubScript: hub });
    rmSync(node);
    expect((await version(true)).nativeHost).toEqual({
      registered: ["Chrome"],
      nodeMissing: [node],
      hint: `The native host starts ${node}, which no longer exists (moved by nvm or fnm?), so the browser can't start it and the extension uses the local port. Run \`npx mcp-teams setup\` again.`,
    });
  });

  it("#123: on, registered nowhere: says setup registers it", async () => {
    expect((await version(true)).nativeHost).toEqual({
      registered: [],
      hint: "The native host isn't registered with any browser, so the extension uses the local port. Run `npx mcp-teams setup` to register it.",
    });
  });
});
