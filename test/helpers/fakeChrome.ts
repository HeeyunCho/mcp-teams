// A fake `chrome` for running the extension's service worker (extension/background.js) in
// tests, shaped like a browser with Teams open. The worker's requests run in a Teams tab
// through chrome.scripting.executeScript(pageFetch). Here pageFetch runs from its source, as
// Chrome runs it, with a fetch that goes to scripted fake services (chatsvc, csa, mt,
// substrate, and SharePoint for transcripts), and the test sees each request.
import { expect, vi } from "vitest";
import WsWebSocket from "ws";

export type Service = "chatsvc" | "csa" | "mt" | "substrate" | "sharepoint";
export const TEAMS_SERVICES = ["chatsvc", "csa", "mt", "substrate"] as const;

/** What a fake service answers: a JSON body (HTTP 200) or reply(status, ...), maybe later. */
export interface Reply {
  status: number;
  body?: unknown;
  /** Sent as text as is (e.g. HTML or nothing); otherwise body is sent as JSON. */
  text?: string;
  location?: string | null;
}
const REPLY = Symbol("reply");
export const reply = (status: number, body: unknown = {}, extra: Omit<Reply, "status" | "body"> = {}): Reply => ({ status, body, ...extra, [REPLY]: true }) as Reply;
const isReply = (x: unknown): x is Reply => !!x && typeof x === "object" && REPLY in x;

/** What the in-page pageFetch (extension/background.js) returns when fetch gets no answer. */
interface NoAnswer {
  status: 0;
  text: "";
  error: string;
}
const NO_ANSWER = Symbol("no answer");
const isNoAnswer = (x: unknown): x is NoAnswer => !!x && typeof x === "object" && NO_ANSWER in x;
/** The page's fetch failed (e.g. offline): pageFetch's { status: 0, text: "", error: message }. */
export const networkError = (message = "Failed to fetch"): NoAnswer => ({ status: 0, text: "", error: message, [NO_ANSWER]: true }) as NoAnswer;
/** The page's fetch hit its timeout: pageFetch's { status: 0, text: "", error: "timeout" }. */
export const timedOut = (): NoAnswer => networkError("timeout");

/** A promise that never settles: Teams never answers (the page's fetch waits until its own timeout). */
export const never = <T = never>() => new Promise<T>(() => {});

/** One request the worker sent to a Teams service. */
export interface SentRequest {
  service: Service;
  method: string;
  /** Path below the service's base URL (with its query); the full URL for SharePoint. */
  path: string;
  url: string;
  body: any;
  headers: Record<string, string>;
  tabId: number;
}

/** A fake service: answers each request (a body, reply(), networkError(), timedOut() or never()); undefined → 404. */
export type Answer = (req: SentRequest) => unknown;

export const TEAMS_ORIGIN = "https://teams.cloud.microsoft";
/** The signed-in user (fictional). */
export const ME_OID = "00000000-0000-4000-8000-000000000001";
/** Where each service lives, as Teams' own requests show it (captured session). */
export const BASES: Record<(typeof TEAMS_SERVICES)[number], string> = {
  chatsvc: `${TEAMS_ORIGIN}/api/chatsvc/emea`,
  csa: `${TEAMS_ORIGIN}/api/csa/emea`,
  mt: `${TEAMS_ORIGIN}/api/mt/emea`,
  substrate: "https://substrate.office.com",
};
export const SHAREPOINT_ORIGIN = "https://contoso-my.sharepoint.com";

export interface FakeChromeOptions {
  /** The fake services; a service left out answers 404. */
  services?: Partial<Record<Service, Answer>>;
  /** Services with a captured session at start (default: all four). */
  captured?: (typeof TEAMS_SERVICES)[number][];
  /** A Teams tab is open (default true). */
  teamsTab?: boolean;
  /** chrome.storage.local at start (token, port, instance). */
  local?: Record<string, unknown>;
}

interface Tab {
  id: number;
  url: string;
  status: "loading" | "complete";
  discarded?: boolean;
  pinned?: boolean;
}

