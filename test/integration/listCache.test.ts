// 3.2: list_chats, list_teams and list_meetings reuse the worker's one-minute chat list cache
// (one csa read for all three) unless the AI asks for `refresh: true`. A list missing names
// isn't kept for the minute, and a chat send_message creates empties the cache. The tools run
// over MCP (src/tools.ts); their bridge calls go straight to the real worker
// (extension/background.js) under a fake chrome.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";
import { BASES, createFakeChrome, loadWorker, ME_OID, openedSockets, reply, type FakeChrome, type SentRequest, type Worker } from "../helpers/fakeChrome.js";

const ME = `8:orgid:${ME_OID}`;
const ALEX = "8:orgid:00000000-0000-4000-8000-0000000000c2";
const SAM = "8:orgid:00000000-0000-4000-8000-0000000000c3";
const NEW_CHAT = "19:contoso-new@thread.v2";

/** csa's view: a team with a channel, a titled chat, an untitled one with Alex, and a meeting. */
const csa = (extra: object[] = []) => ({
  teams: [{ id: "19:contoso-team@thread.tacv2", displayName: "Contoso", channels: [{ id: "19:contoso-general@thread.tacv2", displayName: "General" }] }],
  chats: [
    { id: "19:contoso-launch@thread.v2", title: "Contoso launch", chatType: "chat", members: [{ mri: ME }, { mri: SAM }], lastMessage: { composetime: "2026-10-02T09:00:00Z" } },
    { id: "19:contoso-alex@thread.v2", chatType: "chat", members: [{ mri: ME }, { mri: ALEX }], lastMessage: { composetime: "2026-10-01T09:00:00Z" } },
    {
      id: "19:meeting_contoso-review@thread.v2",
      chatType: "meeting",
      title: "Contoso review",
      meetingInformation: { subject: "Contoso review", startTime: "2026-09-30T09:00:00Z", organizerId: SAM.slice("8:orgid:".length) },
      members: [],
    },
    ...extra,
  ],
});
/** mt's short profiles for whoever is asked. */
const profiles = (req: SentRequest) =>
  (req.body as string[]).map((mri) => ({ mri, displayName: mri === ALEX ? "Alex Doe" : mri === SAM ? "Sam Roe" : "Contoso User" }));

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** The MCP tools, with a bridge whose calls go to `worker` as requests from the hub. */
async function toolsFor(worker: Worker) {
  let n = 0;
  const bridge = {
    call: (method: string, params: object, timeoutMs?: number) =>
      new Promise((resolve, reject) => {
        void worker.dispatch({ type: "request", id: `t${++n}`, method, params, timeoutMs: timeoutMs ?? 30_000 }, (r: any) =>
          r.ok ? resolve(r.result) : reject(new Error(r.error)),
        );
      }),
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    return JSON.parse(r.content[0].text);
  };
  return { tool, close: () => client.close() };
}

type Services = NonNullable<NonNullable<Parameters<typeof createFakeChrome>[0]>["services"]>;

