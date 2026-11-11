// #123 PR 4: setup registers the native-messaging host for the browsers it finds: a host manifest
// and a host launcher next to it (macOS/Linux, per browser), or one manifest and a .bat in
// %LOCALAPPDATA%\mcp-teams plus an HKCU key per browser (Windows). Everything on temporary homes,
// with `reg` replaced: nothing here writes to the real registry or home.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_ID } from "../../src/extension.js";
import { batPath, HOST_NAME, hostLauncherScript, installNativeHost, nativeHostReport, NonAsciiBatPathError, regDefaultValue, regExe, registeredHosts } from "../../src/nativehost.js";

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

  it("#123: a failing reg call is reported, not thrown (the HKCU key is the last step)", () => {
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

// Decision 11: the host launcher names the Node that ran setup. nvm or fnm can move or remove it,
// and then Chrome can't start the host until setup runs again; get_version and setup say so.
describe("#123: a registration whose Node has gone", () => {
  /** A Node in the temp home, as nvm would install one. */
  const fakeNode = (...parts: string[]) => {
    const node = join(home, ...parts);
    mkdirSync(join(node, ".."), { recursive: true });
    writeFileSync(node, "");
    return node;
  };
  /** HKCU as reg add writes it and reg query reads it back: key → default value. */
  const fakeRegistry = () => {
    const keys = new Map<string, string>();
    return {
      keys,
      reg: (args: string[]) => void (args[0] === "add" && keys.set(args[1], args[6])),
      regQuery: (key: string) => keys.get(key) ?? null,
    };
  };
  const winOpts = (registry = fakeRegistry()) => ({ home, platform: "win32" as const, env: winEnv(), hubScript: hub, ...registry });
  /** A path as a .bat holds it: backslashes only. */
  const win = (p: string) => p.replace(/\//g, "\\");
  /**
   * Whether a file named in a .bat can be checked: on a macOS or Linux host (CI) the temp path
   * comes back with backslashes, which name no file there, so "gone" would be true by accident.
   */
  const ON_WINDOWS = process.platform === "win32";

  it("#123: nothing registered: nothing to report", () => {
    mk(...MAC_CHROME);
    expect(registeredHosts({ home, platform: "darwin" })).toEqual([]);
  });

  it("#123: macOS: reports each registration with its Node and hub, and whether each is still there", () => {
    mk(...MAC_CHROME);
    mk(...MAC_EDGE);
    const node = fakeNode("nvm", "v20 $x", "bin", "node");
    installNativeHost({ home, platform: "darwin", node, hubScript: hub });
    expect(registeredHosts({ home, platform: "darwin" })).toEqual([
      { browser: "Chrome", node, nodeExists: true, hub, hubExists: true },
      { browser: "Edge", node, nodeExists: true, hub, hubExists: true },
    ]);
    rmSync(node);
    expect(registeredHosts({ home, platform: "darwin" }).map((r) => [r.browser, r.nodeExists, r.hubExists])).toEqual([
      ["Chrome", false, true],
      ["Edge", false, true],
    ]);
  });

  it("#123: a gone dist/hub.js (a pruned npx cache, a moved clone) is reported like a gone Node", () => {
    mk(...MAC_CHROME);
    installNativeHost({ home, platform: "darwin", node: fakeNode("node"), hubScript: hub });
    rmSync(hub);
    expect(registeredHosts({ home, platform: "darwin" })).toEqual([expect.objectContaining({ browser: "Chrome", hub, hubExists: false, nodeExists: true })]);
    expect(nativeHostReport({ home, platform: "darwin" })).toEqual({
      registered: ["Chrome"],
      hubMissing: [hub],
      hint: `The native host runs ${hub}, which no longer exists (an npx cache cleared, or the copy moved), so the browser can't start it and the extension uses the local port. Run \`npx mcp-teams setup\` again.`,
    });
  });

  it("#123: setup registering again says which hub.js had gone", () => {
    mk(...MAC_CHROME);
    const node = fakeNode("node");
    installNativeHost({ home, platform: "darwin", node, hubScript: hub });
    rmSync(hub);
    const now = join(home, "elsewhere", "dist", "hub.js");
    mkdirSync(join(now, ".."), { recursive: true });
    writeFileSync(now, "// hub");
    expect(installNativeHost({ home, platform: "darwin", node, hubScript: now }).installed).toEqual([expect.objectContaining({ browser: "Chrome", hubWasMissing: hub })]);
  });

  it("#123: Windows: reads the Node and hub back from the .bat, folder variables and doubled % undone", () => {
    mk(...WIN_CHROME);
    const env = { ...winEnv(), APPDATA: join(home, "AppData", "Roaming") };
    const node = fakeNode("AppData", "Roaming", "nvm", "v20 100%", "node.exe");
    const registry = fakeRegistry();
    installNativeHost({ ...winOpts(registry), env, node });
    expect(readFileSync(join(home, "AppData", "Local", "mcp-teams", "mcp-teams-hub.bat"), "utf8")).toContain('"%APPDATA%\\nvm\\v20 100%%\\node.exe"');
    expect(registeredHosts({ home, platform: "win32", env, regQuery: registry.regQuery })).toEqual([
      expect.objectContaining({ browser: "Chrome", node: win(node), hub: win(hub) }),
    ]);
  });

  it.runIf(ON_WINDOWS)("#123: Windows: a Node gone from under the .bat is reported, and setup says so when it registers again", () => {
    mk(...WIN_CHROME);
    const registry = fakeRegistry();
    const old = fakeNode("AppData", "Local", "fnm", "v20.1", "node.exe");
    installNativeHost({ ...winOpts(registry), node: old });
    expect(registeredHosts({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery })[0]).toMatchObject({ nodeExists: true, hubExists: true });
    rmSync(old);
    expect(registeredHosts({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery })[0].nodeExists).toBe(false);
    const now = fakeNode("AppData", "Local", "fnm", "v20.2", "node.exe");
    const r = installNativeHost({ ...winOpts(registry), node: now });
    expect(r.installed).toEqual([expect.objectContaining({ browser: "Chrome", changed: true, nodeWasMissing: old })]);
    expect(registeredHosts({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery })[0]).toMatchObject({ node: now, nodeExists: true });
  });

  it("#123: Windows: a browser is registered only when its HKCU key names the manifest (Edge installed after setup)", () => {
    mk(...WIN_CHROME);
    const registry = fakeRegistry();
    installNativeHost({ ...winOpts(registry), node: fakeNode("node.exe") });
    mk(...WIN_EDGE); // Edge came later: the shared manifest and .bat are there, its key isn't
    const hosts = registeredHosts({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery });
    expect(hosts.map((h) => [h.browser, h.keyMissing ?? false])).toEqual([
      ["Chrome", false],
      ["Edge", true],
    ]);
    const report = nativeHostReport({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery });
    expect(report).toMatchObject({ registered: ["Chrome"], keyMissing: ["Edge"] });
    expect(report.hint).toContain("Edge has no registry key for the native host (installed after setup?)");
    expect(report.hint).toContain("Run `npx mcp-teams setup` again.");
    // A key naming another file counts as missing too.
    registry.keys.set(CHROME_KEY, "C:\\elsewhere\\com.mcp_teams.hub.json");
    expect(nativeHostReport({ home, platform: "win32", env: winEnv(), regQuery: registry.regQuery }).keyMissing).toEqual(["Chrome", "Edge"]);
  });

  it("#123: a host launcher it can't read paths from is reported with null, not as gone", () => {
    mk(...MAC_CHROME);
    installNativeHost({ home, platform: "darwin", node: fakeNode("node"), hubScript: hub });
    writeFileSync(join(home, ...MAC_CHROME, "NativeMessagingHosts", "mcp-teams-hub"), "#!/bin/sh\necho edited by hand\n");
    expect(registeredHosts({ home, platform: "darwin" })).toEqual([{ browser: "Chrome", node: null, nodeExists: null, hub: null, hubExists: null }]);
    expect(nativeHostReport({ home, platform: "darwin" })).toEqual({ registered: ["Chrome"] });
  });

  it("#123: a registration whose Node and hub are still there says nothing of them", () => {
    mk(...MAC_CHROME);
    const node = fakeNode("node");
    installNativeHost({ home, platform: "darwin", node, hubScript: hub });
    const [again] = installNativeHost({ home, platform: "darwin", node, hubScript: hub }).installed;
    expect(again).not.toHaveProperty("nodeWasMissing");
    expect(again).not.toHaveProperty("hubWasMissing");
  });
});

describe("#123: reg itself", () => {
  // libuv looks for a bare "reg" in the current folder first; a planted reg.exe there would run.
  it("#123: is started by its full path under %SystemRoot%", () => {
    expect(regExe({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\reg.exe");
    expect(regExe({ SYSTEMROOT: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\reg.exe");
    expect(regExe({})).toBe("C:\\Windows\\System32\\reg.exe");
  });

  it("#123: reads a key's default value out of reg query's output, whatever the language of (Default)", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mcp_teams.hub\r\n    (기본값)    REG_SZ    C:\\Users\\alex\\AppData\\Local\\mcp-teams\\com.mcp_teams.hub.json\r\n\r\n";
    expect(regDefaultValue(out)).toBe("C:\\Users\\alex\\AppData\\Local\\mcp-teams\\com.mcp_teams.hub.json");
    expect(regDefaultValue("\r\nHKEY_CURRENT_USER\\Software\\x\r\n    (Default)    REG_SZ    \r\n")).toBeNull();
  });
});
