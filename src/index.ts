#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DRAIN_MAX_WAIT_MS, ExtensionBridge } from "./bridge.js";
import { CONFIG_PATH, SERVER_VERSION, loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { setup } from "./setup.js";
import { installedVersion, PACKAGED_EXTENSION_DIR, syncExtension, writePairing } from "./extension.js";
import { isNewer } from "./bridge.js";
import { reloadUntilUpdated } from "./extensionUpdate.js";
import { hubSocketPath } from "./native.js";
import { diagnosticLog } from "./serverLog.js";

const command = process.argv[2];
const printsOnly = ["token", "version", "--version"].includes(command);

// Every server (not the commands that only print) keeps ~/.mcp-teams/server.log (#143): metadata
// to trace an outage after a restart. The role is the bridge's once it exists.
let roleNow = (): string => "none";
const diagnostics = printsOnly ? undefined : diagnosticLog({ version: SERVER_VERSION, role: () => roleNow() });
let exitReason = "unknown";
diagnostics?.start({ command: ["setup", "reload-extension"].includes(command) ? command : command ? "other" : "serve" });
process.on("exit", (code) => diagnostics?.exit(exitReason, code));

// A stray error in a socket callback must not end the server (the AI app would show it
// as "failed"); log it on stderr, which isn't the MCP channel, and by name in server.log.
process.on("unhandledRejection", (err) => {
  console.error("[mcp-teams] unhandled rejection:", err);
  diagnostics?.crash("unhandled-rejection", err);
});
process.on("uncaughtException", (err) => {
  console.error("[mcp-teams] uncaught exception:", err);
  diagnostics?.crash("uncaught-exception", err);
});

const config = loadConfig();

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
    writePairing(config.token, undefined, { nativeHost: config.nativeHost });
    if (!isNewer(installed, installedVersion(PACKAGED_EXTENSION_DIR))) extensionUpdated = syncExtension().changed;
  } catch (err) {
    console.error(`[mcp-teams] could not update the extension folder: ${(err as Error).message}`);
  }
}

// With "nativeHost": true in config.json (off by default until #123's PR 5), the server first
// looks for the native host on its hub socket and moves to it from TCP once it has the extension.
// Off, it never touches the socket: TCP only, as before.
const bridge = new ExtensionBridge(config.port, config.token, SERVER_VERSION, {
  ...(config.nativeHost ? { hubSocket: hubSocketPath() } : {}),
  diagnose: diagnostics?.bridge,
});
roleNow = () => bridge.role;
await bridge.start();

if (command === "setup") {
  const ready = await setup(bridge, SERVER_VERSION, { yes: process.argv.includes("--yes") });
  await bridge.close();
  exitReason = "setup-done";
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
    exitReason = "reload-done";
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    await bridge.close();
    exitReason = "reload-failed";
    process.exit(1);
  }
}
// stdout is the MCP channel; diagnostics go to stderr.
console.error(
  bridge.listenError
    ? `[mcp-teams ${SERVER_VERSION}] bridge unavailable: ${bridge.listenError}`
    : `[mcp-teams ${SERVER_VERSION}] bridge listening on ws://127.0.0.1:${bridge.port} (config: ${CONFIG_PATH})`,
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
registerTools(server, bridge, config, { diagnostics });
await server.connect(new StdioServerTransport());

// A signal closes at once. When the AI session ends (stdin closes), this server takes no more MCP
// calls, but as the hub it first lets other sessions' running calls finish for a few seconds
// (#112, ported from mcp-newoutlook src/index.ts, PR #108 there); TEAMS_MCP_DRAIN_MS changes that
// bound (tests). The process exits soon after the bound even if a connection is slow to close.
const shutdown = (signal: string) => async () => {
  exitReason = signal;
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
process.stdin.on("close", async () => {
  exitReason = "stdin-closed";
  const fromEnv = process.env.TEAMS_MCP_DRAIN_MS ? Number(process.env.TEAMS_MCP_DRAIN_MS) : NaN;
  const drainMs = Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DRAIN_MAX_WAIT_MS; // 0: no drain
  setTimeout(() => ((exitReason = "drain-timeout"), process.exit(0)), drainMs + 2_000).unref();
  await server.close().catch(() => {});
  await bridge.drainAndClose(drainMs);
  process.exit(0);
});

// After an update of the folder, reloads the extension (one of 0.2.0 or older reloads
// itself when it connects, see bridge.ts).
void (async () => {
  if (!extensionUpdated) return;
  // #111: retried while the hub changes hands right after the update (see reloadUntilUpdated).
  const r = await reloadUntilUpdated(bridge, installedVersion() ?? SERVER_VERSION);
  if (r.ok) console.error(`[mcp-teams ${SERVER_VERSION}] extension updated: ${r.before ?? "?"} → ${r.after}`);
  // From 0.3.47 on, the extension also reloads itself when its folder holds a newer version.
  else console.error(`[mcp-teams] extension update needs a reload in the browser: ${r.error}`);
})();