async function setup(services: Services = { csa: () => csa(), mt: profiles }) {
  const fake = createFakeChrome({ services });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  const tools = await toolsFor(worker);
  return { fake, worker, ...tools };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("3.2: the list tools reuse the one-minute chat list", () => {
  it("3.2: two list_chats calls within 60 s make 1 csa request", async () => {
    const s = await setup();
    close = s.close;
    const first = await s.tool("list_chats");
    const namesLookedUp = s.fake.count("mt"); // chat members and meeting organizers, looked up apart
    const second = await s.tool("list_chats");
    expect(second).toEqual(first);
    expect(first.chats.map((c: { title: string }) => c.title)).toContain("Alex Doe");
    expect(s.fake.count("csa")).toBe(1);
    expect(s.fake.count("mt")).toBe(namesLookedUp);
  });

  it("3.2: list_chats, list_teams and list_meetings within 60 s share one csa request", async () => {
    const s = await setup();
    close = s.close;
    await s.tool("list_chats");
    expect((await s.tool("list_teams")).teams.map((t: { name: string }) => t.name)).toEqual(["Contoso"]);
    expect((await s.tool("list_meetings")).meetings.map((m: { title: string }) => m.title)).toEqual(["Contoso review"]);
    expect(s.fake.count("csa")).toBe(1);
  });

  it("3.2: refresh: true reads the list again, on each of the three tools", async () => {
    const s = await setup();
    close = s.close;
    await s.tool("list_chats");
    await s.tool("list_chats", { refresh: true });
    expect(s.fake.count("csa")).toBe(2);
    await s.tool("list_teams", { refresh: true });
    expect(s.fake.count("csa")).toBe(3);
    await s.tool("list_meetings", { refresh: true });
    expect(s.fake.count("csa")).toBe(4);
    // And the refreshed list is what the next call without refresh gets.
    await s.tool("list_chats");
    expect(s.fake.count("csa")).toBe(4);
  });

  it("3.2: a list whose names couldn't be looked up isn't served from the cache: the next call reads again and gets the names", async () => {
    let failing = true;
    const s = await setup({ csa: () => csa(), mt: (req: SentRequest) => (failing ? reply(500, { message: "Internal error" }) : profiles(req)) });
    close = s.close;
    const first = await s.tool("list_chats");
    expect(first.note).toMatch(/Chat names missing: .*Teams HTTP 500 \(mt\)/);
    failing = false;
    const second = await s.tool("list_chats");
    expect(second.note).toBeUndefined();
    expect(second.chats.map((c: { title: string }) => c.title)).toContain("Alex Doe");
    expect(s.fake.count("csa")).toBe(2);
  });
});

describe("3.2: a chat send_message creates empties the cache", () => {
  const click = (fake: FakeChrome, id: string) => fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });

  it("3.2: after a new group chat is created, list_chats reads the list again and shows it", async () => {
    let created = false;
    const s = await setup({
      csa: () => csa(created ? [{ id: NEW_CHAT, title: "Contoso offsite", chatType: "chat", members: [{ mri: ME }, { mri: ALEX }, { mri: SAM }], lastMessage: { composetime: "2026-10-03T09:00:00Z" } }] : []),
      mt: profiles,
      chatsvc: (req: SentRequest) => {
        if (req.method !== "POST") return undefined;
        if (req.path === "/v1/threads") {
          created = true;
          return reply(201, {}, { location: `${BASES.chatsvc}/v1/threads/${encodeURIComponent(NEW_CHAT)}` });
        }
        return { OriginalArrivalTime: Date.parse("2026-10-03T09:00:00Z") };
      },
    });
    close = s.close;
    await s.tool("list_chats");
    const result = s.worker.handlers.requestSend({ to: [ALEX, SAM], title: "Contoso offsite", text: "Hi both" });
    await vi.waitFor(() => expect(s.fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
    const id = /id=([^&]+)/.exec(s.fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
    await click(s.fake, id);
    await expect(result).resolves.toMatchObject({ sent: true });
    const before = s.fake.count("csa");

    const listed = await s.tool("list_chats");
    expect(listed.chats[0]).toMatchObject({ id: NEW_CHAT, title: "Contoso offsite" });
    expect(s.fake.count("csa")).toBe(before + 1);
  });

  it("3.2: after a message is posted to an existing chat, list_chats reads the list again and shows it as the last message", async () => {
    // So an AI checking list_chats after send_message never sees the old last message and sends again.
    let posted = false;
    const s = await setup({
      csa: () => {
        const view = csa();
        if (posted) view.chats[0] = { ...view.chats[0], lastMessage: { composetime: "2026-10-03T10:00:00Z" } } as (typeof view.chats)[0];
        return view;
      },
      mt: profiles,
      chatsvc: (req: SentRequest) => {
        if (req.method !== "POST") return undefined;
        posted = true;
        return { OriginalArrivalTime: Date.parse("2026-10-03T10:00:00Z") };
      },
    });
    close = s.close;
    const first = await s.tool("list_chats");
    expect(first.chats[0].lastMessage.time).toBe("2026-10-02T09:00:00.000Z");
    const result = s.worker.handlers.requestSend({ conversation: "19:contoso-launch@thread.v2", text: "Hi Sam" });
    await vi.waitFor(() => expect(s.fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
    const id = /id=([^&]+)/.exec(s.fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
    await click(s.fake, id);
    await expect(result).resolves.toMatchObject({ sent: true });
    const before = s.fake.count("csa");

    const listed = await s.tool("list_chats");
    expect(s.fake.count("csa")).toBe(before + 1);
    expect(listed.chats[0]).toMatchObject({ id: "19:contoso-launch@thread.v2", lastMessage: { time: "2026-10-03T10:00:00.000Z" } });
  });
});
