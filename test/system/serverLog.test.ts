// #143: server.log as the built code (dist/) writes it: from many processes at once, and from a
// real server's start, extension connect/disconnect, a failed tool call and exit.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { until } from "../helpers/timing.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "mt-slog-sys-"));
  dirs.push(d);
  return d;
};
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<number | null>((done) => {
    const p = spawn(process.execPath, args, { stdio: "ignore", env: { ...process.env, ...env } });
    p.on("exit", (code) => done(code));
  });

describe("#143: many processes appending to one log", () => {
  // Two processes that see the big file at once both rotate it; renaming straight to .1, the second
  // moved the first's fresh file over the rotated one and lost ~2,000 of these lines (a run on
  // Windows). Each now claims the file under its own name first (hubLog's rotate).
  it("keeps every line whole and loses none when ten processes cross the size cap together", async () => {
    const dir = tempDir();
    const file = join(dir, "server.log");
    const hubLogUrl = pathToFileURL(resolve("dist/hubLog.js")).href;
    const PROCESSES = 10;
    const LINES = 300;
    // ~50 bytes a line: 10 × 300 lines is ~150 KB, so the 100 KB cap is crossed once, by everyone at about the same time.
    const script = `
      import { hubLog } from ${JSON.stringify(hubLogUrl)};
      const log = hubLog(process.env.LOG_FILE, 100_000);
      // All start writing at the same moment, so they cross the cap together.
      while (Date.now() < Number(process.env.GO)) {}
      for (let i = 0; i < ${LINES}; i++) log("line", { p: process.env.P, i });
    `;
    const go = String(Date.now() + 3_000);
    const codes = await Promise.all(
      Array.from({ length: PROCESSES }, (_, p) => run(["--input-type=module", "-e", script], { LOG_FILE: file, P: String(p), GO: go })),
    );
    expect(codes).toEqual(Array(PROCESSES).fill(0));
    const lines = [file, `${file}.1`].flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []));
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z pid=\d+ line p=\d i=\d+$/);
    expect(new Set(lines.map((l) => l.replace(/^\S+ pid=\d+ /, ""))).size).toBe(PROCESSES * LINES);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["server.log", "server.log.1"]); // no claim left behind
  }, 60_000);
});

describe("#143: a real server's server.log", () => {
  it("records start, role, the extension coming and going, the Teams state, a failed call and the exit, with no message text", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", port: 0 }));
    const client = new Client({ name: "test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, TEAMS_MCP_HOME: home } as Record<string, string>,
      stderr: "ignore",
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
    const port = JSON.parse((await call("get_version")).content[0].text).port;

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://fake" });
    await new Promise<void>((welcomed) => {
      ext.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") ext.send(JSON.stringify({ type: "hello", token: "tok", version: "0.3.62", browser: "Chrome" }));
        if (msg.type === "welcome") welcomed();
        if (msg.type !== "request") return;
        if (msg.method === "status")
          ext.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { teamsTabs: 1, sessions: [{ sessionCaptured: true }], services: { chatsvc: "2026-11-11T06:19:00Z", csa: null }, signedInAs: "8:orgid:00000000-0000-0000-0000-00000000aaaa", region: "emea" } }));
        else ext.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: 'No chat or channel matches "Contoso merger with Sam Roe" (19:secret-chat@thread.v2).' }));
      });
    });
    await call("get_version");
    await call("get_version"); // the same state again: no second line
    expect((await call("read_messages", { conversation: "Contoso merger with Sam Roe" })).isError).toBe(true);
    ext.close(1000);
    const logFile = join(home, "server.log");
    const lines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
    await until(() => lines().some((l) => / extension-closed /.test(l)), 10_000, "the extension's close in server.log");
    await client.close();
    await until(() => lines().some((l) => / exit /.test(l)), 10_000, "the exit in server.log");

    const events = lines().map((l) => l.replace(/^\S+ pid=\d+ /, "").replace(/ v=\S+/, "").replace(/ ms=\d+/, " ms=N").replace(/ node=\S+/, ""));
    expect(events).toEqual([
      "start role=none command=serve",
      "role role=hub via=tcp",
      "extension-connected role=hub ext=0.3.62 transport=websocket",
      "extensions role=hub count=1 transport=websocket",
      "teams role=hub tabs=1 captured=yes services=chatsvc account=first",
      "tool role=hub name=read_messages ok=no ms=N error=Error kind=other",
      "extension-closed role=hub code=1000 transport=websocket",
      "extensions role=hub count=0",
      "exit role=hub reason=stdin-closed code=0",
    ]);
    expect(lines().join("\n")).not.toMatch(/Contoso|Sam|Roe|secret-chat|orgid|aaaa|emea|tok\b/);
  }, 60_000);

  it("logs the Teams state going stale as the hub, with no tool call at all (the 2026-11-11 night)", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", port: 0 }));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        env: { ...process.env, TEAMS_MCP_HOME: home, TEAMS_MCP_WATCH_MS: "100" } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    // Only to learn the port: get_version reads no status while no extension is connected.
    const port = JSON.parse(((await client.callTool({ name: "get_version", arguments: {} })) as any).content[0].text).port;
    let signedIn = "2026-11-11T00:03:00.000Z"; // fresh, until the session goes bad
    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://fake" });
    ext.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") ext.send(JSON.stringify({ type: "hello", token: "tok", version: "0.3.62", browser: "Chrome" }));
      if (msg.type === "request" && msg.method === "status")
        ext.send(
          JSON.stringify({
            type: "response",
            id: msg.id,
            ok: true,
            result: {
              teamsTabs: 1,
              sessions: [{ sessionCaptured: true }],
              services: { chatsvc: "2026-11-11T00:00:00Z" },
              lastTeamsCall: { at: "2026-11-11T00:04:00.000Z", host: "teams.cloud.microsoft" },
              lastSignedInCall: { at: signedIn, host: "teams.cloud.microsoft" },
            },
          }),
        );
    });
    const logFile = join(home, "server.log");
    const teams = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((l) => / teams /.test(l)) : []);
    await until(() => teams().length === 1, 10_000, "the first background read");
    signedIn = "2026-11-10T23:50:00.000Z"; // no signed-in call for 14 minutes while the tab keeps calling
    await until(() => teams().length === 2, 10_000, "the stale session");
    expect(teams().map((l) => l.replace(/^\S+ pid=\d+ /, "").replace(/ v=\S+/, ""))).toEqual([
      "teams role=hub tabs=1 captured=yes services=chatsvc stale=no account=none",
      "teams role=hub tabs=1 captured=yes services=chatsvc stale=yes account=none",
    ]);
    ext.close(1000);
    await client.close();
  }, 60_000);
});