type Fn = (...args: any[]) => unknown;
const event = <F extends Fn = Fn>() => {
  const listeners: F[] = [];
  return { listeners, addListener: (fn: F) => void listeners.push(fn), removeListener: (fn: F) => void listeners.splice(listeners.indexOf(fn) >>> 0, 1) };
};
const patternToRegExp = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

export function createFakeChrome({ services = {}, captured = [...TEAMS_SERVICES], teamsTab = true, local: localInit = {} }: FakeChromeOptions = {}) {
  const sent: SentRequest[] = [];
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>(Object.entries(localInit));
  for (const s of captured) session.set(`capture:${s}`, { base: BASES[s], region: s === "substrate" ? null : "emea", headers: { authorization: "Bearer fake" }, at: 1 });
  session.set("oid", ME_OID);

  const tabs: Tab[] = teamsTab ? [{ id: 1, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" }] : [];
  let nextTabId = 100;
  let nextWindowId = 500;

  const storageChanged = event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>();
  const changed = (area: string, key: string, oldValue: unknown, newValue: unknown) => {
    const change = { [key]: { ...(oldValue === undefined ? {} : { oldValue }), ...(newValue === undefined ? {} : { newValue }) } };
    // Chrome delivers changes later, not inside set().
    void Promise.resolve().then(() => storageChanged.listeners.forEach((l) => l(change, area)));
  };
  const storageArea = (name: string, map: Map<string, unknown>) => ({
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(map);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => map.has(k)).map((k) => [k, map.get(k)]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        const old = map.get(k);
        map.set(k, v);
        changed(name, k, old, v);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        const old = map.get(k);
        if (map.delete(k)) changed(name, k, old, undefined);
      }
    }),
  });

  const routeOf = (url: string): { service: Service; path: string } | null => {
    if (url.startsWith(`${SHAREPOINT_ORIGIN}/`) || /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i.test(url)) return { service: "sharepoint", path: url };
    for (const s of TEAMS_SERVICES) {
      // The default base, or whatever base the test captured for the service (another region or tenant).
      const captured = (session.get(`capture:${s}`) as { base?: string } | undefined)?.base;
      for (const base of [BASES[s], captured]) if (base && url.startsWith(`${base}/`)) return { service: s, path: url.slice(base.length) };
    }
    return null;
  };

  /** The page's fetch: sends the request to its fake service, and gives up when `signal` aborts, as fetch does. */
  const fakeFetch = (tabId: number) => async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const route = routeOf(url);
    if (!route) throw new Error(`fakeChrome: no fake service for ${url}`);
    init.signal?.throwIfAborted();
    const req: SentRequest = { ...route, method: init.method, url, body: init.body == null ? null : JSON.parse(init.body), headers: init.headers, tabId };
    sent.push(req);
    const answer = services[route.service];
    const r = await new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      Promise.resolve(answer ? answer(req) : undefined).then(resolve, reject);
    });
    if (isNoAnswer(r)) throw r.error === "timeout" ? new DOMException("The operation timed out.", "TimeoutError") : new TypeError(r.error);
    if (r === undefined) return new Response("", { status: 404 });
    const { status, body, text, location = null } = isReply(r) ? r : { status: 200, body: r, text: undefined, location: null };
    return new Response(text ?? (body === undefined ? "" : JSON.stringify(body)), { status, headers: location ? { location } : {} });
  };
  /** Tabs whose scripts wait (a frozen or discarded tab), and the wake-up of each waiting script. */
  const frozen = new Map<number, (() => void)[]>();

  const windowRemoved = event<(windowId: number) => void>();
  const runtimeMessage = event<(msg: any, sender: any, sendResponse: (r: unknown) => void) => unknown>();
  const webRequestBefore: { fn: Fn; patterns: RegExp[] }[] = [];
  const webRequestCompleted: { fn: Fn; patterns: RegExp[] }[] = [];

  const spies = {
    executeScript: vi.fn(async ({ target, func, args }: { target: { tabId: number }; world?: string; func: Function; args: any[] }) => {
      if (func.name !== "pageFetch") throw new Error(`fakeChrome: unexpected tab script ${func.name}`);
      // Like Chrome: a tab that doesn't exist (or was closed) runs nothing.
      if (!tabs.some((t) => t.id === target.tabId)) throw new Error(`No tab with id: ${target.tabId}.`);
      const waiting = frozen.get(target.tabId);
      if (waiting) await new Promise<void>((wake) => waiting.push(wake));
      // Chrome runs the function from its source in the page, so it can use nothing of the worker.
      const script = new Function("fetch", `return (${func.toString()})`)(fakeFetch(target.tabId));
      return [{ result: await script(...args) }];
    }),
    tabsQuery: vi.fn(async ({ url }: { url?: string | string[] } = {}) => {
      const patterns = (url === undefined ? [] : Array.isArray(url) ? url : [url]).map(patternToRegExp);
      return tabs.filter((t) => !patterns.length || patterns.some((p) => p.test(t.url))).map((t) => ({ ...t }));
    }),
    tabsGet: vi.fn(async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error(`No tab with id: ${id}.`);
      return { ...t };
    }),
    tabsCreate: vi.fn(async ({ url, pinned }: { url: string; active?: boolean; pinned?: boolean }) => {
      const t: Tab = { id: nextTabId++, url, status: "complete", pinned };
      tabs.push(t);
      return { ...t };
    }),
    tabsReload: vi.fn(async (_id: number) => {}),
    windowsCreate: vi.fn(async ({ url }: { url?: string; type?: string; focused?: boolean } = {}) => {
      const t: Tab = { id: nextTabId++, url: url ?? "about:blank", status: "complete" };
      tabs.push(t);
      return { id: nextWindowId++, tabs: [{ ...t }] };
    }),
    windowsRemove: vi.fn(async (_id: number) => {}),
    runtimeReload: vi.fn(() => {}),
  };

  const chrome = {
    runtime: {
      id: "fake-extension-id",
      getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p: string) => `chrome-extension://fake-extension-id/${p}`,
      reload: spies.runtimeReload,
      onMessage: runtimeMessage,
      onStartup: event(),
      onInstalled: event(),
    },
    webRequest: {
      onBeforeSendHeaders: { addListener: (fn: Fn, filter: { urls: string[] }) => void webRequestBefore.push({ fn, patterns: filter.urls.map(patternToRegExp) }) },
      onCompleted: { addListener: (fn: Fn, filter: { urls: string[] }) => void webRequestCompleted.push({ fn, patterns: filter.urls.map(patternToRegExp) }) },
    },
    storage: { session: storageArea("session", session), local: storageArea("local", local), onChanged: storageChanged },
    tabs: { query: spies.tabsQuery, get: spies.tabsGet, create: spies.tabsCreate, reload: spies.tabsReload },
    windows: { create: spies.windowsCreate, remove: spies.windowsRemove, onRemoved: windowRemoved },
    scripting: { executeScript: spies.executeScript },
    alarms: { create: vi.fn(), onAlarm: event() },
  };

  return {
    chrome,
    /** Every request the worker sent to a fake service, in order. */
    sent,
    session,
    local,
    tabs,
    spies,
    /** How many requests went to `service` (whose path matches `path`, if given). */
    count: (service: Service, path?: RegExp) => sent.filter((r) => r.service === service && (!path || path.test(r.path))).length,
    /** The user closes a tab: it is no longer found, and a script can't run in it. */
    closeTab(tabId: number) {
      const i = tabs.findIndex((t) => t.id === tabId);
      if (i >= 0) tabs.splice(i, 1);
    },
    /** The tab stops running scripts (frozen or discarded): executeScript waits until wake(). */
    freezeTab(tabId: number) {
      if (!frozen.has(tabId)) frozen.set(tabId, []);
    },
    /** A frozen tab wakes: the scripts that waited run now. */
    wake(tabId: number) {
      const waiting = frozen.get(tabId) ?? [];
      frozen.delete(tabId);
      for (const w of waiting) w();
    },
    /** Chrome reports that the user closed a window. */
    closeWindow: (windowId: number) => windowRemoved.listeners.forEach((l) => l(windowId)),
    /** Runs the worker's webRequest listeners whose URL filter matches, as Chrome would. */
    async fire(kind: "beforeSendHeaders" | "completed", details: { url: string; method?: string; initiator?: string; requestHeaders?: { name: string; value: string }[]; statusCode?: number }) {
      const list = kind === "completed" ? webRequestCompleted : webRequestBefore;
      for (const l of list) if (l.patterns.some((p) => p.test(details.url))) await l.fn({ method: "GET", requestHeaders: [], type: "xmlhttprequest", initiator: TEAMS_ORIGIN, ...details });
    },
    /** A message from one of the extension's pages (e.g. "confirm.html?id=…"); resolves with the worker's answer. */
    pageMessage(page: string, msg: object) {
      return new Promise((resolve) => {
        let pending = false;
        const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL(page) };
        for (const l of runtimeMessage.listeners) if (l(msg, sender, resolve) === true) pending = true;
        if (!pending) setTimeout(() => resolve(undefined), 0);
      });
    },
    /** The number of listeners the worker registered on each chrome event (0 until registerListeners()). */
    listenerCounts: () => ({
      onMessage: runtimeMessage.listeners.length,
      windowsOnRemoved: windowRemoved.listeners.length,
      storageOnChanged: storageChanged.listeners.length,
      webRequest: webRequestBefore.length + webRequestCompleted.length,
      onAlarm: chrome.alarms.onAlarm.listeners.length,
    }),
    reset() {
      sent.length = 0;
      for (const s of Object.values(spies)) s.mockClear();
    },
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;

