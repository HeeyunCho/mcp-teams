#!/usr/bin/env node
// Development aid: calls one extension method through the bridge and prints the result,
// to check Teams' API shapes against the parsers in extension/teams.js. Joins a running
// server as a peer, or becomes the hub and waits for the extension.
//
//   npm run probe -- status
//   npm run probe -- listChats '{"limit":3}'
//   npm run probe -- probe '{"service":"csa","path":"/api/v1/teams/users/me"}'   (GET only)
import { ExtensionBridge } from "../dist/bridge.js";
import { SERVER_VERSION, loadConfig } from "../dist/config.js";

const [method = "status", params = "{}"] = process.argv.slice(2);
const config = loadConfig();
const bridge = new ExtensionBridge(config.port, config.token, SERVER_VERSION);
await bridge.start();
for (const end = Date.now() + 70_000; !bridge.connected && Date.now() < end; ) await new Promise((r) => setTimeout(r, 250));
try {
  if (!bridge.connected) throw new Error(bridge.listenError ?? "The extension did not connect.");
  // Give a second browser a moment to connect, so the call goes where Teams is signed in.
  for (const end = Date.now() + 5_000; bridge.extensions.length < 2 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 250));
  const result = await bridge.call(method, JSON.parse(params), 400_000);
  console.log(typeof result?.text === "string" ? `HTTP ${result.status}\n${result.text}` : JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
await bridge.close();
process.exit();
