import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

// Runs the built server (dist/) over stdio, with a fake extension on the bridge.
const VERSION: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const PORT = 47598;
const home = mkdtempSync(join(tmpdir(), "mcp-teams-"));
const calls: { method: string; params: any }[] = [];
let client: Client;
let ext: WebSocket;

const fakeExtension: Record<string, (p: any) => unknown> = {
  status: () => ({ extensionVersion: VERSION, teamsTabs: 1, services: { chatsvc: "2026-10-10T08:00:00Z" } }),
  listTeams: () => ({
    teams: [{ id: "T1", name: "Engineering", channels: [{ id: "19:g@thread.tacv2", name: "General", general: true }] }],
  }),
  listChats: (p) => ({ total: 1, chats: [{ id: "19:a@unq.gbl.spaces", title: "Bo Kim", kind: "oneOnOne", query: p.query ?? null }] }),
  readMessages: (p) => {
    if (p.conversation === "nobody") throw new Error('No chat or channel matches "nobody".');
    return {
      conversation: { id: "19:g@thread.tacv2", kind: "channel", title: "Engineering/General" },
      count: 1,
      messages: [{ id: "1", text: "x".repeat(500), replies: [{ id: "2", text: "y".repeat(500) }] }],
    };
  },
  searchMessages: (p) => ({ query: p.query, total: 1, results: [{ conversationId: "19:a@unq.gbl.spaces", text: "budget" }] }),
  findPeople: () => ({ count: 1, people: [{ name: "Bo Kim", email: "bo@x.com" }] }),
  requestSend: () => ({ sent: false, reason: "The user declined; nothing was sent." }),
};

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

beforeAll(async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: "tok", port: PORT }));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, TEAMS_MCP_HOME: home } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  ext = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "chrome-extension://fake" });
  await new Promise<void>((resolve) => {
    ext.on("open", () => ext.send(JSON.stringify({ type: "hello", token: "tok", version: VERSION, browser: "Chrome" })));
    ext.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") resolve();
      if (msg.type !== "request") return;
      calls.push({ method: msg.method, params: msg.params });
      try {
        ext.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: fakeExtension[msg.method](msg.params) }));
      } catch (err) {
        ext.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: (err as Error).message }));
      }
    });
  });
}, 20_000);

afterAll(async () => {
  ext?.close();
  await client?.close();
});

describe("MCP server end to end", () => {
  it("exposes the expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_people",
      "get_version",
      "list_chats",
      "list_teams",
      "read_messages",
      "reload_extension",
      "search_messages",
      "send_message",
    ]);
  });

  it("reports versions and the Teams session", async () => {
    const { data } = await call("get_version");
    expect(data).toMatchObject({ server: VERSION, extension: VERSION, versionsMatch: true, role: "hub", teams: { teamsTabs: 1 } });
  });

  it("lists teams without ids unless asked", async () => {
    expect((await call("list_teams")).data).toEqual({ teams: [{ name: "Engineering", channels: [{ name: "General", general: true }] }] });
    expect((await call("list_teams", { include_ids: true })).data.teams[0].channels[0].id).toBe("19:g@thread.tacv2");
  });

  it("passes chat filters through", async () => {
    await call("list_chats", { query: "bo", unread_only: true });
    expect(calls.at(-1)).toEqual({ method: "listChats", params: { query: "bo", unreadOnly: true, limit: 30 } });
  });

  it("reads messages and cuts long texts, replies too", async () => {
    const { data } = await call("read_messages", { conversation: "Engineering/General", max_length: 100, reply_to: "1" });
    expect(calls.at(-1)?.params).toEqual({ conversation: "Engineering/General", limit: 30, threadId: "1", includeSystem: false });
    expect(data.messages[0]).toMatchObject({ text: `${"x".repeat(100)}…`, truncated: true });
    expect(data.messages[0].replies[0]).toMatchObject({ text: `${"y".repeat(100)}…`, truncated: true });
  });

  it("returns extension errors as tool errors", async () => {
    expect(await call("read_messages", { conversation: "nobody" })).toEqual({ isError: true, data: 'No chat or channel matches "nobody".' });
  });

  it("searches messages and finds people", async () => {
    expect((await call("search_messages", { query: "budget" })).data.total).toBe(1);
    expect((await call("find_people", { query: "bo" })).data.people[0].email).toBe("bo@x.com");
  });

  it("starts a chat with people, and needs exactly one of conversation or to", async () => {
    await call("send_message", { to: ["Bo Kim", "ana@x.com"], title: "Plan", text: "Hi" });
    expect(calls.at(-1)).toEqual({ method: "requestSend", params: { to: ["Bo Kim", "ana@x.com"], title: "Plan", text: "Hi" } });
    const before = calls.length;
    expect((await call("send_message", { text: "Hi" })).isError).toBe(true);
    expect((await call("send_message", { conversation: "Bo Kim", to: ["Bo Kim"], text: "Hi" })).isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("only requests a send; the extension asks the user", async () => {
    const { data } = await call("send_message", { conversation: "Bo Kim", text: "Hi" });
    expect(calls.at(-1)).toEqual({ method: "requestSend", params: { conversation: "Bo Kim", text: "Hi" } });
    expect(data).toEqual({ sent: false, reason: "The user declined; nothing was sent." });
  });
});
