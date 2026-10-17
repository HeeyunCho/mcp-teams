// read_messages end to end inside one process: the real tool (src/tools.ts) over the real
// bridge to the real service worker (extension/background.js) against a fake chatsvc.
// Long texts are cut to max_length; the cut should happen before the bridge, not after it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { bridgeHarness, TOKEN, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { createFakeChrome, loadWorker, openedSockets, type SentRequest } from "../helpers/fakeChrome.js";

const CHANNEL = "19:contoso-general@thread.tacv2";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";
const SAM = "8:orgid:00000000-0000-4000-8000-00000000000b";
const START = Date.parse("2026-03-02T09:00:00.000Z");
const MAX = 100;

// Texts chosen so a cut at 100 UTF-16 units lands in awkward places.
const TEXTS = {
  // 99 ASCII then an emoji across the cut: the emoji is left out whole, never split.
  emojiAtCut: `${"a".repeat(99)}😀 and the rest of a long status update ${"b".repeat(400)}`,
  korean: `회의록 정리했습니다. ${"다음 주 배포 일정과 테스트 결과를 공유드립니다. ".repeat(30)}`,
  mixed: `Build log 🚀✅ ${"단계 ok · ".repeat(20)}${"x".repeat(20_000)}`,
  exactly: "e".repeat(MAX),
  short: "Thanks, Alex 👍",
  longReply: `${"Sam Roe here, with a pasted stack trace: at frame() ".repeat(80)}끝`,
  emojiReply: `${"🎉".repeat(120)}`,
};

const raw = (n: number, text: string, from: string, name: string, root?: number) => ({
  id: String(START + n * 60_000),
  messagetype: "Text",
  content: text,
  imdisplayname: name,
  from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${from}`,
  originalarrivaltime: new Date(START + n * 60_000).toISOString(),
  conversationLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${CHANNEL}${root ? `;messageid=${START + root * 60_000}` : ""}`,
});

// Newest first, as chatsvc returns them.
const MESSAGES = [
  raw(8, TEXTS.emojiReply, SAM, "Sam Roe", 5),
  raw(7, TEXTS.short, SAM, "Sam Roe", 1),
  raw(6, TEXTS.longReply, SAM, "Sam Roe", 1),
  raw(5, TEXTS.exactly, ALEX, "Alex Doe"),
  raw(4, TEXTS.mixed, ALEX, "Alex Doe"),
  raw(3, TEXTS.korean, SAM, "Sam Roe"),
  raw(2, TEXTS.short, ALEX, "Alex Doe"),
  raw(1, TEXTS.emojiAtCut, ALEX, "Alex Doe"),
];

const csa = () => ({
  teams: [{ id: "19:contoso-team@thread.tacv2", displayName: "Contoso", channels: [{ id: CHANNEL, displayName: "General" }] }],
  chats: [],
});
const chatsvc = (req: SentRequest) => (/\/messages\?/.test(req.path) ? { messages: MESSAGES, _metadata: {} } : undefined);

let h: BridgeHarness;
afterEach(async () => {
  await h?.cleanup();
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/**
 * The read_messages tool's text output, and the UTF-8 bytes of the readMessages result
 * the extension sent over the bridge. `old`: an extension that doesn't know maxLength.
 */
async function readThroughBridge({ old = false } = {}) {
  h = await bridgeHarness();
  const bridge = await h.session();
  const worker = await loadWorker(createFakeChrome({ services: { csa, chatsvc } }));
  let bytes = 0;
  await h.extension({
    handle: async ({ method, params }) => {
      if (method !== "readMessages") return worker.handlers[method]?.(params) ?? {};
      const { maxLength: _, ...oldParams } = params;
      const result = await worker.handlers.readMessages(old ? oldParams : params);
      bytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    },
  });
  const server = new McpServer({ name: "mcp-teams", version: "0" });
  registerTools(server, bridge, { port: h.port, token: TOKEN });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r: any = await client.callTool({ name: "read_messages", arguments: { conversation: CHANNEL, max_length: MAX } });
  await client.close();
  return { output: r.content[0].text as string, bytes };
}

describe("read_messages cuts long texts", () => {
  it("1.4: the tool output for a conversation with long, multi-byte texts and replies matches the golden", async () => {
    const { output } = await readThroughBridge();
    await expect(output).toMatchFileSnapshot("__snapshots__/read-messages-cut.golden.json");
  });

  it("1.4: the extension sends only cut texts over the bridge, not the full bodies", async () => {
    const { bytes } = await readThroughBridge();
    const full = Object.values(TEXTS).reduce((n, t) => n + Buffer.byteLength(t), 0);
    // Per message: the cut text (≤ MAX UTF-16 units, ≤ 3 bytes each) and ~400 bytes of id,
    // time, sender and conversation; 8 messages.
    expect(bytes).toBeLessThanOrEqual(MESSAGES.length * (MAX * 3 + 400));
    expect(bytes).toBeLessThan(full);
  });

  it("1.4: a server talking to an older extension that ignores maxLength gives the same output", async () => {
    const { output: current } = await readThroughBridge();
    await h.cleanup();
    const { output: old, bytes } = await readThroughBridge({ old: true });
    expect(old).toBe(current);
    await expect(old).toMatchFileSnapshot("__snapshots__/read-messages-cut.golden.json");
    expect(bytes).toBeGreaterThan(Buffer.byteLength(TEXTS.mixed)); // the old extension really sent full bodies
  });
});
