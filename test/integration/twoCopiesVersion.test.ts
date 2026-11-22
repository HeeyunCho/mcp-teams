// #216: get_version says when one browser has both the sideloaded copy of the extension and a
// web store copy (another trusted id) connected: both are served, but one is enough. The tools against
// a scripted bridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionInfo } from "../../src/bridge.js";
import { EXTENSION_ID, SIDELOADED_ORIGIN } from "../../src/extension.js";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";

// A fictional web store id (32 letters a–p).
const WEB_STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const trustedExtensionIds = { unpacked: EXTENSION_ID, chromeWebStore: WEB_STORE_ID };

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function version(extensions: ExtensionInfo[]) {
  const bridge = {
    connected: false,
    extension: extensions.at(-1) ?? null,
    extensions,
    listenError: null,
    role: "hub",
    port: 0,
    hubVersion: null,
    capabilities: { features: [], maxMessageBytes: null },
    call: () => Promise.reject(new Error("No Teams tab is open.")),
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN }, { trustedExtensionIds });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return JSON.parse(((await client.callTool({ name: "get_version", arguments: {} })) as { content: { text: string }[] }).content[0].text);
}

describe("#216: get_version and two copies of the extension", () => {
  it("#216: warns when the sideloaded copy and a web store copy are connected in the same browser", async () => {
    const r = await version([
      { version: "0.3.78", browser: "Chrome", origin: SIDELOADED_ORIGIN, instance: "a" },
      { version: "0.3.78", browser: "Chrome", origin: `chrome-extension://${WEB_STORE_ID}`, instance: "b" },
    ]);
    expect(r.twoCopies).toMatch(/Two copies of the mcp-teams extension are connected in Chrome.*Remove the sideloaded one/);
  });

  it("#216: says nothing with one copy per browser", async () => {
    const r = await version([
      { version: "0.3.78", browser: "Chrome", origin: SIDELOADED_ORIGIN, instance: "a" },
      { version: "0.3.78", browser: "Edge", origin: `chrome-extension://${WEB_STORE_ID}`, instance: "b" },
    ]);
    expect(r).not.toHaveProperty("twoCopies");
  });
});
