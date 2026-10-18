// send_message warns "the message may have been posted" exactly when the bridge lost a call it had
// already sent. The bridge owns those messages (LOST_CALL in src/bridge.ts) and the tools ask it
// (isLostCall), so rewording one in the bridge can't silently drop the warning.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";

const SEND = { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" };

/** send_message's answer when the bridge call fails with `message`. */
async function sendFailingWith(message: string) {
  const failing = { call: () => Promise.reject(new Error(message)) } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, failing, { port: 0, token: TOKEN });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = (await client.callTool({ name: "send_message", arguments: SEND })) as { content: { text: string }[] };
  await client.close();
  return r.content[0].text;
}

/** Every lost-call message the bridge can make, with sample values for the ones that take some. */
async function lostCallMessages(): Promise<string[]> {
  // Imported at run time: the bridge exports these from 2.1 on.
  const { LOST_CALL } = (await import("../../src/bridge.js")) as unknown as { LOST_CALL?: Record<string, string | ((...a: any[]) => string)> };
  expect(LOST_CALL, "src/bridge.ts exports LOST_CALL").toBeTypeOf("object");
  return Object.values(LOST_CALL!).map((m) => (typeof m === "string" ? m : m("sample", 256)));
}

describe("lost calls", () => {
  it("2.1: every message the bridge uses for a lost sent call makes send_message warn", async () => {
    const messages = await lostCallMessages();
    expect(messages.length).toBeGreaterThanOrEqual(10);
    for (const m of messages) expect(await sendFailingWith(m), m).toMatch(/may have been posted.*read_messages before sending again/);
  });

  it("2.1: the bridge fails sent calls only with its LOST_CALL messages, never a literal of its own", () => {
    const src = readFileSync("src/bridge.ts", "utf8");
    // A literal here would be a lost-call message the tools can't know about.
    expect(src).not.toMatch(/\b(rejectAll|restartHub)\(\s*["'`]/);
    expect(src).not.toMatch(/withdraw\([^)]*new Error\(\s*["'`]/);
    expect(src).toMatch(/const cancelledError = \(\) => new Error\(LOST_CALL\./);
    // Socket errors too (they fail every pending call on that connection).
    const socketErrors = src.slice(src.indexOf("function describeSocketError"), src.indexOf("export class ExtensionBridge"));
    // (It may compare an error code with a string, but builds no message of its own.)
    expect(socketErrors).not.toMatch(/`/);
    expect(socketErrors).toMatch(/LOST_CALL\.tooLarge\(/);
    expect(socketErrors).toMatch(/LOST_CALL\.socketError\(/);
  });

  it("2.1: the tools ask the bridge which errors are lost calls (no copy of their own)", () => {
    const tools = readFileSync("src/tools.ts", "utf8");
    expect(tools).toMatch(/\bisLostCall\b/);
    expect(tools).not.toMatch(/OUTCOME_UNKNOWN\s*=/);
  });
});
