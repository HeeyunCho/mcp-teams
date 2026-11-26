#!/usr/bin/env node
// Screenshots for the README (docs/images): the extension's own popup.html and confirm.html, opened
// unchanged from extension/ with chrome.runtime.sendMessage and chrome.storage.local stubbed to
// return made-up sample data, and terminal.html (setup's first-run output, typed in by hand from the
// messages in src/setup.ts). Nothing here talks to Teams or to a real extension.
//
//   node scripts/readme-images/capture.mjs [outDir]       default: docs/images
//
// Writes popup-connected.png, popup-waiting.png, confirm-send.png and setup-terminal.png at device
// scale factor 2. It drives the installed Google Chrome through Playwright (channel "chrome"), so no
// Playwright browser download is needed. `npm run readme-images` runs this and also builds the GIF.
import { basename, join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
export const PNGS = ["popup-connected.png", "popup-waiting.png", "confirm-send.png", "setup-terminal.png"];

// Runs in the page before its own scripts: answers each message type from `responses`. A type with
// no answer here fails (an unhandled rejection in the page, which shot() turns into a failed build),
// as does a chrome.* call the stub doesn't have, so a change to popup.js or confirm.js can't quietly
// give a half-rendered picture.
function stubChrome(responses) {
  window.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (!(m.type in responses)) throw new Error(`readme-images stub has no answer for message type "${m.type}"`);
        return responses[m.type];
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
}

const confirmRequest = {
  conversation: { kind: "channel", title: "Product / Launch planning", id: "19:a1b2c3d4e5f6@thread.tacv2" },
  replyingTo: { from: { name: "Jordan Lee" }, text: "Can someone post the final launch checklist before Friday?" },
  text: "Here's the final checklist:\n- Release notes reviewed\n- Support docs updated\n- Rollout starts Monday 09:00\n\nShout if anything is missing.",
};

export async function launchChrome() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") throw new Error("Playwright isn't installed: run npm install (it's a devDependency).");
    throw err;
  }
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (err) {
    throw new Error(
      "Couldn't start Google Chrome through Playwright. These screenshots need Chrome installed " +
        "(https://www.google.com/chrome/); Playwright's own browsers aren't used.\n" +
        String(err?.message ?? err).split("\n")[0],
    );
  }
}

export async function capture(outDir, { extensionDir = join(repo, "extension") } = {}) {
  const browser = await launchChrome();
  try {
    // `ready`: a selector that matches only once the page has rendered its data.
    const shot = async (file, query, responses, viewport, out, ready, selector) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
      const failed = (what) => new Error(`${out} (${basename(file)}): ${what}`);
      await page.addInitScript(stubChrome, responses);
      await page.goto(pathToFileURL(file).href + query);
      try {
        await page.waitForSelector(ready, { timeout: 5000 });
      } catch {
        throw failed(errors[0] ?? `the page didn't render (no ${ready} after 5 s)`);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      if (errors.length) throw failed(errors[0]);
      const path = join(outDir, out);
      // omitBackground: the page's transparent body stays transparent, so the corners outside the
      // terminal's rounded edge don't show as light wedges in GitHub's dark mode.
      if (selector) await page.locator(selector).screenshot({ path, omitBackground: true });
      else await page.screenshot({ path, fullPage: true });
      await page.close();
      console.log("wrote", path);
    };
    const popup = join(extensionDir, "popup.html");
    const popupView = { width: 344, height: 160 };
    await shot(popup, "", { "popup:status": { state: "connected", version: "1.2.0" } }, popupView,
      "popup-connected.png", "#state.connected");
    await shot(popup, "", { "popup:status": { state: "disconnected", version: "1.2.0" } }, popupView,
      "popup-waiting.png", "#state.disconnected");
    await shot(join(extensionDir, "confirm.html"), "?id=demo", { "confirm:get": { request: confirmRequest } },
      { width: 600, height: 470 }, "confirm-send.png", "#main pre");
    await shot(join(here, "terminal.html"), "", {}, { width: 1060, height: 760 }, "setup-terminal.png", ".win", ".win");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(repo, "docs", "images"));
  capture(outDir).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
