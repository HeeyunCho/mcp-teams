// #123 PR 4: setup registers the native-messaging host for the browsers it finds: a host manifest
// and a host launcher next to it (macOS/Linux, per browser), or one manifest and a .bat in
// %LOCALAPPDATA%\mcp-teams plus an HKCU key per browser (Windows). Everything on temporary homes,
// with `reg` replaced: nothing here writes to the real registry or home.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_ID } from "../../src/extension.js";
import { batPath, HOST_NAME, hostLauncherScript, installNativeHost, NonAsciiBatPathError } from "../../src/nativehost.js";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("#123: the extension's manifest", () => {
  // fakeChrome gives the worker connectNative whatever the manifest says; real Chrome gives it only
  // with this permission, so without it the extension would quietly stay on TCP.
  it("#123: asks for the nativeMessaging permission, without which Chrome has no connectNative", () => {
    expect(json("extension/manifest.json").permissions).toContain("nativeMessaging");
  });
});

describe("#123: the host launcher", () => {
  it("#123: the host name is the one the extension connects to", () => {
    expect(HOST_NAME).toBe("com.mcp_teams.hub");
    expect(readFileSync("extension/background.js", "utf8")).toContain(`"${HOST_NAME}"`);
  });

  it("#123: a POSIX host launcher execs the Node that ran setup with dist/hub.js, quoting both", () => {
    expect(hostLauncherScript("darwin", "/usr/local/bin/node", "/Users/alex/my $code/dist/hub.js")).toBe(
      '#!/bin/sh\nexec "/usr/local/bin/node" "/Users/alex/my \\$code/dist/hub.js" "$@"\n',
    );
  });

  it("#123: a Windows host launcher is a .bat passing every argument on (Chrome's origin, --parent-window)", () => {
    expect(hostLauncherScript("win32", "C:\\Program Files\\nodejs\\node.exe", "C:\\work\\mcp-teams\\dist\\hub.js", {})).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\mcp-teams\\dist\\hub.js" %*\r\n',
    );
  });

  it("#123: a .bat doubles every % in the paths, but keeps %* passing the arguments on", () => {
    expect(hostLauncherScript("win32", "C:\\100%\\node.exe", "C:\\Users\\Alex%20Doe\\%APPDATA%\\dist\\hub.js", {})).toBe(
      '@echo off\r\n"C:\\100%%\\node.exe" "C:\\Users\\Alex%%20Doe\\%%APPDATA%%\\dist\\hub.js" %*\r\n',
    );
  });
});

describe("#123: batPath (decision 11: cmd.exe reads a .bat in the OEM code page, 949 on Korean Windows)", () => {
  const HANGUL = { USERPROFILE: "C:\\Users\\홍길동", LOCALAPPDATA: "C:\\Users\\홍길동\\AppData\\Local", APPDATA: "C:\\Users\\홍길동\\AppData\\Roaming" };

  it("#123: a Hangul home is named through its folder variable, so the .bat is pure ASCII", () => {
    const bat = hostLauncherScript("win32", "C:\\Users\\홍길동\\AppData\\Local\\fnm\\node.exe", "C:\\Users\\홍길동\\mcp-teams\\dist\\hub.js", HANGUL);
    expect(bat).toBe('@echo off\r\n"%LOCALAPPDATA%\\fnm\\node.exe" "%USERPROFILE%\\mcp-teams\\dist\\hub.js" %*\r\n');
    expect(bat).toMatch(/^[\x00-\x7f]*$/);
  });

  it("#123: the longest folder that holds the path wins: a Node under nvm in %APPDATA%", () => {
    expect(batPath("C:\\Users\\홍길동\\AppData\\Roaming\\nvm\\v20\\node.exe", HANGUL)).toBe('"%APPDATA%\\nvm\\v20\\node.exe"');
  });

  it("#123: folders match case-insensitively, and only whole: C:\\Users\\홍길동2 is not in C:\\Users\\홍길동", () => {
    expect(batPath("c:\\users\\홍길동\\x.js", HANGUL)).toBe('"%USERPROFILE%\\x.js"');
    expect(() => batPath("C:\\Users\\홍길동2\\x.js", HANGUL)).toThrow(NonAsciiBatPathError);
  });

  it("#123: % in the rest of the path is still doubled", () => {
    expect(batPath("C:\\Users\\홍길동\\100%\\hub.js", HANGUL)).toBe('"%USERPROFILE%\\100%%\\hub.js"');
  });

  it("#123: forward slashes become backslashes; the error names the path as given", () => {
    expect(batPath("C:/Users/홍길동/mcp-teams/dist/hub.js", HANGUL)).toBe('"%USERPROFILE%\\mcp-teams\\dist\\hub.js"');
    expect(() => batPath("D:/도구/node.exe", HANGUL)).toThrow("D:/도구/node.exe");
  });

  it("#123: a non-ASCII path outside every known folder can't go in a .bat", () => {
    expect(() => batPath("D:\\도구\\node.exe", HANGUL)).toThrow(NonAsciiBatPathError);
  });
});

