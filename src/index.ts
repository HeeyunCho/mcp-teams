#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ExtensionBridge } from "./bridge.js";
import { CONFIG_PATH, SERVER_VERSION, loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { setup } from "./setup.js";
import { installedVersion, PACKAGED_EXTENSION_DIR, syncExtension, writePairing } from "./extension.js";
import { isNewer } from "./bridge.js";

// A stray error in a socket callback must not end the server (the AI app would show it
// as "failed"); log it on stderr, which isn't the MCP channel.
process.on("unhandledRejection", (err) => console.error("[mcp-teams] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[mcp-teams] uncaught exception:", err));

const config = loadConfig();
const command = process.argv[2];

if (command === "token") {
  // Printed for pasting into the extension's options page.
  console.log(config.token);
  process.exit(0);
}
if (command === "--version" || command === "version") {
  console.log(SERVER_VERSION);
  process.exit(0);
}

// Keeps the extension in step with this server: once setup has installed it, a newer
// release (npx fetches it on start) updates the installed folder, never downgrading it (an
// older copy still cached somewhere). The folder also gets the pairing token, which the
// extension proves itself with. Both happen before the bridge starts, because an extension
// of 0.2.0 or older that connects is asked to reload into what is in the folder.
let extensionUpdated = false;
const installed = installedVersion();
if (installed !== null && !["token", "version", "--version"].includes(command)) {
  try {
    writePairing(config.token);
    if (!isNewer(installed, installedVersion(PACKAGED_EXTENSION_DIR))) extensionUpdated = syncExtension().changed;
  } catch (err) {
    console.error(`[mcp-teams] could not update the extension folder: ${(err as Error).message}`);
  }
}

const bridge = new ExtensionBridge(config.port, config.token, SERVER_VERSION);
await bridge.start();

if (command === "setup") {
  const ready = await setup(bridge, SERVER_VERSION, { yes: process.argv.includes("--yes") });
  await bridge.close();
  process.exit(ready ? 0 : 1);
}

if (command === "reload-extension") {
  // Used by `npm run update`: updates the installed extension folder (when setup made one),
  // then reloads the extension from disk through the running bridge.
  if (installedVersion() !== null) syncExtension();
  const end = Date.now() + 40_000; // the extension retries its connection every 30 s
  while (!bridge.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  try {
    if (!bridge.connected) throw new Error("The extension is not connected. Is Chrome open with the extension installed?");
    const { before, after } = await bridge.reloadExtension();
    console.log(`Extension reloaded: ${before ?? "?"} → ${after}${after === SERVER_VERSION ? "" : ` (server is ${SERVER_VERSION})`}`);
    await bridge.close();
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    await bridge.close();
    process.exit(1);
  }
}
// stdout is the MCP channel; diagnostics go to stderr.
console.error(
  bridge.listenError
    ? `[mcp-teams ${SERVER_VERSION}] bridge unavailable: ${bridge.listenError}`
    : `[mcp-teams ${SERVER_VERSION}] bridge listening on ws://127.0.0.1:${config.port} (config: ${CONFIG_PATH})`,
);

// The extension's icon, which ships in the package next to dist/.
const icon = (file: string, mimeType: string, sizes: string[]) => ({
  src: `data:${mimeType};base64,${readFileSync(new URL(`../extension/icons/${file}`, import.meta.url)).toString("base64")}`,
  mimeType,
  sizes,
});
const server = new McpServer({
  name: "mcp-teams",
  version: SERVER_VERSION,
  icons: [icon("icon.svg", "image/svg+xml", ["any"]), icon("icon-128.png", "image/png", ["128x128"]), icon("icon-48.png", "image/png", ["48x48"])],
});
registerTools(server, bridge, config);
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

// After an update of the folder, reloads the extension (one of 0.2.0 or older reloads
// itself when it connects, see bridge.ts).
void (async () => {
  if (!extensionUpdated) return;
  for (const end = Date.now() + 120_000; !bridge.connected && Date.now() < end; ) await new Promise((r) => setTimeout(r, 1_000));
  if (!bridge.connected) return;
  try {
    const { before, after } = await bridge.reloadExtension();
    console.error(`[mcp-teams ${SERVER_VERSION}] extension updated: ${before ?? "?"} → ${after}`);
  } catch (err) {
    console.error(`[mcp-teams] extension update needs a reload in the browser: ${(err as Error).message}`);
  }
})();