/** The service worker's exports (extension/background.js). */
export interface Worker {
  handlers: Record<string, (params: any) => Promise<any>>;
  dispatch: (msg: { type: string; id?: string; method?: string; params?: unknown; timeoutMs?: number }, send: (reply: object) => void) => Promise<void>;
  registerListeners: () => void;
  /** How many confirmation windows wait for the user's decision. */
  pendingSendCount: () => number;
}

/** WebSockets the worker opened while loaded by loadWorker (none expected outside Chrome). */
export const openedSockets: string[] = [];

/**
 * The browser WebSocket API, taken before any test stubs it: Node's own (Node 22+), else
 * the ws package's, which implements the same API (Node 20, as in CI, has no global one).
 */
const NativeWebSocket = globalThis.WebSocket ?? (WsWebSocket as unknown as typeof globalThis.WebSocket);

/** Stands in for WebSocket: records the URL and never connects. */
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  constructor(url: string) {
    openedSockets.push(url);
  }
  send() {}
  close() {}
}

/**
 * Loads a fresh copy of the service worker against `fake` (module state such as caches
 * starts over). Outside a real extension the worker registers no listeners and opens no
 * connection; a test that needs the listeners calls worker.registerListeners().
 */
export async function loadWorker(fake: FakeChrome): Promise<Worker> {
  vi.resetModules();
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("WebSocket", InertWebSocket);
  // As in Chrome's service worker; Node 20 (CI) has no navigator, Node 21+ one without brands.
  vi.stubGlobal("navigator", { userAgentData: { brands: [{ brand: "Google Chrome", version: "130" }] } });
  // @ts-expect-error plain JS service worker without types
  return import("../../extension/background.js");
}

/**
 * Connects a loaded worker (listeners registered) to a real bridge hub, as in the browser:
 * `fake` holds the pairing token and port in chrome.storage.local. Resolves once
 * `connected()` holds (e.g. () => hub.connected). Call disconnect() before the test ends:
 * it leaves the worker with a socket that never connects, so it stops retrying.
 */
export async function connectWorker(fake: FakeChrome, connected: () => boolean) {
  vi.stubGlobal("WebSocket", NativeWebSocket);
  for (const l of fake.chrome.runtime.onStartup.listeners) l();
  await vi.waitFor(() => expect(connected()).toBe(true), { timeout: 3_000 });
  return {
    /** A pairing change makes the worker reconnect, here to a socket that never opens. */
    async disconnect() {
      const before = openedSockets.length;
      vi.stubGlobal("WebSocket", InertWebSocket);
      await fake.chrome.storage.local.set({ token: `${String(fake.local.get("token"))}-changed` });
      await vi.waitFor(() => expect(openedSockets.length).toBeGreaterThan(before));
    },
  };
}
