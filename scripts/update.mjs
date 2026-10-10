#!/usr/bin/env node
// Brings the local copy to the latest release: pulls main (fast-forward only),
// installs dependencies if the lockfile changed, builds, then lists what's left to do.
//
//   npm run update
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const step = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "inherit" });
const version = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") fail(`You are on branch "${branch}". Switch to main first: git checkout main`);
if (run("git status --porcelain")) fail("There are uncommitted changes. Commit or stash them first.");

const before = { version: version(), commit: run("git rev-parse HEAD") };
console.log(`mcp-teams ${before.version}: checking for updates…`);
step("git pull --ff-only --tags");
const after = run("git rev-parse HEAD");

if (after === before.commit) {
  console.log(`\n✓ Already up to date (${before.version}).`);
  process.exit(0);
}

const changed = run(`git diff --name-only ${before.commit} ${after}`).split("\n");
if (changed.includes("package-lock.json")) {
  console.log("\nDependencies changed: installing…");
  step("npm ci");
}
console.log("\nBuilding…");
step("npm run build");

const extensionChanged = changed.some((f) => f.startsWith("extension/"));
let extensionReloaded = false;
if (extensionChanged) {
  console.log("\nReloading the extension…");
  try {
    step("node dist/index.js reload-extension");
    extensionReloaded = true;
  } catch {
    // Not connected, or an extension too old to reload remotely: left to the user below.
  }
}
console.log(`\n✓ Updated ${before.version} → ${version()}.`);
console.log("\nStill to do:");
if (extensionChanged && !extensionReloaded) console.log("  • Reload the extension in chrome://extensions (the Teams tab doesn't need reloading).");
console.log("  • In each Claude session that uses the Teams tools: /mcp → teams → Reconnect.");
console.log("  • Optional check: npm run probe -- status");
