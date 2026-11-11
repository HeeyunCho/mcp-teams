// #143: every server's diagnostic log, ~/.mcp-teams/server.log: one line per event, metadata only
// (never message text, names, tokens or chat ids), logged on change, never throwing.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticLog, watchState } from "../../src/serverLog.js";
import { until } from "../helpers/timing.js";

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
    log.teamsStatus(status({ droppedOldCaptures: { count: 0, lastAt: null } })); // a poll with nothing new
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

describe("#143 review: connects, handshakes and drops", () => {
  const events = (lines: () => string[]) => lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""));

  it("logs every extension connect with its version, also one that changes no count", () => {
    const { log, lines } = setup();
    log.bridge("extension-connected", { ext: "0.3.61", transport: "websocket" });
    log.bridge("extension-connected", { ext: "0.3.61", transport: "websocket" });
    log.bridge("extension-connected", { ext: "0.3.62 Contoso", transport: "websocket" });
    expect(events(lines)).toEqual([
      "extension-connected v=0.3.62 role=none ext=0.3.61 transport=websocket",
      "extension-connected v=0.3.62 role=none ext=0.3.61 transport=websocket",
      "extension-connected v=0.3.62 role=none ext=unknown transport=websocket",
    ]);
  });

  it("logs a refused handshake, and the same refusal again only after something connected", () => {
    const { log, lines } = setup();
    log.bridge("handshake-closed", { code: 4401, via: "tcp" });
    log.bridge("handshake-closed", { code: 4401, via: "tcp" }); // the extension retrying every 30 s
    log.bridge("handshake-closed", { code: 4426, via: "tcp" });
    log.bridge("extension-connected", { ext: "0.3.62", transport: "websocket" });
    log.bridge("handshake-closed", { code: 4426, via: "tcp" });
    log.bridge("extension-dropped", { reason: "no-pong", transport: "websocket" });
    expect(events(lines)).toEqual([
      "handshake-closed v=0.3.62 role=none code=4401 via=tcp",
      "handshake-closed v=0.3.62 role=none code=4426 via=tcp",
      "extension-connected v=0.3.62 role=none ext=0.3.62 transport=websocket",
      "handshake-closed v=0.3.62 role=none code=4426 via=tcp",
      "extension-dropped v=0.3.62 role=none reason=no-pong transport=websocket",
    ]);
  });

  it("writes only event names of lowercase words and dashes", () => {
    const { log, lines } = setup();
    log.bridge("Sam Roe\nforged", {});
    log.bridge("hub-closed", { code: 1006 });
    expect(events(lines)).toEqual(["other v=0.3.62 role=none", "hub-closed v=0.3.62 role=none code=1006"]);
  });
});

describe("#143 review: what a status says, and what never throws", () => {
  const events = (lines: () => string[]) => lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""));
  const at = (iso: string) => ({ at: iso, host: "teams.cloud.microsoft" });

  it("says whether the session looks stale: no signed-in call for 5 minutes while the tab keeps calling", () => {
    const { log, lines } = setup();
    const base = { teamsTabs: 1, sessions: [{ sessionCaptured: true }], services: { chatsvc: "2026-11-11T00:00:00Z" }, signedInAs: "8:orgid:x" };
    log.teamsStatus({ ...base, lastTeamsCall: at("2026-11-11T00:03:00Z"), lastSignedInCall: at("2026-11-11T00:02:59Z") });
    log.teamsStatus({ ...base, lastTeamsCall: at("2026-11-11T00:04:00Z"), lastSignedInCall: at("2026-11-11T00:03:58Z") }); // fresh again: no line
    log.teamsStatus({ ...base, lastTeamsCall: at("2026-11-11T01:04:00Z"), lastSignedInCall: at("2026-11-11T00:58:00Z") });
    log.teamsStatus({ ...base, lastTeamsCall: at("2026-11-11T01:05:00Z"), lastSignedInCall: null });
    log.teamsStatus(base); // an extension from before #103 says neither
    expect(events(lines)).toEqual([
      "teams v=0.3.62 role=none tabs=1 captured=yes services=chatsvc stale=no account=first",
      "teams v=0.3.62 role=none tabs=1 captured=yes services=chatsvc stale=yes account=same",
      "teams v=0.3.62 role=none tabs=1 captured=yes services=chatsvc account=same",
    ]);
  });

  it("logs a status read that was cancelled as aborted, not as unreadable", () => {
    const { log, lines } = setup();
    log.teamsStatus(null, "aborted");
    log.teamsStatus(null);
    expect(events(lines)).toEqual(["teams v=0.3.62 role=none status=aborted", "teams v=0.3.62 role=none status=unreadable"]);
  });

  it("does not count send_message's wait for the user's click as slow", () => {
    const { log, lines } = setup({ slowToolMs: 1000 });
    log.toolCall("send_message", 90_000);
    log.toolCall("read_messages", 90_000);
    expect(events(lines)).toEqual(["tool v=0.3.62 role=none name=read_messages ok=yes ms=90000 slow=yes"]);
  });

  it("never throws, even for an error whose name or message can't be read", () => {
    const { log, lines } = setup({ slowToolMs: 0 });
    const hostile = new Proxy(new Error("x"), {
      get() {
        throw new Error("no reading this");
      },
      getPrototypeOf() {
        throw new Error("no reading this");
      },
    });
    expect(() => log.crash("uncaught-exception", hostile)).not.toThrow();
    expect(() => log.toolCall("list_chats", 1, hostile)).not.toThrow();
    expect(lines()).toHaveLength(2);
  });
});

