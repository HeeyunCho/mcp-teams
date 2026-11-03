// autoSendTo (config): send_message posts without the confirmation window only when the
// extension itself resolved the target to the signed-in user alone and one of their own
// addresses is allowed. The real worker (extension/background.js) under a fake chrome; the
// tool against a scripted bridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";
import { createFakeChrome, loadWorker, ME_OID, never, openedSockets, reply, TEAMS_ORIGIN, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";

const ME = `8:orgid:${ME_OID}`;
const MY_EMAIL = "pat.lee@contoso.example";
const MY_UPN = "pat.lee@corp.contoso.example";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";
const GROUP = "19:contoso-launch@thread.v2";
const WITH_ALEX = `19:${ME_OID}_00000000-0000-4000-8000-00000000000a@unq.gbl.spaces`;
const ONLY_ME = "19:contoso-only-me@thread.v2";

/** The csa list: notes to self, a group with Alex, a 1:1 with Alex, and a chat with only me in it. */
const csa = () => ({
  teams: [],
  chats: [
    { id: "48:notes", title: null, chatType: "chat", members: [{ mri: ME }] },
    { id: GROUP, title: "Contoso launch", chatType: "chat", members: [{ mri: ME }, { mri: ALEX }] },
    { id: WITH_ALEX, title: null, isOneOnOne: true, members: [{ mri: ME }, { mri: ALEX }] },
    { id: ONLY_ME, title: "Scratch", chatType: "chat", members: [{ mri: ME }] },
  ],
});

/** mt short profiles: me (email and a different UPN) and Alex. */
const mt = (req: SentRequest) => {
  if (!/fetchShortProfile/.test(req.path)) return undefined;
  const all = [
    { mri: ME, displayName: "Pat Lee", email: MY_EMAIL, userPrincipalName: MY_UPN.toUpperCase() },
    { mri: ALEX, displayName: "Alex Doe", email: "alex.doe@contoso.example" },
  ];
  return all.filter((p) => (req.body as string[]).includes(p.mri));
};

const chatsvc = (req: SentRequest) => (req.method === "POST" ? { OriginalArrivalTime: Date.parse("2026-10-01T09:00:00Z") } : undefined);

const posts = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST").map((r) => decodeURIComponent(r.path));

async function setup(services: NonNullable<Parameters<typeof createFakeChrome>[0]>["services"] = { csa, mt, chatsvc }) {
  const fake = createFakeChrome({ services });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  return { fake, worker };
}

/** The send opened the confirmation window (and posted nothing); closes it. */
async function expectWindow(fake: FakeChrome, result: Promise<unknown>) {
  await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
  expect(posts(fake)).toEqual([]);
  const win = await fake.spies.windowsCreate.mock.results[0].value;
  fake.closeWindow(win.id);
  await expect(result).resolves.toMatchObject({ sent: false, reason: expect.stringMatching(/closed the confirmation window/) });
  expect(posts(fake)).toEqual([]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

describe("autoSendTo in the extension", () => {
  it("posts to notes to self without a window when my address is allowed", async () => {
    const { fake, worker } = await setup();
    const r = await worker.handlers.requestSend({ conversation: "48:notes", text: "Remember the slides", autoSendTo: [` ${MY_EMAIL.toUpperCase()} `] });
    expect(r).toMatchObject({ sent: true, autoSent: true, note: expect.stringMatching(/without confirmation \(auto-send to self\)/) });
    expect(posts(fake)).toEqual(["/v1/users/ME/conversations/48:notes/messages"]);
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });

  it("to: my own address (by UPN, any case) goes to notes to self without a window", async () => {
    const { fake, worker } = await setup();
    const r = await worker.handlers.requestSend({ to: [MY_UPN], text: "Note", autoSendTo: [MY_EMAIL] });
    expect(r).toMatchObject({ sent: true, autoSent: true });
    expect(posts(fake)).toEqual(["/v1/users/ME/conversations/48:notes/messages"]);
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });

  it("a chat whose only member is me goes without a window", async () => {
    const { fake, worker } = await setup();
    const r = await worker.handlers.requestSend({ conversation: ONLY_ME, text: "Note", autoSendTo: [MY_UPN] });
    expect(r).toMatchObject({ sent: true, autoSent: true });
    expect(posts(fake)).toEqual([`/v1/users/ME/conversations/${ONLY_ME}/messages`]);
  });

  it("another person still gets the window, even when the server allowlists their address", async () => {
    const { fake, worker } = await setup();
    await expectWindow(fake, worker.handlers.requestSend({ to: [ALEX], text: "Hi Alex", autoSendTo: [MY_EMAIL, "alex.doe@contoso.example"] }));
  });

  it("the 1:1 chat with another person still gets the window", async () => {
    const { fake, worker } = await setup();
    await expectWindow(fake, worker.handlers.requestSend({ conversation: WITH_ALEX, text: "Hi Alex", autoSendTo: [MY_EMAIL] }));
  });

  it("a group chat that includes me still gets the window", async () => {
    const { fake, worker } = await setup();
    await expectWindow(fake, worker.handlers.requestSend({ conversation: GROUP, text: "Hi all", autoSendTo: [MY_EMAIL] }));
  });

  it("notes to self gets the window when only someone else's address is allowed", async () => {
    const { fake, worker } = await setup();
    await expectWindow(fake, worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: ["alex.doe@contoso.example"] }));
  });

  it("notes to self gets the window when my profile can't be looked up", async () => {
    const { fake, worker } = await setup({ csa, mt: () => reply(500, { message: "Internal error" }), chatsvc });
    await expectWindow(fake, worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [MY_EMAIL] }));
  });

  it("an empty allowlist keeps the window for notes to self, without looking up my profile", async () => {
    for (const autoSendTo of [undefined, []]) {
      const { fake, worker } = await setup();
      await expectWindow(fake, worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo }));
      // (Chat names are looked up as before; my own profile isn't, nor the list again.)
      expect(fake.sent.filter((r) => r.service === "mt" && JSON.stringify(r.body) === JSON.stringify([ME]))).toEqual([]);
      expect(fake.count("csa")).toBe(1);
    }
  });

  it("an empty allowlist keeps to: my own address an error, as before", async () => {
    const { fake, worker } = await setup({ csa, mt, chatsvc, substrate: () => ({ Groups: [{ Suggestions: [{ DisplayName: "Pat Lee", EmailAddresses: [MY_EMAIL], MRI: ME }] }] }) });
    await expect(worker.handlers.requestSend({ to: [MY_EMAIL], text: "Note" })).rejects.toThrow(/Nobody found/);
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
    expect(posts(fake)).toEqual([]);
  });
});

