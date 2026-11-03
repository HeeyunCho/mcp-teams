// #77 item 4: Teams accepts a post (2xx) but answers with something that isn't JSON (an HTML
// page, say). The message was posted, so the send is reported as sent, with its time marked as
// unconfirmed, and nothing in the result invites sending it again. Reads answered that way
// still fail. The real worker (extension/background.js) under a fake chrome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeHarness, TOKEN, type BridgeHarness } from "../helpers/bridgeHarness.js";
import { BASES, connectWorker, createFakeChrome, loadWorker, ME_OID, openedSockets, reply, type FakeChrome, type SentRequest } from "../helpers/fakeChrome.js";

const ME = `8:orgid:${ME_OID}`;
const MY_EMAIL = "pat.lee@contoso.example";
const ALEX = "8:orgid:00000000-0000-4000-8000-00000000000a";
const SAM = "8:orgid:00000000-0000-4000-8000-00000000000b";
const CHAT = "19:contoso-launch@thread.v2";
const NEW_CHAT = "19:contoso-launch-team@thread.v2";

const csa = () => ({
  teams: [],
  chats: [
    { id: "48:notes", title: null, chatType: "chat", members: [{ mri: ME }] },
    { id: CHAT, title: "Contoso launch", chatType: "chat", members: [{ mri: ME }, { mri: ALEX }] },
  ],
});
const mt = (req: SentRequest) => {
  if (!/fetchShortProfile/.test(req.path)) return undefined;
  const all = [
    { mri: ME, displayName: "Pat Lee", email: MY_EMAIL },
    { mri: ALEX, displayName: "Alex Doe", email: "alex.doe@contoso.example" },
    { mri: SAM, displayName: "Sam Roe", email: "sam.roe@contoso.example" },
  ];
  return all.filter((p) => (req.body as string[]).includes(p.mri));
};

/** A 2xx whose body isn't JSON: e.g. a page a proxy put in front of the answer. */
const htmlPage = (status = 201) => reply(status, undefined, { text: "<!doctype html><html><body>Thanks</body></html>" });

/** chatsvc: posting a message answers with an HTML page; creating a chat answers with its location. */
const chatsvc = (req: SentRequest) => {
  if (req.method !== "POST") return undefined;
  if (/\/v1\/threads$/.test(req.path)) return reply(201, undefined, { location: `${BASES.chatsvc}/v1/threads/${NEW_CHAT}` });
  return htmlPage();
};

const messagePosts = (fake: FakeChrome) => fake.sent.filter((r) => r.service === "chatsvc" && r.method === "POST" && /\/messages$/.test(r.path)).map((r) => decodeURIComponent(r.path));

/** Sent, with the time marked as not confirmed, and no wording that invites sending again. */
function expectSentUnconfirmed(r: unknown) {
  expect(r).toMatchObject({ sent: true, time: null, timeNote: expect.stringMatching(/time (isn't|is not|couldn't be) confirmed/) });
  expect(JSON.stringify(r)).not.toMatch(/again|retry|may have been posted|failed|did not finish/i);
}

let h: BridgeHarness | undefined;
let link: { disconnect: () => Promise<void> } | undefined;

afterEach(async () => {
  await link?.disconnect();
  link = undefined;
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

/** A hub with the worker connected to it. */
async function withHub() {
  h = await bridgeHarness();
  const hub = await h.session();
  const fake = createFakeChrome({ services: { csa, mt, chatsvc }, local: { token: TOKEN, port: h.port } });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  link = await connectWorker(fake, () => hub.connected);
  return { hub, fake };
}

/** Waits for the confirmation window and clicks Send in it. */
async function clickSend(fake: FakeChrome) {
  await vi.waitFor(() => expect(fake.spies.windowsCreate).toHaveBeenCalledTimes(1));
  const id = /id=([^&]+)/.exec(fake.spies.windowsCreate.mock.calls[0][0]!.url!)![1];
  await fake.pageMessage(`confirm.html?id=${id}`, { type: "confirm:decide", id, approve: true });
}

describe("a post Teams accepts with an answer that isn't JSON", () => {
  it("77.4: after a click in the window, it is reported as sent once, with the time unconfirmed", async () => {
    const { hub, fake } = await withHub();
    const call = hub.call("requestSend", { conversation: CHAT, text: "Hi Alex" }, 60_000);
    await clickSend(fake);
    const r = await call;
    expectSentUnconfirmed(r);
    expect(messagePosts(fake)).toEqual([`/v1/users/ME/conversations/${CHAT}/messages`]);
  });

  it("77.4: auto-send to self is reported as sent once, with the time unconfirmed", async () => {
    const fake = createFakeChrome({ services: { csa, mt, chatsvc } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    const r = await worker.handlers.requestSend({ conversation: "48:notes", text: "Remember the slides", autoSendTo: [MY_EMAIL] });
    expectSentUnconfirmed(r);
    expect(r).toMatchObject({ autoSent: true });
    expect(messagePosts(fake)).toEqual(["/v1/users/ME/conversations/48:notes/messages"]);
    expect(fake.spies.windowsCreate).not.toHaveBeenCalled();
  });

  it("77.4: a new chat's first message is reported as sent once, with the time unconfirmed", async () => {
    const { hub, fake } = await withHub();
    const call = hub.call("requestSend", { to: [ALEX, SAM], title: "Contoso launch team", text: "Hi both" }, 60_000);
    await clickSend(fake);
    const r = await call;
    expectSentUnconfirmed(r);
    expect(r).toMatchObject({ newChat: true, conversationId: NEW_CHAT });
    expect(fake.sent.filter((q) => q.service === "chatsvc" && q.method === "POST").map((q) => decodeURIComponent(q.path))).toEqual(["/v1/threads", `/v1/users/ME/conversations/${NEW_CHAT}/messages`]);
  });

  it("77.4 (control): a read answered the same way still fails as not JSON", async () => {
    const fake = createFakeChrome({ services: { csa, mt, chatsvc: (req) => (req.method === "GET" ? htmlPage(200) : undefined) } });
    const worker = await loadWorker(fake);
    worker.registerListeners();
    await expect(worker.handlers.readMessages({ conversation: CHAT })).rejects.toThrow(/isn't JSON/);
  });
});