describe("#143 review: the background watch (hub only)", () => {
  const status = { teamsTabs: 1, sessions: [{ sessionCaptured: true }], services: { chatsvc: "2026-11-11T00:00:00Z" } };
  const fakeBridge = (role: string, read: () => Promise<unknown> = async () => status) => {
    const b = { role, connected: true, reads: 0, backgroundStatus: async (_ms: number) => (b.reads++, read()) };
    return b;
  };
  const stops: (() => void)[] = [];
  afterEach(() => stops.splice(0).forEach((s) => s()));

  it("reads the Teams state every period as the hub, so it is logged without any tool call", async () => {
    const { log, lines, file } = setup();
    const bridge = fakeBridge("hub");
    stops.push(watchState({ bridge, diagnostics: log, onDisk: () => ({ restartNeeded: false }), everyMs: 20 }));
    await until(() => bridge.reads >= 3, 3_000, "three reads");
    expect(existsSync(file) ? lines() : []).toHaveLength(1);
    expect(lines()[0]).toMatch(/ teams v=0\.3\.62 role=none tabs=1 captured=yes services=chatsvc account=none$/);
  });

  it("does not read as a peer or without an extension, and logs a failed read as unreadable", async () => {
    const { log, lines, file } = setup();
    const peer = fakeBridge("peer");
    const idle = Object.assign(fakeBridge("hub"), { connected: false });
    const failing = fakeBridge("hub", async () => {
      throw new Error("Extension call 'status' timed out");
    });
    stops.push(watchState({ bridge: peer, diagnostics: log, onDisk: () => ({ restartNeeded: false }), everyMs: 20 }));
    stops.push(watchState({ bridge: idle, diagnostics: log, onDisk: () => ({ restartNeeded: false }), everyMs: 20 }));
    stops.push(watchState({ bridge: failing, diagnostics: log, onDisk: () => ({ restartNeeded: false }), everyMs: 20 }));
    await until(() => failing.reads >= 2, 3_000, "the failing reads");
    expect(peer.reads + idle.reads).toBe(0);
    expect(existsSync(file) ? lines().map((l) => l.replace(/^\S+ pid=\d+ /, "")) : []).toEqual(["teams v=0.3.62 role=none status=unreadable"]);
  });

  it("logs restartNeeded from the watch too, on any role, without a call", async () => {
    const { log, lines, file } = setup();
    const peer = fakeBridge("peer");
    stops.push(watchState({ bridge: peer, diagnostics: log, onDisk: () => ({ restartNeeded: true, onDisk: { version: "0.3.63", build: "abc" } }), everyMs: 20 }));
    await until(() => existsSync(file) && lines().length > 0, 3_000, "the restart-needed line");
    await new Promise((r) => setTimeout(r, 80));
    expect(lines().map((l) => l.replace(/^\S+ pid=\d+ /, ""))).toEqual(["restart-needed v=0.3.62 role=none onDisk=0.3.63"]);
  });
});