let home: string;
let hub: string;
const NODE = "/opt/node 20/bin/node";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-teams-nativehost-"));
  hub = join(home, "mcp-teams", "dist", "hub.js");
  mkdirSync(join(hub, ".."), { recursive: true });
  writeFileSync(hub, "// hub");
});

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

const mk = (...parts: string[]) => mkdirSync(join(home, ...parts), { recursive: true });
/** A path as the POSIX host launcher quotes it (on Windows the temp paths have backslashes, which /bin/sh needs escaped). */
const sh = (s: string) => s.replace(/[\\"$`]/g, "\\$&");
/** Windows has no POSIX permission bits, so the mode is checked only on macOS and Linux hosts. */
const POSIX_MODES = process.platform !== "win32";
/**
 * The Windows folders, with the temp home as the profile: the temp folder may itself have
 * non-ASCII in it (C:\Users\홍길동\AppData\Local\Temp), which a .bat holds only through a variable.
 */
const winEnv = () => ({ USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") });
const HUB_BAT = '"%USERPROFILE%\\mcp-teams\\dist\\hub.js"';
const MAC_CHROME = ["Library", "Application Support", "Google", "Chrome"];
const MAC_EDGE = ["Library", "Application Support", "Microsoft Edge"];
const WIN_CHROME = ["AppData", "Local", "Google", "Chrome", "User Data"];
const WIN_EDGE = ["AppData", "Local", "Microsoft", "Edge", "User Data"];
const CHROME_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const EDGE_KEY = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;

describe("#123: installNativeHost on macOS", () => {
  it("#123: writes a manifest and a host launcher for Chrome only, when only Chrome's profile folder is there", () => {
    mk(...MAC_CHROME);
    const r = installNativeHost({ home, platform: "darwin", node: NODE, hubScript: hub });
    const dir = join(home, ...MAC_CHROME, "NativeMessagingHosts");
    const hostLauncher = join(dir, "mcp-teams-hub");
    expect(r.installed).toEqual([{ browser: "Chrome", manifest: join(dir, `${HOST_NAME}.json`), hostLauncher, changed: true }]);
    expect(json(join(dir, `${HOST_NAME}.json`))).toEqual({
      name: HOST_NAME,
      description: expect.any(String),
      path: hostLauncher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    expect(readFileSync(hostLauncher, "utf8")).toBe(`#!/bin/sh\nexec "${NODE}" "${sh(hub)}" "$@"\n`);
    if (POSIX_MODES) expect(statSync(hostLauncher).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, ...MAC_EDGE))).toBe(false);
  });

  it("#123: writes for Edge too when it is there, and reports nothing changed the second time", () => {
    mk(...MAC_CHROME);
    mk(...MAC_EDGE);
    const first = installNativeHost({ home, platform: "darwin", node: NODE, hubScript: hub });
    expect(first.installed.map((i) => [i.browser, i.changed])).toEqual([
      ["Chrome", true],
      ["Edge", true],
    ]);
    expect(existsSync(join(home, ...MAC_EDGE, "NativeMessagingHosts", `${HOST_NAME}.json`))).toBe(true);
    const again = installNativeHost({ home, platform: "darwin", node: NODE, hubScript: hub });
    expect(again.installed.map((i) => i.changed)).toEqual([false, false]);
  });

  it("#123: writes nothing when no browser profile is there", () => {
    expect(installNativeHost({ home, platform: "darwin", node: NODE, hubScript: hub })).toEqual({ installed: [] });
    expect(existsSync(join(home, "Library"))).toBe(false);
  });

  it("#123: writes nothing when dist/hub.js is missing (not built), and says so", () => {
    mk(...MAC_CHROME);
    const r = installNativeHost({ home, platform: "darwin", node: NODE, hubScript: join(home, "nowhere", "hub.js") });
    expect(r).toEqual({ installed: [], missingHub: true });
    expect(existsSync(join(home, ...MAC_CHROME, "NativeMessagingHosts"))).toBe(false);
  });
});

describe("#123: installNativeHost on Linux (decision 3: covered by CI only)", () => {
  it("#123: writes for google-chrome, chromium and microsoft-edge, each where it is found", () => {
    mk(".config", "google-chrome");
    mk(".config", "chromium");
    mk(".config", "microsoft-edge");
    const r = installNativeHost({ home, platform: "linux", node: NODE, hubScript: hub });
    expect(r.installed.map((i) => [i.browser, i.manifest])).toEqual([
      ["Chrome", join(home, ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`)],
      ["Chromium", join(home, ".config", "chromium", "NativeMessagingHosts", `${HOST_NAME}.json`)],
      ["Edge", join(home, ".config", "microsoft-edge", "NativeMessagingHosts", `${HOST_NAME}.json`)],
    ]);
    for (const i of r.installed) {
      expect(json(i.manifest).path).toBe(i.hostLauncher);
      if (POSIX_MODES) expect(statSync(i.hostLauncher).mode & 0o777).toBe(0o700);
    }
  });
});

describe("#123: installNativeHost on Windows", () => {
  const winOpts = (reg: (args: string[]) => void) => ({ home, platform: "win32" as const, env: winEnv(), node: "C:\\nodejs\\node.exe", hubScript: hub, reg });

  it("#123: one manifest and .bat in %LOCALAPPDATA%\\mcp-teams, and an HKCU key per browser found", () => {
    mk(...WIN_CHROME);
    mk(...WIN_EDGE);
    const calls: string[][] = [];
    const r = installNativeHost(winOpts((args) => calls.push(args)));
    const dir = join(home, "AppData", "Local", "mcp-teams");
    const manifest = join(dir, `${HOST_NAME}.json`);
    const hostLauncher = join(dir, "mcp-teams-hub.bat");
    expect(r.installed).toEqual([
      { browser: "Chrome", manifest, hostLauncher, registryKey: CHROME_KEY, changed: true },
      { browser: "Edge", manifest, hostLauncher, registryKey: EDGE_KEY, changed: true },
    ]);
    expect(calls).toEqual([
      ["add", CHROME_KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"],
      ["add", EDGE_KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"],
    ]);
    expect(json(manifest)).toMatchObject({ name: HOST_NAME, path: hostLauncher, type: "stdio", allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] });
    expect(readFileSync(hostLauncher, "utf8")).toBe(`@echo off\r\n"C:\\nodejs\\node.exe" ${HUB_BAT} %*\r\n`);
  });

  it("#123: only Edge found: only Edge's key", () => {
    mk(...WIN_EDGE);
    const calls: string[][] = [];
    expect(installNativeHost(winOpts((args) => calls.push(args))).installed.map((i) => i.browser)).toEqual(["Edge"]);
    expect(calls.map((c) => c[1])).toEqual([EDGE_KEY]);
  });

  it("#123: a NonAsciiBatPathError registers nothing: no .bat, no key, and says which path", () => {
    mk(...WIN_CHROME);
    mk(...WIN_EDGE);
    const calls: string[][] = [];
    // USERPROFILE elsewhere: the copy is in none of the folders a .bat can name.
    const nonAscii = join(home, "도구", "dist", "hub.js");
    mkdirSync(join(nonAscii, ".."), { recursive: true });
    writeFileSync(nonAscii, "// hub");
    const env = { USERPROFILE: "C:\\Users\\alex", LOCALAPPDATA: join(home, "AppData", "Local") };
    const r = installNativeHost({ ...winOpts((a) => calls.push(a)), env, hubScript: nonAscii });
    expect(r).toEqual({ installed: [], nonAsciiPath: nonAscii });
    expect(existsSync(join(home, "AppData", "Local", "mcp-teams"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("#123: a failing reg call is reported, not thrown", () => {
    mk(...WIN_CHROME);
    const r = installNativeHost(
      winOpts(() => {
        throw new Error("Access is denied.");
      }),
    );
    expect(r.installed).toEqual([]);
    expect(r.failed).toEqual([{ browser: "Chrome", error: "Access is denied." }]);
  });
});