describe("autoSendTo when a tab fails", () => {
  const SECOND_TAB = { id: 2, url: `${TEAMS_ORIGIN}/v2/?second`, status: "complete" as const };
  const isMyProfile = (r: SentRequest) => r.service === "mt" && JSON.stringify(r.body) === JSON.stringify([ME]);
  const profileLookups = (fake: FakeChrome) => fake.sent.filter(isMyProfile);

  it("the tab closes during my address lookup: it goes once more in another tab, and the note posts without a window", async () => {
    let held = false;
    const { fake, worker } = await setup({
      csa,
      chatsvc,
      mt: (req: SentRequest) => {
        if (held || !isMyProfile(req)) return mt(req);
        held = true;
        return never();
      },
    });
    fake.tabs.push({ ...SECOND_TAB });
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [MY_EMAIL] });
    await vi.waitFor(() => expect(profileLookups(fake)).toHaveLength(1));

    fake.closeTab(1);
    await vi.waitFor(() => expect(posts(fake).length + fake.spies.windowsCreate.mock.calls.length).toBeGreaterThan(0));

    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
    await expect(result).resolves.toMatchObject({ sent: true, autoSent: true });
    expect(profileLookups(fake).slice(0, 2).map((r) => r.tabId)).toEqual([1, 2]);
    expect(posts(fake)).toEqual(["/v1/users/ME/conversations/48:notes/messages"]);
  });

  it("the tab closes during the fresh chat list of a chat with only me: it goes once more in another tab, and the note posts", async () => {
    // The second read is the fresh one: the first found the chat.
    let reads = 0;
    const { fake, worker } = await setup({ mt, chatsvc, csa: () => (++reads === 2 ? never() : csa()) });
    fake.tabs.push({ ...SECOND_TAB });
    const result = worker.handlers.requestSend({ conversation: ONLY_ME, text: "Note", autoSendTo: [MY_EMAIL] });
    await vi.waitFor(() => expect(reads).toBe(2));

    fake.closeTab(1);
    await vi.waitFor(() => expect(posts(fake).length + fake.spies.windowsCreate.mock.calls.length).toBeGreaterThan(0));

    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
    await expect(result).resolves.toMatchObject({ sent: true, autoSent: true });
  });

  it("the tab closes under the post itself: it is never sent again, and the answer says it may have been posted", async () => {
    const hanging = { csa, mt, chatsvc: (req: SentRequest) => (req.method === "POST" ? never() : undefined) };
    const { fake, worker } = await setup(hanging);
    fake.tabs.push({ ...SECOND_TAB });
    const result = worker.handlers.requestSend({ conversation: "48:notes", text: "Note", autoSendTo: [MY_EMAIL] });
    await vi.waitFor(() => expect(posts(fake)).toHaveLength(1));

    fake.closeTab(1);

    await expect(result).resolves.toEqual({ sent: false, autoSent: true, reason: expect.stringMatching(/may have been posted.*read_messages/) });
    expect(posts(fake)).toHaveLength(1);
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });
});

