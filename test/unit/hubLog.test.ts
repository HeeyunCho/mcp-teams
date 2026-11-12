// The native host's log (#123 decision 6): ~/.mcp-teams/hub.log (0600), rotated to hub.log.1
// once it passes 1 MB, with metadata only (type, method, ok, bytes, ms), never message text.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorFields, HUB_LOG_MAX_BYTES, hubLog, logVersion, rotate, trafficLogger } from "../../src/hubLog.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "mt-log-"));
  dirs.push(d);
  return d;
};

describe("#123: hub.log", () => {
  it("writes one line per event: time, pid, event, then its fields", () => {
    const dir = tempDir();
    const log = hubLog(join(dir, "hub.log"));
    log("host", { version: "0.3.56", port: 47393, missing: undefined });
    expect(readFileSync(join(dir, "hub.log"), "utf8")).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z pid=${process.pid} host version=0\\.3\\.56 port=47393\\n$`));
  });

  it("is 1 MB before it rotates", () => {
    expect(HUB_LOG_MAX_BYTES).toBe(1_048_576);
  });

  it("once past 1 MB, moves to hub.log.1 (replacing an older one) and starts a new hub.log", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    writeFileSync(`${file}.1`, "the previous rotation\n");
    writeFileSync(file, "x".repeat(HUB_LOG_MAX_BYTES + 1));
    hubLog(file)("exit", { reason: "no extension" });
    expect(statSync(`${file}.1`).size).toBe(HUB_LOG_MAX_BYTES + 1);
    expect(readFileSync(file, "utf8")).toMatch(/ exit reason=no extension\n$/);
    expect(statSync(file).size).toBeLessThan(200);
  });

  it("keeps appending while it is at most 1 MB", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    writeFileSync(file, "x".repeat(HUB_LOG_MAX_BYTES));
    hubLog(file)("relay");
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(statSync(file).size).toBeGreaterThan(HUB_LOG_MAX_BYTES);
  });

  it.skipIf(process.platform === "win32")("is created 0600 in a 0700 folder", () => {
    const dir = join(tempDir(), "home");
    const file = join(dir, "hub.log");
    hubLog(file)("host");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "x".repeat(HUB_LOG_MAX_BYTES + 1));
    hubLog(file)("host");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never stops the host: a log it can't write is skipped", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "not-a-folder"), "");
    expect(() => hubLog(join(dir, "not-a-folder", "hub.log"))("host")).not.toThrow();
  });
});

describe("#143: rotation with other processes and other programs", () => {
  const lineCount = (dir: string) =>
    readdirSync(dir)
      .filter((f) => f.startsWith("hub.log") && statSync(join(dir, f)).isFile())
      .reduce((n, f) => n + readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).length, 0);

  it("while .1 can't be replaced (held open by another program), leaves the rotated log aside once instead of copying it back on every line", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    mkdirSync(`${file}.1`); // a .1 nothing can be renamed over
    const log = hubLog(file, 1_000);
    for (let i = 0; i < 100; i++) log("line", { i }); // ~55 bytes a line: past the cap about five times
    // Each time the log passed the cap it was set aside once; the live log never grew past the cap and a line.
    expect(statSync(file).size).toBeLessThan(1_000 + 100);
    expect(readdirSync(dir).filter((f) => f.endsWith(".rotating")).length).toBeGreaterThanOrEqual(4);
    expect(lineCount(dir)).toBe(100);
  });

  it("puts a small log back when another process rotated first, so its lines stay in the live log", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    writeFileSync(`${file}.1`, "x".repeat(2_000)); // the other process's rotation
    writeFileSync(file, "a line written since\n");
    // This process saw the big log just before the other one moved it.
    rotate(file, 1_000, 2_000);
    expect(readFileSync(file, "utf8")).toBe("a line written since\n");
    expect(statSync(`${file}.1`).size).toBe(2_000);
    expect(readdirSync(dir).sort()).toEqual(["hub.log", "hub.log.1"]);
  });

  // #152: a process that opened the log before another one's rotation writes its line late, into
  // whatever file the log was moved to. That file must stay part of the log.
  it("#152: keeps a line another process wrote late, through a log it opened before this one rotated", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    writeFileSync(`${file}.1`, "x".repeat(2_000)); // the other process's rotation
    writeFileSync(file, "a line written since\n");
    const late = openSync(file, "a"); // a third process, about to append
    // This process saw the big log just before the other one moved it.
    rotate(file, 1_000, 2_000);
    writeSync(late, "a late line\n");
    closeSync(late);
    expect(readFileSync(file, "utf8")).toBe("a line written since\na late line\n");
    expect(statSync(`${file}.1`).size).toBe(2_000);
    expect(readdirSync(dir).sort()).toEqual(["hub.log", "hub.log.1"]);
  });

  it("#152: waits while another process rotates, but not for one that died rotating", () => {
    const dir = tempDir();
    const file = join(dir, "hub.log");
    writeFileSync(file, "x".repeat(2_000));
    writeFileSync(`${file}.lock`, ""); // another process is rotating
    rotate(file, 1_000);
    expect(readdirSync(dir).sort()).toEqual(["hub.log", "hub.log.lock"]);
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, minuteAgo, minuteAgo); // it died a minute ago
    rotate(file, 1_000);
    rotate(file, 1_000);
    expect(readdirSync(dir).sort()).toEqual(["hub.log.1"]);
    expect(statSync(`${file}.1`).size).toBe(2_000);
  });
});

describe("#123: errors and versions in hub.log", () => {
  it("logs an error by its name and code only, never its message (a JSON.parse message quotes its input)", () => {
    let parseError: Error;
    try {
      JSON.parse('{"text":"Contoso merger: confidential"');
    } catch (err) {
      parseError = err as Error;
    }
    expect(errorFields(parseError!)).toEqual({ name: "SyntaxError", code: undefined });
    const io = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:47393"), { code: "EADDRINUSE" });
    expect(errorFields(io)).toEqual({ name: "Error", code: "EADDRINUSE" });
    expect(errorFields("thrown text about Sam Roe")).toEqual({ name: "string", code: undefined });
    expect(errorFields(Object.assign(new Error("x"), { code: "E BAD; rm -rf" }))).toEqual({ name: "Error", code: "EBADrm-rf" });
  });

  it("logs a version another program sent only as version characters", () => {
    expect(logVersion("0.3.52")).toBe("0.3.52");
    expect(logVersion('0.3.52 secret="Contoso"\nforged line')).toBe("0.3.52secretContosoforgedline".slice(0, 32));
    expect(logVersion(undefined)).toBe("unknown");
    expect(logVersion("9".repeat(100))).toHaveLength(32);
  });
});

describe("#123: traffic lines", () => {
  const capture = () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const traffic = trafficLogger((event, fields = {}) => lines.push({ event, fields }));
    return { lines, traffic };
  };

  it("logs a request's type, method and size, and its answer's ok and time, never their text", () => {
    const { lines, traffic } = capture();
    const request = JSON.stringify({ type: "request", id: "r-1", method: "readMessages", params: { chatId: "19:secret-chat@thread.v2" }, timeoutMs: 1000 });
    const answer = JSON.stringify({ type: "response", id: "r-1", ok: true, result: { messages: [{ text: "Contoso merger: confidential" }] } });
    traffic("out", request);
    traffic("in", Buffer.from(answer));
    expect(lines[0]).toEqual({ event: "to-extension", fields: { type: "request", method: "readMessages", ok: undefined, bytes: Buffer.byteLength(request), ms: undefined } });
    expect(lines[1].event).toBe("from-extension");
    expect(lines[1].fields).toMatchObject({ type: "response", method: undefined, ok: "true", bytes: Buffer.byteLength(answer) });
    expect(lines[1].fields.ms).toEqual(expect.any(Number));
    expect(JSON.stringify(lines)).not.toMatch(/Contoso|secret-chat|r-1/);
  });

  it("logs a failed answer as ok=false, without its error text", () => {
    const { lines, traffic } = capture();
    traffic("in", JSON.stringify({ type: "response", id: "r-2", ok: false, error: "Chat with Sam Roe not found" }));
    expect(lines[0].fields).toMatchObject({ type: "response", ok: "false" });
    expect(JSON.stringify(lines)).not.toMatch(/Sam Roe|not found/);
  });

  it("skips pings, and logs only word characters of a method", () => {
    const { lines, traffic } = capture();
    traffic("out", JSON.stringify({ type: "ping" }));
    traffic("out", '{"type":"request","id":"x","method":"list Chats \\" injected"}');
    expect(lines).toHaveLength(1);
    expect(lines[0].fields.method).toBeUndefined();
  });
});
