#!/usr/bin/env node
// Rebuilds the README's images (`npm run readme-images`): the four screenshots from capture.mjs and
// send-flow.gif, rendered from the HyperFrames composition in send-flow/ with the fresh
// confirm-send.png in it, then converted to a GIF with ffmpeg. See README.md in this folder.
//
//   npm run readme-images                      writes docs/images/*
//   npm run readme-images -- --out <dir>       writes there instead
//
// Everything is made in a temporary folder and copied to the output folder only once all five files
// exist, so a failed run leaves docs/images as it was. Needs Google Chrome, ffmpeg on PATH and the
// network (npx fetches HyperFrames; the composition loads GSAP from jsdelivr).
import { spawn } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, PNGS } from "./capture.mjs";

const HYPERFRAMES = "hyperframes@0.9.99";
const GIF_FILTER =
  "fps=15,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];" +
  "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

function parseArgs(argv) {
  let out = join(repo, "docs", "images");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out = argv[++i];
    else if (argv[i].startsWith("--out=")) out = argv[i].slice("--out=".length);
    else throw new Error(`Unknown argument: ${argv[i]}\nUsage: npm run readme-images [-- --out <dir>]`);
  }
  return { out: resolve(out) };
}

// Runs a program with an argument array (no shell), passing its output through.
function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`${basename(cmd)} ${args[0] ?? ""} failed (${signal ?? `exit ${code}`})`)),
    );
  });
}

async function checkFfmpeg() {
  try {
    await run("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch (err) {
    throw new Error(
      err.code === "ENOENT"
        ? "ffmpeg isn't on PATH. Install it (https://ffmpeg.org/download.html) and run this again."
        : `ffmpeg -version failed: ${err.message}`,
    );
  }
}

// npx without a shell: on Windows npx is a .cmd file, which Node runs only through a shell. Instead,
// run npm's own npx-cli.js with node: the one next to the npm that started us (npm sets
// npm_execpath to its npm-cli.js), or the one installed with this node.
function npxCommand() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(join(dirname(process.env.npm_execpath), "npx-cli.js"));
  const nodeDir = dirname(process.execPath);
  candidates.push(join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"));
  candidates.push(join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"));
  const cli = candidates.find((p) => existsSync(p));
  if (!cli) throw new Error("Couldn't find npm's npx-cli.js. Run this through `npm run readme-images`.");
  return [process.execPath, [cli]];
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  await checkFfmpeg();
  const [npxNode, npxArgs] = npxCommand();

  const work = mkdtempSync(join(tmpdir(), "mcp-teams-readme-images-"));
  try {
    const shots = join(work, "images");
    mkdirSync(shots);
    await capture(shots);

    const comp = join(work, "send-flow");
    cpSync(join(here, "send-flow"), comp, { recursive: true });
    copyFileSync(join(shots, "confirm-send.png"), join(comp, "confirm-send.png"));
    const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" };
    await run(npxNode, [...npxArgs, "-y", HYPERFRAMES, "render", "--quality", "delivery", "--output", "out.mp4"], { cwd: comp, env });

    await run("ffmpeg", ["-v", "error", "-y", "-i", join(comp, "out.mp4"), "-vf", GIF_FILTER, "-loop", "0", join(shots, "send-flow.gif")]);

    mkdirSync(out, { recursive: true });
    for (const f of [...PNGS, "send-flow.gif"]) {
      copyFileSync(join(shots, f), join(out, f));
      console.log("saved", join(out, f));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`readme-images: ${err.message ?? err}`);
  process.exit(1);
});
