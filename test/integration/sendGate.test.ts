// An extension older than 0.2.13 ignores {type:"cancel"}: its confirmation window stays open
// after the AI stops waiting, so a late click would still post. send_message refuses to open
// a window on such an extension (#22, gap 1), before anything reaches it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionBridge } from "../../src/bridge.js";
import { registerTools } from "../../src/tools.js";
import { bridgeHarness, TOKEN, until, type BridgeHarness, type FakeExtension } from "../helpers/bridgeHarness.js";

const SEND = { conversation: "19:contoso-launch@thread.v2", text: "Hi Alex" };

let h: BridgeHarness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** send_message through `bridge`'s tools: whether it failed, and its text. */
async function sendMessage(bridge: ExtensionBridge) {
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: h!.port, token: TOKEN });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = (await client.callTool({ name: "send_message", arguments: SEND })) as { isError?: boolean; content: { text: string }[] };
  await client.close();
  return { isError: !!r.isError, text: r.content[0].text };
}

/** A hub, and an extension of `version` that would post on a click (it ignores cancel, like one before 0.2.13). */
async function setup(version: string) {
  h = await bridgeHarness();
  const hub = await h.session();
  const ext = await h.extension({ version, handle: (req) => (req.method === "requestSend" ? { sent: true } : { ok: true }) });
  await until(() => hub.connected, 3_000, "the hub sees the extension");
  return { hub, ext };
}

const sends = (ext: FakeExtension) => ext.requests().filter((r) => r.method === "requestSend").length;

/** Refused as not sent: says to update the extension, and never that it may have been posted. */
function expectRefused(r: { isError: boolean; text: string }, ext: FakeExtension) {
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/nothing was sent/i);
  expect(r.text).toMatch(/reload_extension/);
  expect(r.text).not.toMatch(/may have been posted/);
  expect(sends(ext)).toBe(0);
}

describe("send_message and an extension that can't close its window", () => {
  it("22: an extension older than 0.2.13 gets no send: refused as not sent, no window opens", async () => {
    const { hub, ext } = await setup("0.2.12");
    expectRefused(await sendMessage(hub), ext);
  });

  it("22: a peer session's send is refused too, before it reaches the extension", async () => {
    const { ext } = await setup("0.2.12");
    const peer = await h!.session();
    await until(() => peer.connected, 3_000, "the peer sees the extension");
    expectRefused(await sendMessage(peer), ext);
  });

  it("22: an extension whose version can't be read counts as too old", async () => {
    const { hub, ext } = await setup("dev");
    expectRefused(await sendMessage(hub), ext);
  });

  it("22: an extension of 0.2.13 or newer still gets the send", async () => {
    const { hub, ext } = await setup("0.2.13");
    expect(await sendMessage(hub)).toEqual({ isError: false, text: JSON.stringify({ sent: true }, null, 2) });
    expect(sends(ext)).toBe(1);
  });
});
