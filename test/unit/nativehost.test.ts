// #123 PR 4: setup registers the native-messaging host for the browsers it finds: a host manifest
// and a host launcher next to it (macOS/Linux, per browser), or one manifest and a .bat in
// %LOCALAPPDATA%\mcp-teams plus an HKCU key per browser (Windows). Everything on temporary homes,
// with `reg` replaced: nothing here writes to the real registry or home.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("#123: the extension's manifest", () => {
  // fakeChrome gives the worker connectNative whatever the manifest says; real Chrome gives it only
  // with this permission, so without it the extension would quietly stay on TCP.
  it("#123: asks for the nativeMessaging permission, without which Chrome has no connectNative", () => {
    expect(json("extension/manifest.json").permissions).toContain("nativeMessaging");
  });
});
