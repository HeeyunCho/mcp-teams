// #216: the web store upload (Chrome Web Store, Edge Add-ons) is a zip of extension/ through an
// allowlist, whose manifest.json has no "key" (the web store assigns its own id; the key stays in the
// repo for the sideloaded copy) and which never holds pairing.json. On a temporary copy of extension/.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS script
import { packageExtension } from "../../scripts/package-extension.mjs";
import { readZip } from "../helpers/zip.js";

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-teams-package-"));
  src = join(dir, "extension");
  cpSync("extension", src, { recursive: true });
  rmSync(join(src, "pairing.json"), { force: true }); // a developer's own, if any (gitignored)
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const repoManifest = () => JSON.parse(readFileSync("extension/manifest.json", "utf8"));

describe("#216: packaging the extension for the web stores", () => {
  it("#216: zips a manifest.json without key, the rest of the manifest as it is", () => {
    const { file } = packageExtension({ from: src, out: join(dir, "store.zip") });
    const zip = readZip(file);
    const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
    expect(manifest).not.toHaveProperty("key");
    const { key, ...rest } = repoManifest();
    expect(typeof key).toBe("string"); // the repo keeps it: it fixes the sideload id
    expect(manifest).toEqual(rest);
  });

  it("#216: holds every file the extension runs, byte for byte, and no pairing.json or icon source", () => {
    const { file } = packageExtension({ from: src, out: join(dir, "store.zip") });
    const zip = readZip(file);
    expect(zip.has("pairing.json")).toBe(false);
    // icon.svg is what scripts/render-icons.sh draws the PNGs from; the manifest names only the PNGs.
    expect(zip.has("icons/icon.svg")).toBe(false);
    const files = readdirSync("extension", { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== "pairing.json" && e.name !== "icon.svg")
      .map((e) => join(e.parentPath, e.name).slice("extension/".length).split("\\").join("/"));
    expect([...zip.keys()].sort()).toEqual(files.sort());
    for (const f of files) if (f !== "manifest.json") expect(zip.get(f)!.equals(readFileSync(join("extension", f))), f).toBe(true);
    // The service worker and the pages it loads are there.
    expect(zip.has("background.js")).toBe(true);
    expect(zip.has("icons/icon-128.png")).toBe(true);
  });

  it("#216: refuses to package a folder that holds pairing.json (the pairing token)", () => {
    writeFileSync(join(src, "pairing.json"), JSON.stringify({ token: "not-a-real-token" }));
    expect(() => packageExtension({ from: src, out: join(dir, "store.zip") })).toThrow(/pairing\.json/);
    expect(readdirSync(dir)).not.toContain("store.zip");
  });

  it("#216: refuses a file the allowlist doesn't name, rather than leave it out or ship it unseen", () => {
    writeFileSync(join(src, "notes.txt"), "scratch");
    expect(() => packageExtension({ from: src, out: join(dir, "store.zip") })).toThrow(/notes\.txt/);
  });

  it("#216: leaves extension/ itself alone (its manifest keeps the key)", () => {
    packageExtension({ from: src, out: join(dir, "store.zip") });
    expect(JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")).key).toBe(repoManifest().key);
  });
});
