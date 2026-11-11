// #143: every server's diagnostic log, ~/.mcp-teams/server.log: one line per event, metadata only
// (never message text, names, tokens or chat ids), logged on change, never throwing.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticLog } from "../../src/serverLog.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = (opts: { slowToolMs?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "mt-slog-"));
  dirs.push(dir);
  const file = join(dir, "server.log");
  let role = "none";
  const log = diagnosticLog({ file, version: "0.3.62", role: () => role, ...opts });
  const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean);
  return { file, log, lines, setRole: (r: string) => (role = r) };
};

describe("#143: server.log lines", () => {
  it("writes time, pid, event, then the server's version and role, then the event's fields", () => {
    const { log, lines } = setup();
    log.start({ command: "serve" });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z pid=${process.pid} start v=0\\.3\\.62 role=none command=serve node=v\\d+`));
  });

  it("logs an exit with its reason and code", () => {
    const { log, lines } = setup();
    log.exit("stdin-closed", 0);
    expect(lines()[0]).toMatch(/ exit v=0\.3\.62 role=none reason=stdin-closed code=0$/);
  });

  it("logs a role change once, with how it reached the hub, and the hand-over to a newer server", () => {
    const { log, lines, setRole } = setup();
    setRole("peer");
    log.bridge("role", { role: "peer", via: "tcp", hub: "0.3.61" });
    log.bridge("role", { role: "peer", via: "tcp", hub: "0.3.61" });
    setRole("hub");
    log.bridge("role", { role: "hub", via: "tcp" });
    log.bridge("handover", { to: "0.3.63" });
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual([
      "role v=0.3.62 role=peer via=tcp hub=0.3.61",
      "role v=0.3.62 role=hub via=tcp",
      "handover v=0.3.62 role=hub to=0.3.63",
    ]);
  });

  it("logs the connected extensions when they change, with each of their transports", () => {
    const { log, lines } = setup();
    log.bridge("extensions", { count: 2, transport: "native,websocket" });
    log.bridge("extensions", { count: 2, transport: "native,websocket" });
    log.bridge("extension-closed", { code: 1006, transport: "native" });
    log.bridge("extensions", { count: 1, transport: "websocket" });
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual([
      "extensions v=0.3.62 role=none count=2 transport=native,websocket",
      "extension-closed v=0.3.62 role=none code=1006 transport=native",
      "extensions v=0.3.62 role=none count=1 transport=websocket",
    ]);
  });

  it("logs restartNeeded the first time it is seen only", () => {
    const { log, lines } = setup();
    log.restartNeeded("0.3.63");
    log.restartNeeded("0.3.63");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/ restart-needed v=0\.3\.62 role=none onDisk=0\.3\.63$/);
  });
});

describe("#143: the Teams state the extension reports", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    extensionVersion: "0.3.62",
    teamsTabs: 1,
    sessions: [{ sessionCaptured: true }],
    services: { chatsvc: "2026-11-11T06:19:00.000Z", csa: "2026-11-11T06:19:00.000Z", mt: null, substrate: null },
    region: "emea",
    signedInAs: "8:orgid:00000000-0000-0000-0000-000000000001",
    ...over,
  });

  it("logs tabs, whether a session is captured and which services are, and only when that changes", () => {
    const { log, lines } = setup();
    log.teamsStatus(status());
    log.teamsStatus(status({ lastTeamsCall: "2026-11-11T06:20:00.000Z" })); // a poll with nothing new
    log.teamsStatus(status({ teamsTabs: 0, sessions: [{ sessionCaptured: false }], services: { chatsvc: null, csa: null, mt: null, substrate: null } }));
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual([
      "teams v=0.3.62 role=none tabs=1 captured=yes services=chatsvc,csa account=first",
      "teams v=0.3.62 role=none tabs=0 captured=no services=none account=same",
    ]);
  });

  it("says only whether the account changed, never who it is", () => {
    const { log, lines } = setup();
    log.teamsStatus(status());
    log.teamsStatus(status({ signedInAs: "8:orgid:00000000-0000-0000-0000-000000000002" }));
    log.teamsStatus(status({ signedInAs: null }));
    expect(lines().map((l) => / account=(\w+)/.exec(l)?.[1])).toEqual(["first", "changed", "none"]);
    expect(lines().join("\n")).not.toMatch(/orgid|00000000|emea/);
  });

  it("logs an unreadable status as such", () => {
    const { log, lines } = setup();
    log.teamsStatus(null);
    log.teamsStatus({ error: "Browser extension is not connected." });
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual(["teams v=0.3.62 role=none status=unreadable"]);
  });
});

describe("#143: tool calls and crashes", () => {
  it("logs a failed call by tool, error name/code, a fixed kind and duration; a fast success not at all", () => {
    const { log, lines } = setup({ slowToolMs: 1000 });
    log.toolCall("list_chats", 12);
    log.toolCall("read_messages", 40.4, new Error("Browser extension disconnected"));
    log.toolCall("send_message", 5, Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:47393"), { code: "ECONNREFUSED" }));
    log.toolCall("list_teams", 1500);
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual([
      "tool v=0.3.62 role=none name=read_messages ok=no ms=40 error=Error kind=lost-call",
      "tool v=0.3.62 role=none name=send_message ok=no ms=5 error=Error code=ECONNREFUSED kind=other",
      "tool v=0.3.62 role=none name=list_teams ok=yes ms=1500 slow=yes",
    ]);
  });

  it("logs an uncaught exception and an unhandled rejection by name and code only", () => {
    const { log, lines } = setup();
    log.crash("uncaught-exception", new TypeError("Cannot read properties of undefined (reading 'Sam Roe')"));
    log.crash("unhandled-rejection", "a thrown string about Contoso");
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual([
      "uncaught-exception v=0.3.62 role=none error=TypeError",
      "unhandled-rejection v=0.3.62 role=none error=string",
    ]);
  });
});

describe("#143: what server.log never holds", () => {
  const BODY = "Contoso merger: confidential, call Sam Roe";
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiIwMDAwIn0.c2lnbmF0dXJl";
  const CHAT = "19:secret-chat@thread.v2";

  it("drops message bodies, tokens and chat ids from errors, statuses and fields, and can't be made to forge a line", () => {
    const { log, lines } = setup({ slowToolMs: 0 });
    log.toolCall("read_messages", 3, new Error(`No chat matches "${BODY}" in ${CHAT} (token ${TOKEN})`));
    log.toolCall("send_message", 3, Object.assign(new Error(BODY), { name: `Bad ${BODY}`, code: TOKEN }));
    log.crash("uncaught-exception", new SyntaxError(`Unexpected token in JSON at position 3: {"text":"${BODY}"}`));
    log.teamsStatus({ teamsTabs: 1, sessions: [{ sessionCaptured: true }], services: { chatsvc: TOKEN }, signedInAs: CHAT, region: BODY, note: BODY });
    log.bridge("extension", { transport: "websocket", browser: `${BODY}\n2026-01-01T00:00:00.000Z pid=1 forged line` });
    log.start({ command: `serve ${CHAT}` });
    const all = lines().join("\n");
    expect(all).not.toMatch(/Contoso|Sam|Roe|secret-chat|thread\.v2|eyJ|c2lnbmF0dXJl|forged line/);
    expect(lines()).toHaveLength(6);
    for (const line of lines()) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z pid=\d+ [\w-]+ v=0\.3\.62 role=none( \w+=[\w.,:-]+)*$/);
  });
});
