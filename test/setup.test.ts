import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAddCommand, claudeLookupFailure, cmdQuote, commandInvocation, noAppHint, openCommand, quote, registerNext, windowsHas } from "../src/setup.js";

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
    expect(claudeLookupFailure(spawnError("ENOENT"))).toBe("missing");
  });

  it("treats a non-zero exit of `claude mcp get` as not registered", () => {
    expect(claudeLookupFailure(exitError(1))).toBe("not-registered");
  });

  it("reports a CLI that could not be started (EINVAL, EACCES) instead of planning to add", () => {
    expect(claudeLookupFailure(spawnError("EINVAL"))).toBe("broken");
    expect(claudeLookupFailure(spawnError("EACCES"))).toBe("broken");
  });
});

describe("claudeAddCommand", () => {
  it("is the full command to register by hand, server command included", () => {
    expect(claudeAddCommand({ command: "/usr/local/bin/node", args: ["/Users/alex/mcp-teams/dist/index.js"] })).toBe(
      "claude mcp add --scope user teams -- /usr/local/bin/node /Users/alex/mcp-teams/dist/index.js",
    );
    expect(claudeAddCommand({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\Alex Doe\\index.js"] }, "win32")).toBe(
      'claude mcp add --scope user teams -- "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alex Doe\\index.js"',
    );
    expect(claudeAddCommand({ command: "npx", args: ["-y", "mcp-teams@latest"] })).toBe("claude mcp add --scope user teams -- npx -y mcp-teams@latest");
  });
});

describe("#24: quote", () => {
  describe.each(["darwin", "linux"] as const)("on %s", (platform) => {
    it("#24: wraps a space, $, a backtick and & in single quotes", () => {
      expect(quote("/Users/Alex Doe/index.js", platform)).toBe("'/Users/Alex Doe/index.js'");
      expect(quote("/Users/$alex/index.js", platform)).toBe("'/Users/$alex/index.js'");
      expect(quote("/Users/al`ex/index.js", platform)).toBe("'/Users/al`ex/index.js'");
      expect(quote("/Users/Alex&Sam/index.js", platform)).toBe("'/Users/Alex&Sam/index.js'");
    });

    it("#24: writes an embedded single quote as '\\''", () => {
      expect(quote("/Users/Alex's/index.js", platform)).toBe("'/Users/Alex'\\''s/index.js'");
    });

    it("#24: quotes any other character outside the safe set", () => {
      for (const arg of ['a"b', "a\\b", "a(b)", "a;b", "a*b", "a~b", "a\tb", "Zoë"]) expect(quote(arg, platform)).toBe(`'${arg}'`);
    });

    it("#24: leaves the safe set unquoted, % included", () => {
      expect(quote("Az09_@%+=:,./-", platform)).toBe("Az09_@%+=:,./-");
      expect(quote("mcp-teams@latest", platform)).toBe("mcp-teams@latest");
    });
  });

  describe("on Windows", () => {
    it("#24: wraps whitespace, &, %, $ and a backtick in double quotes", () => {
      expect(quote("C:\\Users\\Alex Doe\\index.js", "win32")).toBe('"C:\\Users\\Alex Doe\\index.js"');
      expect(quote("C:\\Users\\Alex\tDoe\\index.js", "win32")).toBe('"C:\\Users\\Alex\tDoe\\index.js"');
      expect(quote("C:\\Users\\Alex&Sam\\index.js", "win32")).toBe('"C:\\Users\\Alex&Sam\\index.js"');
      expect(quote("C:\\Users\\Alex%20Doe\\index.js", "win32")).toBe('"C:\\Users\\Alex%20Doe\\index.js"');
      expect(quote("C:\\Users\\$alex\\index.js", "win32")).toBe('"C:\\Users\\$alex\\index.js"');
      expect(quote("C:\\Users\\al`ex\\index.js", "win32")).toBe('"C:\\Users\\al`ex\\index.js"');
    });

    it("#76: wraps a single quote and ; in double quotes", () => {
      expect(quote("C:\\Users\\Alex's\\index.js", "win32")).toBe(`"C:\\Users\\Alex's\\index.js"`);
      expect(quote("C:\\Users\\Alex;Sam\\index.js", "win32")).toBe('"C:\\Users\\Alex;Sam\\index.js"');
    });

    it("#24: leaves everything else unquoted, a backslash included", () => {
      for (const arg of ["C:\\nodejs\\node.exe", "-y", "mcp-teams@latest"]) expect(quote(arg, "win32")).toBe(arg);
    });
  });

  // A real shell reads back what was printed, so the expected text above isn't the only check.
  it.runIf(process.platform !== "win32")("#24: a POSIX shell reads a quoted argument back byte for byte", () => {
    for (const arg of ["/Users/Alex Doe/x", "$HOME", "`id`", "a&b", "Alex's", "it''s", "a\\b", 'a"b', "a;b", "*", "~", "50%"]) {
      expect(execFileSync("/bin/sh", ["-c", `printf %s ${quote(arg, "linux")}`], { encoding: "utf8" })).toBe(arg);
    }
  });

  // PowerShell, as when a printed command is pasted into a Windows terminal. $ and a
  // backtick stay out: they still expand inside double quotes, which #24 accepted. The
  // command goes in encoded, so nothing between here and PowerShell's parser re-quotes it.
  it.runIf(process.platform === "win32")("#76: PowerShell reads each quoted argument back byte for byte", { timeout: 20_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "quote-"));
    const script = join(dir, "argv.js");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const args = [
      "C:\\Users\\Alex Doe\\x",
      "a&b",
      "50%",
      "C:\\Users\\Alex's\\index.js",
      "C:\\Users\\Alex;Sam\\index.js",
      "C:\\nodejs\\node.exe",
      "-y",
      "mcp-teams@latest",
    ];
    const command = ["node", script, ...args].map((part) => quote(part, "win32")).join(" ");
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
      expect(JSON.parse(out)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A quoted first word is a string to PowerShell, not a command: pasted as printed,
  // `"C:\Program Files\nodejs\node.exe" x` fails with "Unexpected token". The node here
  // is this one, copied into a folder with a space so its path gets quoted. (Not a hard
  // link: that shares the running node.exe, and Windows then refuses to delete it.)
  it.runIf(process.platform === "win32")('#138: PowerShell runs the "No AI app found" command when node\'s path is quoted', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "quote first-"));
    const node = join(dir, "node.exe");
    copyFileSync(process.execPath, node);
    const script = join(dir, "argv.js");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const hint = noAppHint({ command: node, args: [script, "C:\\Users\\Alex Doe\\x", "-y"] }, "win32");
    const command = hint.slice(hint.indexOf(": ") + 2);
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
      expect(JSON.parse(out)).toEqual(["C:\\Users\\Alex Doe\\x", "-y"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#24: printed commands quote for the platform", () => {
  const spaced = { command: "/Users/Alex Doe/$bin/node", args: ["/Users/Alex's/index.js"] };
  const windows = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\Alex&Sam\\index.js", "C:\\Users\\Alex%20Doe\\x", "-y"] };

  it("#24: claudeAddCommand", () => {
    expect(claudeAddCommand(spaced, "linux")).toBe("claude mcp add --scope user teams -- '/Users/Alex Doe/$bin/node' '/Users/Alex'\\''s/index.js'");
    expect(claudeAddCommand(windows, "win32")).toBe(
      'claude mcp add --scope user teams -- "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alex&Sam\\index.js" "C:\\Users\\Alex%20Doe\\x" -y',
    );
  });

  it('#24: the "No AI app found" hint', () => {
    expect(noAppHint(spaced, "darwin")).toBe("No AI app found. Register this stdio server with yours: '/Users/Alex Doe/$bin/node' '/Users/Alex'\\''s/index.js'");
    expect(noAppHint(windows, "win32")).toBe(
      'No AI app found. Register this stdio server with yours (PowerShell; in cmd.exe, leave out the leading &): & "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alex&Sam\\index.js" "C:\\Users\\Alex%20Doe\\x" -y',
    );
  });

  it("#138: on Windows, an unquoted first word gets no & and no note", () => {
    expect(noAppHint({ command: "C:\\nodejs\\node.exe", args: ["C:\\Users\\Alex Doe\\index.js"] }, "win32")).toBe(
      'No AI app found. Register this stdio server with yours: C:\\nodejs\\node.exe "C:\\Users\\Alex Doe\\index.js"',
    );
  });

  it.each(["darwin", "linux", "win32"] as const)("#24: npx -y mcp-teams@latest prints unchanged on %s", (platform) => {
    const npx = { command: "npx", args: ["-y", "mcp-teams@latest"] };
    expect(claudeAddCommand(npx, platform)).toBe("claude mcp add --scope user teams -- npx -y mcp-teams@latest");
    expect(noAppHint(npx, platform)).toBe("No AI app found. Register this stdio server with yours: npx -y mcp-teams@latest");
  });
});

describe("registerNext", () => {
  const unchanged = { text: undefined };
  const toWrite = { text: "{}" };

  it("says no AI app was found only when nothing was found", () => {
    expect(registerNext(null, [])).toBe("none-found");
  });

  it("does not claim no AI app was found when Claude Code's CLI could not be started", () => {
    expect(registerNext("broken", [])).toBe("stop");
  });

  it("does not claim every app is registered when Claude Code's CLI could not be started", () => {
    expect(registerNext("broken", [unchanged])).toBe("stop");
    expect(registerNext("broken", [toWrite])).toBe("ask");
  });

  it("asks when there is something to add or update", () => {
    expect(registerNext({ status: "added" }, [])).toBe("ask");
    expect(registerNext({ status: "updated", scope: "local" }, [unchanged])).toBe("ask");
    expect(registerNext(null, [toWrite])).toBe("ask");
  });

  it("reports everything registered when nothing needs changing", () => {
    expect(registerNext({ status: "unchanged" }, [])).toBe("up-to-date");
    expect(registerNext({ status: "foreign" }, [unchanged])).toBe("up-to-date");
    expect(registerNext(null, [unchanged])).toBe("up-to-date");
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
// (like npm's claude.cmd) and a native .exe (node.exe) byte for byte. These start real cmd,
// node and where.exe processes, which can take seconds each on a loaded machine or runner,
// so they get more than vitest's default 5 s.
describe.runIf(process.platform === "win32")("commandInvocation on Windows", { timeout: 20_000 }, () => {
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