describe("autoSendTo in send_message", () => {
  /** send_message's call to the bridge and its answer, with this config. */
  async function sendWith(autoSendTo: string[] | undefined, answer: unknown) {
    const calls: { method: string; params: any }[] = [];
    const bridge = { call: (method: string, params: unknown) => (calls.push({ method, params: params as any }), Promise.resolve(answer)) } as unknown as Parameters<typeof registerTools>[1];
    const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
    registerTools(server, bridge, { port: 0, token: TOKEN, ...(autoSendTo ? { autoSendTo } : {}) });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const description = (await client.listTools()).tools.find((t) => t.name === "send_message")!.description!;
    const r = (await client.callTool({ name: "send_message", arguments: { conversation: "48:notes", text: "Note" } })) as { content: { text: string }[] };
    await client.close();
    return { params: calls[0].params, text: r.content[0].text, description };
  }

  it("passes the allowlist with the request and reports an auto-send", async () => {
    const answer = { sent: true, autoSent: true, note: "Sent without confirmation (auto-send to self)." };
    const r = await sendWith([MY_EMAIL], answer);
    expect(r.params).toMatchObject({ conversation: "48:notes", text: "Note", autoSendTo: [MY_EMAIL] });
    expect(JSON.parse(r.text)).toEqual(answer);
    expect(r.description).toMatch(/autoSendTo/);
  });

  it("without it, the request and the description stay as they were", async () => {
    for (const autoSendTo of [undefined, []]) {
      const r = await sendWith(autoSendTo, { sent: false, reason: "The user declined; nothing was sent." });
      expect(r.params).not.toHaveProperty("autoSendTo");
      expect(r.description).not.toMatch(/autoSendTo/);
    }
  });

  it("the description says a sent result can have time: null with a timeNote, so the AI doesn't send again", async () => {
    for (const autoSendTo of [undefined, [MY_EMAIL]]) {
      const r = await sendWith(autoSendTo, { sent: false, reason: "The user declined; nothing was sent." });
      expect(r.description).toMatch(/time: null with a timeNote/);
      expect(r.description).toMatch(/don't send it again/);
    }
  });
});
