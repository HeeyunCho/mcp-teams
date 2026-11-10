// The native host's log (#123 decision 6): ~/.mcp-teams/hub.log (0600), rotated to hub.log.1
// once it passes 1 MB, with metadata only (type, method, ok, bytes, ms), never message text.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_LOG_MAX_BYTES, hubLog, trafficLogger } from "../../src/hubLog.js";

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
