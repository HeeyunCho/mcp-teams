import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeLookupFailure, cmdQuote, commandInvocation, openCommand, windowsHas } from "../src/setup.js";

// Paths cmd.exe would otherwise split (&), expand (%...%) or treat specially (^ ( ) !).
const tricky = [
  "C:\\Users\\Alex & Sam\\AppData\\Roaming\\npm\\node_modules\\mcp-teams\\dist\\index.js",
  "C:\\Users\\Alex%20Doe\\mcp-teams\\dist\\index.js",
  "C:\\Users\\Alex Doe\\%PATH%\\x",
  "C:\\Program Files (x86)\\nodejs\\node.exe",
  "C:\\Users\\Alex^Doe\\!x!\\a;b,c",
  "C:\\Users\\Alex Doe\\folder\\",
  "-y",
];

describe("commandInvocation", () => {
  it("runs the program directly on macOS and Linux, unchanged", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(commandInvocation("claude", ["mcp", "get", "teams"], platform)).toEqual({
        file: "claude",
        args: ["mcp", "get", "teams"],
        options: {},
      });
    }
  });

  it("on Windows goes through cmd.exe, so claude.cmd (npm) and claude.exe are both found", () => {
    const inv = commandInvocation("claude", ["mcp", "get", "teams"], "win32", "C:\\Windows\\system32\\cmd.exe");
    expect(inv.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/v:off", "/s", "/c", '"claude ^"mcp^" ^"get^" ^"teams^""']);
    expect(inv.options).toEqual({ windowsVerbatimArguments: true, windowsHide: true });
  });

  it("falls back to cmd.exe without ComSpec", () => {
    expect(commandInvocation("claude", [], "win32", "").file).toBe("cmd.exe");
  });

  it("escapes every argument for cmd: no &, %, ^, ( ) or ! reaches cmd unescaped", () => {
    const inv = commandInvocation("claude", ["mcp", "add", "--", ...tricky], "win32", "cmd.exe");
    const line = inv.args[4];
    // Strip cmd's escapes; every remaining metacharacter must have been preceded by ^.
    expect(line.slice(1, -1).replace(/\^./g, "")).toMatch(/^claude[^&%^()!|<>"]*$/);
  });
});

describe("cmdQuote", () => {
  it("quotes for the program and escapes cmd's metacharacters", () => {
    expect(cmdQuote("teams")).toBe('^"teams^"');
    expect(cmdQuote("C:\\Users\\Alex & Sam\\x.js")).toBe('^"C:\\Users\\Alex^ ^&^ Sam\\x.js^"');
    expect(cmdQuote("C:\\Users\\Alex%20Doe")).toBe('^"C:\\Users\\Alex^%20Doe^"');
    expect(cmdQuote("C:\\Program Files (x86)")).toBe('^"C:\\Program^ Files^ ^(x86^)^"');
  });

  it("doubles trailing backslashes so they don't escape the closing quote", () => {
    expect(cmdQuote("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  });

  it("refuses arguments it cannot pass through a .cmd file safely", () => {
    expect(() => cmdQuote('say "hi"')).toThrow();
    expect(() => cmdQuote("a\nb")).toThrow();
  });
});

describe("claudeLookupFailure", () => {
  const spawnError = (code: string) => Object.assign(new Error(`spawn claude ${code}`), { code });
  const exitError = (status: number) => Object.assign(new Error("Command failed"), { status });

  it("treats a missing CLI as missing", () => {
    expect(claudeLookupFailure(spawnError("ENOENT"), "darwin")).toBe("missing");
    // cmd.exe: "'claude' is not recognized as an internal or external command".
    expect(claudeLookupFailure(exitError(9009), "win32")).toBe("missing");
  });

  it("treats a non-zero exit of `claude mcp get` as not registered", () => {
    expect(claudeLookupFailure(exitError(1), "win32")).toBe("not-registered");
    expect(claudeLookupFailure(exitError(1), "linux")).toBe("not-registered");
  });

  it("reports a CLI that could not be started (EINVAL, EACCES) instead of planning to add", () => {
    expect(claudeLookupFailure(spawnError("EINVAL"), "win32")).toBe("broken");
    expect(claudeLookupFailure(spawnError("EACCES"), "linux")).toBe("broken");
  });
});

describe("openCommand", () => {
  const chrome = { name: "Chrome" as const, page: "chrome://extensions", devMode: "top right" };
  const edge = { name: "Edge" as const, page: "edge://extensions", devMode: "in the left sidebar" };

  it("keeps macOS and Linux as they were", () => {
    expect(openCommand("/Users/alex/.mcp-teams/extension", undefined, "darwin")).toEqual(["open", ["/Users/alex/.mcp-teams/extension"]]);
    expect(openCommand("chrome://extensions", chrome, "darwin")).toEqual(["open", ["-a", "Google Chrome", "chrome://extensions"]]);
    expect(openCommand("edge://extensions", edge, "darwin")).toEqual(["open", ["-a", "Microsoft Edge", "edge://extensions"]]);
    expect(openCommand("/home/alex/.mcp-teams/extension", undefined, "linux")).toEqual(["xdg-open", ["/home/alex/.mcp-teams/extension"]]);
    expect(openCommand("chrome://extensions", chrome, "linux")).toEqual(["google-chrome", ["chrome://extensions"]]);
    expect(openCommand("edge://extensions", edge, "linux")).toEqual(["microsoft-edge", ["edge://extensions"]]);
  });

  it("on Windows opens folders with explorer.exe, never through cmd", () => {
    for (const dir of ["C:\\Users\\Alex & Sam\\.mcp-teams\\extension", "C:\\Users\\Alex%20Doe\\.mcp-teams\\extension"]) {
      expect(openCommand(dir, undefined, "win32")).toEqual(["explorer.exe", [dir]]);
    }
  });

  it("on Windows starts the browser's own exe with its extensions page", () => {
    const exe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(openCommand("edge://extensions", { ...edge, exe }, "win32")).toEqual([exe, ["edge://extensions"]]);
    // No exe found: nothing to start (the printed instructions say where to go).
    expect(openCommand("chrome://extensions", chrome, "win32")).toBeNull();
  });
});

// The real thing, on the Windows CI runner: arguments survive cmd.exe and a .cmd shim
// (like npm's claude.cmd) and a native .exe (node.exe) byte for byte.
describe.runIf(process.platform === "win32")("commandInvocation on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "Alex & Sam %OS% ("));
  const script = join(dir, "argv.js");
  writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  writeFileSync(join(dir, "fakeclaude.cmd"), `@echo off\r\nnode "%~dp0argv.js" %*\r\n`);
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
  const run = (program: string, args: string[]) => {
    const inv = commandInvocation(program, args);
    return JSON.parse(execFileSync(inv.file, inv.args, { ...inv.options, env, encoding: "utf8" }));
  };

  it("through a .cmd shim", () => {
    expect(run("fakeclaude", ["mcp", "add", "--", ...tricky])).toEqual(["mcp", "add", "--", ...tricky]);
  });

  it("to a native exe", () => {
    expect(run("node", [script, ...tricky])).toEqual(tricky);
  });

  it("finds a .cmd shim on PATH and reports a missing program as missing", () => {
    expect(windowsHas("fakeclaude", env)).toBe(true);
    expect(windowsHas("no-such-claude-alex-doe", env)).toBe(false);
  });
});
