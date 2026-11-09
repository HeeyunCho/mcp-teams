// Service worker: connects to the local MCP server over WebSocket and runs Teams
// requests inside an open Teams tab, with the session Teams itself uses.

import * as teams from "./teams.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 47393;
/**
 * What hello declares to the hub (#115), as mcp-newoutlook's extension does (EXTENSION_FEATURES in
 * its extension/background.js). No features yet: "native" is only for a native host's port.
 * maxMessageBytes: the largest message it takes, the server's own MAX_MESSAGE_BYTES (Chrome's
 * WebSocket sets no lower limit of its own).
 */
const CAPABILITIES = Object.freeze({ features: Object.freeze([]), maxMessageBytes: 256 * 1024 * 1024 });
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
// One Teams request; below the server's own timeout.
const REQUEST_TIMEOUT_MS = 60_000;

const TEAMS_URLS = ["https://teams.cloud.microsoft/*", "https://teams.microsoft.com/*"];
const DEFAULT_TEAMS_URL = "https://teams.cloud.microsoft/";

let ws = null;
let state = "disconnected"; // disconnected | connecting | connected | unauthorized
let lastError = null;

// ------------------------------------------------------------ session capture

/**
 * Teams authenticates each service (chat, teams list, people, search) with its own
 * token, sent in headers. We observe them on Teams' own requests, including those of
 * its workers, and replay them. They live in chrome.storage.session (memory only).
 */
function captureSession(details) {
  const svc = teams.serviceOf(details.url);
  if (!svc) return;
  const headers = teams.pickHeaders(details.requestHeaders);
  if (!headers) return;
  // Whose session it is: the user its token was issued to (an object id is one tenant's).
  const oid = teams.tokenOid(headers) ?? svc.oid ?? null;
  const capture = { base: svc.base, region: svc.region ?? null, headers, at: Date.now(), oid };
  return (captureQueue = captureQueue.then(() => storeCapture(svc.service, capture)).catch(() => {}));
}

const CAPTURED_SERVICES = ["chatsvc", "csa", "mt", "substrate"];
let captureQueue = Promise.resolve(); // one capture at a time, so a switch is seen in order
/** Whose session is stored, once the captures already queued are stored (a switch may be among them). */
async function signedInOid() {
  await captureQueue;
  return (await chrome.storage.session.get("oid")).oid;
}

/**
 * Stores a capture. One from another user than the signed-in one (the user switched Teams to
 * another tenant or account) retires the other services' sessions, which belong to the
 * previous one (or to nobody known), and the caches of what that user saw: the next request
 * to those services waits for Teams' own request as the new user.
 *
 * The same session again (same base, headers and user: every request Teams, or this worker in
 * its tab, makes with it) isn't written: it only marks the stored one as seen now (`seenAt`).
 *
 * A request Teams retries with the previous user's old token isn't a switch back (#77): see
 * isOldToken. Such a capture is dropped (not stored, nothing cleared) and counted.
 *
 * A dropped capture also leaves it unknown which account Teams shows (it may be the previous
 * user's again, #77): the account is unsure until that switch's window closes (see
 * accountUnsure). A capture of the previous user that switches back (a newer token, or one
 * without `iat`) starts a new switch with its own window, not unsure: should Teams still show
 * the other user, that user's next capture within it is dropped and marks it unsure (or, newer,
 * switches again).
 */
async function storeCapture(service, capture) {
  const key = `capture:${service}`;
  const { [key]: held, oid: was, [SWITCH_KEY]: lastSwitch, [DROPPED_KEY]: dropped = NO_DROPS } = await chrome.storage.session.get([key, "oid", SWITCH_KEY, DROPPED_KEY]);
  if (sameSession(held, capture) && (!capture.oid || capture.oid === was)) {
    seenAt.set(service, capture.at);
    for (const f of [...captureSeen]) f(service);
    return;
  }
  const iat = teams.tokenIssuedAt(capture.headers);
  if (capture.oid && was && was !== capture.oid && isOldToken(capture, iat, lastSwitch)) {
    await chrome.storage.session.set({
      [DROPPED_KEY]: { count: dropped.count + 1, lastAt: capture.at },
      [SWITCH_KEY]: { ...lastSwitch, unsureSince: lastSwitch.unsureSince ?? capture.at },
    });
    return;
  }
  seenAt.delete(service);
  const update = { [key]: capture };
  if (capture.oid) {
    if (was && was !== capture.oid) {
      const others = CAPTURED_SERVICES.filter((s) => s !== service).map((s) => `capture:${s}`);
      const held = await chrome.storage.session.get(others);
      const stale = others.filter((k) => held[k] && held[k].oid !== capture.oid);
      if (stale.length) await chrome.storage.session.remove(stale);
      forgetAccount();
      update[SWITCH_KEY] = { from: was, at: capture.at, iat, unsureSince: null };
    }
    update.oid = capture.oid;
  }
  await chrome.storage.session.set(update);
}

/**
 * The last switch of the signed-in user: { from (the previous user's oid), at (ms since 1970),
 * iat (of the token that switched, null without one), unsureSince (ms since 1970: when a capture
 * of the previous user was first dropped, null before one was) }. Kept in
 * chrome.storage.session like the captures, so a restart of this worker keeps it and a browser
 * restart clears it.
 */
const SWITCH_KEY = "accountSwitch";
/** Captures dropped as an old token of the previous user: { count, lastAt (ms since 1970) }, no account data. */
const DROPPED_KEY = "droppedOldCaptures";
const NO_DROPS = { count: 0, lastAt: null };
const OLD_TOKEN_WINDOW_MS = 30_000;

/**
 * Whether a capture of another user than the signed-in one is the previous user's old token (a
 * request Teams retries with it) rather than a switch: within 30 s of the switch, for the user it
 * switched from, issued before the token that switched. A token without a readable `iat` (or a
 * switch caused by one), a later one, a third user, or one after the 30 s switches as before.
 */
function isOldToken(capture, iat, lastSwitch) {
  if (!lastSwitch || lastSwitch.from !== capture.oid) return false;
  if (!(capture.at - lastSwitch.at < OLD_TOKEN_WINDOW_MS)) return false;
  return Number.isFinite(iat) && Number.isFinite(lastSwitch.iat) && iat < lastSwitch.iat;
}

/**
 * Whether the account is unsure (#77): the previous user showed again within the last switch's
 * window, so Teams may show either. { since, until } (ms since 1970; until = the switch's `at` +
 * OLD_TOKEN_WINDOW_MS), or null. Read once the captures already queued are stored. Sends are
 * refused meanwhile (UNSURE_SEND); reads go on, with a note (UNSURE_READ).
 */
async function accountUnsure() {
  await captureQueue;
  const lastSwitch = (await chrome.storage.session.get(SWITCH_KEY))[SWITCH_KEY];
  if (lastSwitch?.unsureSince == null) return null;
  const until = lastSwitch.at + OLD_TOKEN_WINDOW_MS;
  return Date.now() < until ? { since: lastSwitch.unsureSince, until } : null;
}

/** A time as the user's clock shows it (HH:MM:SS, local), rounded up to the second. */
const clockTime = (ms) => {
  const d = new Date(Math.ceil(ms / 1000) * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};
const UNSURE_SEND = (u) => `Teams switched accounts moments ago; try again after ${clockTime(u.until)}. Nothing was sent: until then it isn't certain which account Teams shows.`;
const UNSURE_READ = (u) =>
  `Teams switched accounts moments ago: until ${clockTime(u.until)} it isn't certain that this answer is from the account Teams shows (signedInAs in get_version).`;

// service -> when Teams last sent the stored session again (in memory: no storage write for it)
const seenAt = new Map();
// Called with the service whenever its stored session is seen again (see waitForCapture).
const captureSeen = new Set();

const sameHeaders = (a = {}, b = {}) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};
/** Whether two captures hold the same session (when they were seen aside). */
const sameSession = (a, b) => !!a && a.base === b.base && (a.region ?? null) === (b.region ?? null) && (a.oid ?? null) === (b.oid ?? null) && sameHeaders(a.headers, b.headers);

const captureFilter = {
  urls: [
    "https://teams.cloud.microsoft/api/*",
    "https://teams.microsoft.com/api/*",
    "https://*.ng.msg.teams.microsoft.com/*",
    "https://substrate.office.com/*",
  ],
};

/**
 * Which endpoints Teams uses for meetings, recaps and files is not documented, so we log
 * the calls the Teams tab makes (method, host, path, header *names*, auth scheme) for the
 * api_traffic tool. Kept in chrome.storage.session, so a browser restart clears it.
 * Recorded only while api_traffic turned recording on (record: true), for at most
 * TRAFFIC_RECORD_MS; when it ends is kept in chrome.storage.session too, so it survives a
 * restart of this worker.
 */
const TRAFFIC_KEY = "traffic";
const TRAFFIC_UNTIL_KEY = "trafficUntil";
const TRAFFIC_RECORD_MS = 30 * 60_000;
let traffic = null;
let trafficSave = null; // { timer, store }: the pending save, and the storage it goes to
let trafficQueue = Promise.resolve();
let trafficUntil = null; // ms since 1970 when recording ends (0: off); null until read from storage

async function recordingUntil() {
  trafficUntil ??= (await chrome.storage.session.get(TRAFFIC_UNTIL_KEY))[TRAFFIC_UNTIL_KEY] ?? 0;
  return trafficUntil;
}

/**
 * Applies fn to the log one update at a time, so events that land together don't overwrite
 * each other. `ifRecording`: only while recording is on. Saved only when fn changed the log.
 */
function updateTraffic(fn, { ifRecording = false } = {}) {
  trafficQueue = trafficQueue
    .then(async () => {
      if (ifRecording && Date.now() >= (await recordingUntil())) return;
      traffic ??= (await chrome.storage.session.get(TRAFFIC_KEY))[TRAFFIC_KEY] ?? [];
      const next = fn(traffic);
      if (next === traffic) return;
      traffic = next;
      clearTimeout(trafficSave?.timer);
      // The storage is taken now: the save goes where the request was recorded, whatever `chrome` is
      // by then (in tests, the next test's fake or none).
      const store = chrome.storage.session;
      trafficSave = { store, timer: setTimeout(savePendingTraffic, 500) };
    })
    .catch(() => {});
  return trafficQueue;
}

/** Saves the log now if a save is pending (also for tests, instead of waiting half a second). */
export function savePendingTraffic() {
  if (!trafficSave) return;
  const { store, timer } = trafficSave;
  clearTimeout(timer);
  trafficSave = null;
  store.set({ [TRAFFIC_KEY]: traffic }).catch(() => {}); // kept in memory: the next change saves again
}

const trafficFilter = { urls: teams.TRAFFIC_URLS, types: ["xmlhttprequest", "other", "media"] };

function recordRequest(details) {
  if (!teams.isTeamsOrigin(details.initiator)) return;
  const entry = teams.summarizeRequest(details);
  updateTraffic((list) => teams.recordTraffic(list, entry), { ifRecording: true });
  return noteCall(details);
}

/**
 * When the Teams tab last made a call, and when it last made a signed-in one (with credentials, to a
 * service whose session is captured), always, whether or not api_traffic records (#103): get_version tells from them
 * a tab stuck at sign-in or asleep from a call the capture missed. Only the time and the host, never
 * a URL, header value or token. Kept in chrome.storage.session like the captures, so a restart of
 * this worker keeps them and a browser restart clears them; saved at most every half second.
 */
const CALLS_KEY = "teamsCalls";
const NO_CALLS = { lastTeamsCall: null, lastSignedInCall: null };
let calls = null; // { lastTeamsCall, lastSignedInCall }: each { at (ms since 1970), host } or null; null until read
let callsQueue = Promise.resolve();
let callsSave = null; // { timer, store }: the pending save, and the storage it goes to

function teamsCalls() {
  callsQueue = callsQueue.then(async () => {
    try {
      calls ??= (await chrome.storage.session.get(CALLS_KEY))[CALLS_KEY] ?? NO_CALLS;
    } catch {
      calls ??= NO_CALLS; // unreadable: start over rather than lose the calls from now on
    }
  });
  return callsQueue.then(() => calls);
}

function noteCall(details) {
  const call = { at: Date.now(), host: new URL(details.url).host };
  // Signed in: credentials to a service whose session a capture would store (not e.g. Graph or authsvc).
  const signedIn = !!teams.serviceOf(details.url) && !!teams.pickHeaders(details.requestHeaders);
  return teamsCalls().then((held) => {
    calls = { lastTeamsCall: call, lastSignedInCall: signedIn ? call : held.lastSignedInCall };
    if (callsSave) return;
    // The storage is taken now: the save goes where the calls were seen, whatever `chrome` is by then
    // (in tests, the next test's fake or none).
    const store = chrome.storage.session;
    callsSave = { store, timer: setTimeout(savePendingCalls, 500) };
  });
}

/** Saves the last calls now if a save is pending (also for tests, instead of waiting half a second). */
export function savePendingCalls() {
  if (!callsSave) return;
  const { store, timer } = callsSave;
  clearTimeout(timer);
  callsSave = null;
  store.set({ [CALLS_KEY]: calls }).catch(() => {});
}

const callAt = (c) => (c ? { at: new Date(c.at).toISOString(), host: c.host } : null);

/** For status: whether the account is unsure (#77), { since, until } as ISO times, or null. */
async function accountUnsureStatus() {
  const u = await accountUnsure();
  return u && { since: new Date(u.since).toISOString(), until: new Date(u.until).toISOString() };
}

/** For status: how many captures were dropped as an old token of the previous user, and when the last one was (#77). */
async function droppedOldCaptures() {
  const { count, lastAt } = (await chrome.storage.session.get(DROPPED_KEY))[DROPPED_KEY] ?? NO_DROPS;
  return { count, lastAt: lastAt == null ? null : new Date(lastAt).toISOString() };
}

function recordCompleted(details) {
  if (!teams.isTeamsOrigin(details.initiator)) return;
  const url = new URL(details.url);
  const key = `${details.method} ${url.host}${url.pathname.slice(0, 300)}`;
  updateTraffic((list) => teams.recordStatus(list, key, details.statusCode), { ifRecording: true });
}

/** The service's captured session; its `at` is when Teams last sent it (stored, or seen again since). */
async function getCapture(service) {
  const key = `capture:${service}`;
  const cap = (await chrome.storage.session.get(key))[key] ?? null;
  const seen = seenAt.get(service);
  return cap && seen > cap.at ? { ...cap, at: seen } : cap;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until Teams sends the service a session after `since` (a new one, or the stored one
 * again); null on timeout. Listens for the capture instead of asking for it. `rejected`: the
 * headers Teams refused (401); that session sent again (by Teams, or replayed by another call)
 * doesn't count, only one with other credentials. `signal`: aborting it ends the wait (null).
 */
function waitForCapture(service, since, timeoutMs, rejected = null, signal = null) {
  const key = `capture:${service}`;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (cap) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChanged);
      captureSeen.delete(onSeen);
      signal?.removeEventListener("abort", onAbort);
      resolve(cap);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort);
    const check = async () => {
      const cap = await getCapture(service);
      if (cap && cap.at > since && !(rejected && sameHeaders(cap.headers, rejected))) finish(cap);
    };
    const onChanged = (changes, area) => area === "session" && changes[key]?.newValue && check();
    const onSeen = (s) => s === service && check();
    const timer = setTimeout(() => finish(null), timeoutMs);
    chrome.storage.onChanged.addListener(onChanged);
    captureSeen.add(onSeen);
    check();
  });
}

const OPEN_TAB_WAIT_MS = 60_000;
let autoTabId = null; // the tab this extension opened, reused while it exists
let opening = null; // Promise of the tab being opened, so parallel calls open one

/**
 * With no Teams tab open, opens one in the background (pinned, not focused) and waits
 * until Teams has signed in and made its first chat request.
 */
function openTeamsTab() {
  opening ??= (async () => {
    const since = Date.now();
    let tab = autoTabId === null ? null : await chrome.tabs.get(autoTabId).catch(() => null);
    if (!tab) {
      tab = await chrome.tabs
        .create({ url: DEFAULT_TEAMS_URL, active: false, pinned: true })
        // No browser window open: open Teams in a new one, without taking focus.
        .catch(async () => (await chrome.windows.create({ url: DEFAULT_TEAMS_URL, focused: false })).tabs[0]);
      autoTabId = tab.id;
    }
    const cap = await waitForCapture("chatsvc", since, OPEN_TAB_WAIT_MS);
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error("The Teams tab that was opened was closed. Try again, or open Teams yourself.");
    if (!cap) {
      const at = current.url || current.pendingUrl;
      throw new Error(`Teams was opened in a background tab but isn't signed in yet. Sign in there${at ? ` (${at.split("/").slice(0, 3).join("/")})` : ""}, then try again.`);
    }
    await waitForTabLoaded(tab.id);
    return current;
  })().finally(() => (opening = null));
  return opening;
}

// The tabs a request can run in: Teams, and SharePoint (transcripts), found with one lookup.
const TEAMS_TAB = /^https:\/\/(teams\.cloud\.microsoft|teams\.microsoft\.com)\//;
const TAB_URLS = [...TEAMS_URLS, "https://*.sharepoint.com/*"];

/**
 * The open Teams and SharePoint tabs. A call (`ctx`) looks them up once and reuses the list
 * (with the tabs it opened added, see knownTab); without one, every time.
 */
function openTabs(ctx) {
  if (!ctx) return chrome.tabs.query({ url: TAB_URLS });
  ctx.tabs ??= chrome.tabs.query({ url: TAB_URLS });
  return ctx.tabs;
}

/** Adds a tab the call opened (or found ready) to its list, so its next request finds it. */
function knownTab(ctx, tab) {
  if (ctx?.tabs) ctx.tabs = ctx.tabs.then((list) => [...list.filter((t) => t.id !== tab.id), tab]);
  return tab;
}

/**
 * The user's Teams tabs among `tabs`: never the background tab opened to recapture a session while
 * it is recorded (it closes soon, and a request running there would fail with it). Once the user
 * switched to it (it opens inactive, so active means they did), it is kept, so it counts like
 * any other at once, before the worker forgets it.
 */
async function userTeamsTabs(tabs) {
  const helper = await helperTabId();
  return tabs.filter((t) => TEAMS_TAB.test(t.url ?? "") && (t.id !== helper || t.active));
}

/**
 * The Teams tab to run requests in: one on the origin of the service's capture, else any. With
 * only the helper open, it opens one as with none (the helper is about to close).
 */
async function findTeamsTab(origin, ctx = null) {
  const tabs = await userTeamsTabs(await openTabs(ctx));
  if (!tabs.length) return knownTab(ctx, await openTeamsTab());
  const sameOrigin = tabs.filter((t) => origin && t.url?.startsWith(origin));
  const pool = sameOrigin.length ? sameOrigin : tabs;
  return pool.find((t) => !t.discarded && t.status === "complete") ?? pool[0];
}

/** For list_teams and list_chats: with no Teams tab open, say so now rather than open one and wait. */
async function requireTeamsTab(ctx) {
  const tabs = await userTeamsTabs(await openTabs(ctx));
  if (!tabs.length) throw new Error("There is no Teams tab open. Open Teams in your browser, sign in, then try again.");
}

// Teams keeps routing for a moment after the page has loaded.
const SETTLE_MS = 1_000;

/**
 * Waits until the tab is `ready(tab)`, listening for its updates: resolves with the tab, null
 * once it is closed, or undefined after timeoutMs.
 */
function waitForTab(tabId, ready, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(result);
    };
    const onUpdated = (id, _change, tab) => id === tabId && ready(tab) && finish(tab);
    const onRemoved = (id) => id === tabId && finish(null);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(
      (t) => ready(t) && finish(t),
      () => finish(null),
    );
  });
}

async function waitForTabLoaded(tabId, timeoutMs = 30_000) {
  if (await waitForTab(tabId, (t) => t.status === "complete", timeoutMs)) await sleep(SETTLE_MS);
}

// service -> { promise (capture|null), waiting (calls), kept, stop }, so parallel calls for a service wait once
const refreshing = new Map();

/**
 * A captured token is lost when the extension reloads and expires after about an hour.
 * Teams' next own request to the service brings a fresh one; if none comes within
 * `quickWaitMs`, Teams is opened in a background tab (recaptureInHelperTab), whose requests
 * bring the session. The user's own Teams tab is never reloaded (a call or meeting there would
 * drop): null when the session didn't come back (the caller fails with SERVICE_HELP).
 * Search (substrate) gets no background tab: Teams signs in to it only once its search box was
 * used, so a tab that just loaded wouldn't bring it. Nor does a user's tab that is still loading:
 * it calls its services by itself, so the call waits for that (at most LOADING_TAB_WAIT_MS).
 * `rejected`: the headers of a session Teams refused (401), which doesn't count as a fresh one.
 * A call (`ctx`) that is withdrawn stops waiting at once (its reason); once every call waiting
 * for the service was withdrawn, the wait itself is dropped, so the background tab doesn't stay
 * open for nobody (a call without a ctx never withdraws).
 */
function refreshSession(service, tab, { quickWaitMs = 4_000, rejected = null } = {}, ctx = null) {
  if (ctx?.cancelled) return Promise.reject(ctx.reason);
  let entry = refreshing.get(service);
  if (!entry) {
    const since = Date.now();
    const stop = new AbortController();
    const { signal } = stop;
    entry = { waiting: 0, kept: false, stop };
    const self = entry;
    entry.promise = (async () => {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (current?.status === "loading") return waitForCapture(service, since, LOADING_TAB_WAIT_MS, rejected, signal);
      const quick = quickWaitMs ? await waitForCapture(service, since, quickWaitMs, rejected, signal) : null;
      if (quick) return quick;
      if (service === "substrate" || signal.aborted) return null;
      return recaptureInHelperTab(service, teamsOrigin(tab), since, rejected, signal);
    })().finally(() => refreshing.get(service) === self && refreshing.delete(service));
    refreshing.set(service, entry);
  }
  if (!ctx) {
    entry.kept = true;
    return entry.promise;
  }
  const self = entry;
  self.waiting++;
  const stopWatching = ctx.onCancel(() => {
    if (--self.waiting > 0 || self.kept) return;
    // Nobody waits for it anymore: a later call starts afresh.
    if (refreshing.get(service) === self) refreshing.delete(service);
    self.stop.abort();
  });
  self.promise.then(stopWatching, stopWatching);
  return guarded(self.promise, ctx);
}

const teamsOrigin = (tab) => {
  const url = tab?.url || tab?.pendingUrl;
  return TEAMS_TAB.test(url ?? "") ? new URL(url).origin : new URL(DEFAULT_TEAMS_URL).origin;
};

// After a reload: how long Teams' own requests get to bring the session back. Then, as after any
// missing or rejected session, how long Teams in the background tab gets to sign in.
const RECAPTURE_GRACE_MS = 15_000;
const RECAPTURE_WAIT_MS = 60_000;
// A call that joins the background tab late still waits at least this long (the tab stays open for it).
const RECAPTURE_JOIN_MIN_MS = 20_000;
// How long a call waits for a user's Teams tab that is still loading to bring the session.
const LOADING_TAB_WAIT_MS = 30_000;
let recapturing = null; // Promise of recaptureMissingChatSession while it runs, so a second trigger starts none
// The background tab (one at a time), kept in chrome.storage.session so a later worker can close it.
const HELPER_TAB_KEY = "recaptureHelperTab";
// The background tab's run while it is open: { since, waits (Promise<capture|null>[]), tabGone, done, closing }.
let helperRun = null;

/**
 * Opens Teams (`origin`) in a background tab, where it signs in and calls its services as on any
 * load, and waits until `service` is captured there (other credentials than `rejected`), at most
 * RECAPTURE_WAIT_MS from when the tab was opened, or RECAPTURE_JOIN_MIN_MS for a call that joins
 * late: the capture, or null. One tab at a time: a call for another service while it is open
 * waits on the same tab, which closes once every wait asked of it ended (unless the user switched
 * to it), or as soon as the user closes it. It never reloads or scripts the user's own Teams tab.
 * `signal`: aborting it ends this wait (null) when nobody waits for it anymore, so the tab closes
 * once no other wait is left.
 */
function recaptureInHelperTab(service, origin, since = Date.now(), rejected = null, signal = null) {
  if (!helperRun || helperRun.closing) {
    const run = { since: Date.now(), waits: [], closing: false };
    let tabClosed;
    run.tabGone = new Promise((r) => (tabClosed = r));
    let tabId = null;
    let closed = false;
    const onRemoved = (id) => id === tabId && tabClosed();
    const previous = helperRun?.done;
    run.done = (async () => {
      await previous; // a run still closing its tab finishes first: one background tab at a time
      chrome.tabs.onRemoved.addListener(onRemoved);
      const tab = await chrome.tabs.create({ url: `${origin}/`, active: false });
      tabId = tab.id;
      await chrome.storage.session.set({ [HELPER_TAB_KEY]: tab.id });
      // Until every wait settled, including those that joined meanwhile, or the user closed the tab.
      for (let n = -1; n !== run.waits.length; ) {
        n = run.waits.length;
        await Promise.race([Promise.all(run.waits), run.tabGone]);
      }
      run.closing = true;
      closed = true;
      await closeHelperTab(tab.id);
    })()
      .catch(() => {})
      .finally(async () => {
        run.closing = true;
        chrome.tabs.onRemoved.removeListener(onRemoved);
        tabClosed();
        // Something failed after the tab was opened (e.g. recording it): it isn't left open.
        if (tabId !== null && !closed) await closeHelperTab(tabId).catch(() => {});
        if (helperRun === run) helperRun = null;
      });
    helperRun = run;
  }
  const run = helperRun;
  const left = Math.max(run.since + RECAPTURE_WAIT_MS - Date.now(), RECAPTURE_JOIN_MIN_MS);
  const wait = Promise.race([waitForCapture(service, since, left, rejected, signal), run.tabGone.then(() => null)]);
  run.waits.push(wait);
  return wait;
}

/** The id of that background tab while it is recorded, else null. */
async function helperTabId() {
  const { [HELPER_TAB_KEY]: tabId } = await chrome.storage.session.get(HELPER_TAB_KEY);
  return tabId ?? null;
}

/** The Teams tabs that have loaded and are awake (not discarded or unloaded). */
async function awakeTeamsTabs() {
  return (await chrome.tabs.query({ url: TEAMS_URLS })).filter((t) => TEAMS_TAB.test(t.url ?? "") && !t.discarded && t.status === "complete");
}

/**
 * Chrome clears chrome.storage.session when the extension is reloaded or updated, and when the
 * browser restarts, so the captured sessions are gone; a Teams tab left in the background may
 * not call its services again for a long time (a tab restored at a browser start may even have
 * made its first calls before this worker listened). Unless Teams does so within
 * RECAPTURE_GRACE_MS, this gets the chat session back through the background tab
 * (recaptureInHelperTab). Nothing is done without a Teams tab that has loaded and is awake: one
 * still loading calls its services itself, and a discarded or unloaded one isn't woken.
 */
function recaptureMissingChatSession() {
  recapturing ??= (async () => {
    const since = Date.now();
    if (await getCapture("chatsvc")) return true;
    const awake = await awakeTeamsTabs();
    if (!awake.length) return false; // nothing decided: no Teams tab loaded and awake
    if (await waitForCapture("chatsvc", since, RECAPTURE_GRACE_MS)) return true;
    await recaptureInHelperTab("chatsvc", teamsOrigin(awake[0]), since);
    return true;
  })()
    .catch(() => false)
    .finally(() => (recapturing = null));
  return recapturing;
}

// Set in chrome.storage.session once this browser session's (or extension load's) check for a
// missing chat session has finished, so it runs once: a Teams tab stuck at sign-in gets one
// background tab, not one per alarm.
const START_CHECK_KEY = "startRecaptureChecked";

/**
 * After a browser start, an extension reload or update, and on each reconnect alarm: once per
 * browser session, recaptureMissingChatSession (calls while it runs share that run). The flag is
 * set only once the run has finished and decided something, so a worker suspended mid-run, or a
 * Teams tab still loading or asleep, leaves it unset: a later alarm checks again.
 * Use this, not recaptureMissingChatSession, for any new trigger.
 */
async function recaptureOnce() {
  if ((await chrome.storage.session.get(START_CHECK_KEY))[START_CHECK_KEY]) return;
  if (await recaptureMissingChatSession()) await chrome.storage.session.set({ [START_CHECK_KEY]: true });
}

/** Closes the background tab, unless the user switched to it, and forgets it. */
async function closeHelperTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && !tab.active) await chrome.tabs.remove(tabId).catch(() => {});
  if ((await helperTabId()) === tabId) await chrome.storage.session.remove(HELPER_TAB_KEY);
}

/**
 * A worker suspended while its background tab was open never closed it (Teams there may sit on
 * a sign-in page): the next worker closes it when it wakes.
 */
async function closeLeftoverHelperTab() {
  if (helperRun) return; // this worker's own run closes it
  const tabId = await helperTabId();
  if (tabId != null) await closeHelperTab(tabId);
}

// Exported for the tests: the server recognises the missing-session errors by this wording (src/sessionNote.ts).
export const SERVICE_HELP = {
  chatsvc: "Teams' chat session is not available. Reload the Teams tab and try again.",
  csa: "Teams' team list session is not available. Reload the Teams tab and try again.",
  mt: "Teams' people session is not available. Reload the Teams tab and try again.",
  substrate:
    "Teams' search session is not available yet. Click into the search box at the top of Teams once (that makes Teams sign in to search), then try again.",
};

/**
 * Runs inside the Teams page (MAIN world) so cookies and origin are the page's own.
 * status 0: no answer (network error, or the deadline passed). `deadline` is absolute
 * (ms since 1970): a tab that runs this only later (frozen or discarded) sends nothing after it.
 */
async function pageFetch(url, method, headers, body, deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return { status: 0, text: "", error: "timeout" };
  try {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: body == null ? headers : { ...headers, "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text(), location: res.headers.get("location"), retryAfter: res.headers.get("retry-after") };
  } catch (err) {
    return { status: 0, text: "", error: err?.name === "TimeoutError" ? "timeout" : String(err?.message ?? err) };
  }
}

/** 60, 0.5: seconds for a message. */
const secondsOf = (ms) => +(ms / 1000).toFixed(1);

/** How long after its deadline a tab script may take to report back before the tab counts as frozen. */
const SCRIPT_MARGIN_MS = 1_000;

/** An error after which the request may have reached Teams (no answer came): `outcomeUnknown`. */
function unanswered(message) {
  return Object.assign(new Error(message), { outcomeUnknown: true });
}

/**
 * unanswered, because of the tab: its script failed (`tabFailed: "script"`: closed, reloaded,
 * gone elsewhere) or its fetch failed without a timeout (`"fetch"`: e.g. a page that isn't Teams
 * any more). The call's next request looks the tabs up again.
 */
function tabFailed(kind, message, ctx) {
  if (ctx) ctx.tabs = null;
  return Object.assign(unanswered(message), { tabFailed: kind });
}

/**
 * One fetch in the tab, by REQUEST_TIMEOUT_MS or the request's deadline (ctx), whichever
 * comes first. Nothing starts once the request was withdrawn, and a tab that doesn't run
 * the script in time (frozen, discarded) fails the call instead of holding it.
 */
async function runInTab(tab, url, method, headers, body, ctx = null) {
  ctx?.check();
  const start = Date.now();
  const deadline = Math.min(start + REQUEST_TIMEOUT_MS, ctx?.deadline ?? Infinity);
  const seconds = secondsOf(deadline - start);
  let timer;
  const scriptTimeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(unanswered(`The Teams tab did not run the request within ${seconds} s (it may be frozen or asleep). Reload the Teams tab and try again.`)),
      deadline - start + SCRIPT_MARGIN_MS,
    );
  });
  const run = chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: pageFetch,
      // executeScript can't pass undefined.
      args: [url, method, headers, body ?? null, deadline],
    })
    // E.g. the tab closed or reloaded while the request ran: it may have reached Teams.
    .catch((err) => {
      throw tabFailed("script", String(err?.message ?? err), ctx);
    });
  let injection;
  try {
    [injection] = await guarded(Promise.race([run, scriptTimeout]), ctx);
  } finally {
    clearTimeout(timer);
  }
  const res = injection?.result;
  if (!res) throw tabFailed("script", "Could not run inside the Teams tab. Reload the Teams tab and try again.", ctx);
  if (res.status === 0) {
    ctx?.check(); // the deadline passed: say that rather than "Teams did not answer"
    // A fetch that failed may have been sent already (a reset connection, no answer in time).
    if (res.error === "timeout") throw unanswered(`Teams did not answer within ${seconds} s. Reload the Teams tab and try again.`);
    throw tabFailed("fetch", `Could not reach Teams: ${res.error}`, ctx);
  }
  return res;
}

// ------------------------------------------------------------ throttling

/**
 * Gate key -> when it may be sent to again (ms since 1970), after a 429. A gate is per service
 * and where it lives: its captured base for Teams' services (another region or account gets its
 * own), the origin (one tenant's OneDrive) for SharePoint.
 */
const gates = new Map();
const gateKey = (service, where) => `${service} ${where}`;

/** How long the gate `key` is still shut, in ms (0: open). */
function gatedFor(key) {
  const ms = (gates.get(key) ?? 0) - Date.now();
  if (ms > 0) return ms;
  gates.delete(key);
  return 0;
}

const busySeconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

/** The error for a call Teams throttles until `until` (ms since 1970). */
function busy(until) {
  return Object.assign(new Error(`Teams is busy (throttled) for ${busySeconds(until - Date.now())} s; try again after that.`), { throttled: true, until });
}

// A wait that would end this close to the request's deadline leaves no time for the request itself.
const GATE_MARGIN_MS = 250;

/**
 * Before anything goes to a throttled service: waits until Teams' Retry-After is over when
 * `wait` and that fits before the request's deadline, else fails at once as busy. A request
 * that holds one of the hub's turns gives it back while it waits, and goes on once it has one
 * again (35), so calls to services that aren't throttled run meanwhile. Resolves with whether
 * it waited (for the gate or for a turn back).
 */
async function passGate(key, ctx, wait) {
  let gaveBack = false;
  let waited = false;
  try {
    for (let ms = gatedFor(key); ms > 0; ms = gatedFor(key)) {
      const deadline = Math.min(ctx?.deadline ?? Infinity, Date.now() + REQUEST_TIMEOUT_MS);
      if (!wait || Date.now() + ms + GATE_MARGIN_MS > deadline) throw busy(Date.now() + ms);
      if (ctx?.turn && !gaveBack) gaveBack = (ctx.turn.giveBack(), true);
      waited = true;
      await guarded(sleep(ms), ctx);
    }
  } finally {
    // Also before a busy error: the handler may go on without this service.
    if (gaveBack && !ctx.cancelled) await guarded(ctx.turn.takeAgain(), ctx);
  }
  ctx?.check();
  // The gate may have shut again while it waited for its turn back.
  if (gaveBack && gatedFor(key) > 0) await passGate(key, ctx, wait);
  return waited;
}

const originOf = (tab) => (tab?.url ? new URL(tab.url).origin : null);

/**
 * runInTab in `tab` through the gate `key`. A 429 closes the gate for its Retry-After. Teams
 * refused that request without running it, so a read (a GET, or a POST that only reads:
 * `repeatable`) goes once more after the wait (when `wait` and it fits the deadline). Anything
 * else, such as a post, is never sent again: the caller hears that Teams is busy.
 *
 * A tab that failed under a read (see tabFailed: closed or reloaded since the call looked it up,
 * or gone to another page) is looked up again with `findTab`, and the read goes once more there,
 * by the same deadline. A fetch that failed in the same tab, still on the same page (e.g.
 * offline), isn't sent again. A post never is: it may have reached Teams.
 *
 * `oid`: whose headers they are. Before they go after a wait (for the gate, also on the first
 * attempt, since another request's 429 may have shut it) or again (in the other tab), that user
 * must still be the signed-in one; otherwise the call fails as account changed (#77) and the
 * previous user's headers are never sent (again).
 */
async function sendTo(key, tab, findTab, url, method, headers, body, ctx, wait, repeatable = method === "GET", oid = null) {
  let foundAgain = false;
  for (let attempt = 0, repeat = false; ; repeat = true) {
    const waited = await passGate(key, ctx, wait);
    if ((waited || repeat) && oid && (await signedInOid()) !== oid) {
      const what = waited || !foundAgain ? "a request waited to be sent" : "a request was about to be retried after its Teams tab closed or reloaded";
      throw new Error(ACCOUNT_CHANGED_WHILE(what, "sends it as that account"));
    }
    let res;
    try {
      res = await runInTab(tab, url, method, headers, body, ctx);
    } catch (err) {
      if (!err?.tabFailed || !repeatable || foundAgain) throw err;
      foundAgain = true;
      const found = await guarded(findTab(), ctx);
      if (err.tabFailed === "fetch" && found.id === tab.id && originOf(found) === originOf(tab)) throw err;
      if (found.status === "loading") await guarded(waitForTabLoaded(found.id), ctx);
      tab = found;
      continue;
    }
    if (res.status !== 429) return res;
    const until = Math.max(gates.get(key) ?? 0, Date.now() + teams.retryAfterMs(res.retryAfter));
    gates.set(key, until);
    if (!repeatable || attempt++ > 0) throw busy(until);
  }
}

/**
 * One request to a Teams service. `path` is relative to the service's base URL (or a
 * full URL on it). Returns the parsed JSON (null for an empty answer). While Teams throttles
 * the service, the call waits that out if it fits the deadline; `wait: false` (for lookups
 * that can be done without) fails at once as busy instead. `repeatable`: a POST that only
 * reads (a search, a profile lookup), sent again after a 429 like a GET. `unreadable`: what a
 * 2xx answer that isn't JSON returns instead of failing; for a post that went through whatever
 * its answer says (a message), where an error would invite posting it again.
 */
async function api(service, path, { method = "GET", body, raw = false, withLocation = false, ctx = null, wait = true, repeatable = method === "GET", onCapture, unreadable } = {}) {
  ctx?.check();
  let cap = await getCapture(service);
  // Opening a tab or waiting for a session can take a minute; a withdrawn request stops waiting.
  let tab = await guarded(findTeamsTab(cap ? new URL(cap.base).origin : null, ctx), ctx);
  if (!cap) {
    cap = await refreshSession(service, tab, { quickWaitMs: service === "substrate" ? 2_000 : 4_000 }, ctx);
    if (!cap) throw new Error(SERVICE_HELP[service]);
  }
  const urlFor = (c) => teams.serviceUrl(path, c.base);
  const findTab = () => findTeamsTab(new URL(cap.base).origin, ctx);
  await onCapture?.(cap); // may refuse the session (it throws), before anything is sent
  let res = await sendTo(gateKey(service, cap.base), tab, findTab, urlFor(cap), method, cap.headers, body, ctx, wait, repeatable, cap.oid);
  if (res.status === 401) {
    // Rejected before running (expired token), so trying once more is safe. A 403 is a
    // real answer (e.g. no longer a member of that chat).
    // The session (maybe the account) is changing: lists read with it are read again. What
    // only one user may see goes when a capture shows another user (forgetAccount).
    dropSessionLists();
    cap = await refreshSession(service, tab, { quickWaitMs: 0, rejected: cap.headers }, ctx);
    if (!cap) throw new Error(SERVICE_HELP[service]);
    // The tab may have been closed meanwhile: look the tabs up again.
    if (ctx) ctx.tabs = null;
    tab = await guarded(findTab(), ctx);
    await onCapture?.(cap);
    res = await sendTo(gateKey(service, cap.base), tab, findTab, urlFor(cap), method, cap.headers, body, ctx, wait, repeatable, cap.oid);
  }
  if (raw) return res;
  if (res.status >= 400) {
    const start = res.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`Teams HTTP ${res.status} (${service})${start ? `: ${start}` : ""}`);
  }
  if (withLocation) {
    let json = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      // The location is what matters here.
    }
    return { json, location: res.location ?? null };
  }
  if (!res.text) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    if (unreadable !== undefined) return unreadable;
    throw new Error(`Teams returned something that isn't JSON (${service}, HTTP ${res.status}).`);
  }
}

// ------------------------------------------------------------ data

/** The signed-in user's MRI ("8:orgid:<guid>"), from the people service's request paths. */
async function myMri() {
  const { oid } = await chrome.storage.session.get("oid");
  return oid ? `8:orgid:${oid}` : null;
}

/**
 * Whose data a capture reads: "<base>\n<oid>", the service's base (origin and region) and the
 * user its token was issued to. An object id is one tenant's, so two tenants (or accounts) in
 * the same region still get different keys. null without a capture.
 */
const accountKey = (cap) => (cap ? `${cap.base}\n${cap.oid ?? ""}` : null);

let accountSwitches = 0; // bumped by forgetAccount: a send sees that a switch landed while it looked things up

/**
 * The user switched Teams to another account or tenant: forget what the previous one saw.
 * (Throttle gates stay: they are Teams' limits per service and base, not anyone's data.)
 */
function forgetAccount() {
  accountSwitches++;
  dropSessionLists();
  names.clear();
  transcripts.clear();
  myAddressCache = null;
}

/**
 * Empties the lists read with a session (the chat list, the meetings' calls), so they are read
 * again: after a 401 (the token, maybe the account, is changing) and on a switch (forgetAccount).
 */
function dropSessionLists() {
  dropList();
  meetingSessionsCache.clear();
}

/** A read that a switch of the signed-in Teams account overtook: what it read, and what a retry reads. */
const ACCOUNT_CHANGED_WHILE = (what, retry) => `The signed-in Teams account changed while ${what}; it's now signed in as another account, so a retry ${retry}.`;

const LIST_CACHE_MS = 60_000;
let listCache = null; // { key: accountKey of csa, until, data: { teams, chats, meetings, namesMissing } }
let listGeneration = 0; // bumped by dropList: a read that started before a drop doesn't store its (older) list

/** Empties the list cache, also for a read under way: it can't put the list from before this back. */
function dropList() {
  listCache = null;
  listGeneration++;
}

/**
 * Teams, channels and chats (csa), with names for untitled chats. Cached for a minute for the
 * account it was read as (a 401 empties it), but
 * when names are missing (`namesMissing`: { chats, organizers }, see lookupNames) only until
 * Teams' throttle is over, or not at all after another failure, so they are looked up again.
 * A meeting whose organizer's name is missing that way has `organizerNameMissing`.
 */
async function teamsAndChats(fresh = false, ctx = null) {
  if (!fresh && listCache && Date.now() < listCache.until && listCache.key === accountKey(await getCapture("csa"))) return listCache.data;
  let readAs = null; // the session the list was read with
  const generation = listGeneration;
  const json = await api("csa", "/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true&enableRC2Fetch=false", { ctx, onCapture: (c) => (readAs = c) });
  const data = { teams: teams.parseTeams(json), chats: teams.parseCsaChats(json), meetings: teams.parseCsaMeetings(json) };
  const chats = await nameChats(data.chats, ctx);
  const organizers = await lookupNames(data.meetings.map((m) => m.organizer), ctx);
  for (const m of data.meetings) {
    m.organizerName = names.get(m.organizer) ?? null;
    if (!m.organizerName && organizers?.mris.has(m.organizer)) m.organizerNameMissing = organizers;
  }
  data.namesMissing = { chats, organizers };
  const missing = [chats, organizers].filter(Boolean);
  const until = missing.some((x) => !x.throttled) ? 0 : missing.length ? Math.max(...missing.map((x) => x.until)) : Date.now() + LIST_CACHE_MS;
  // Filed under the account it was read as. A switch while it was read leaves nothing of the
  // old account for the new one: not cached, and not used (its chats aren't the new account's).
  const key = accountKey(readAs);
  if (key !== accountKey(await getCapture("csa"))) throw new Error(ACCOUNT_CHANGED_WHILE("the chat list was read", "reads that account's chats"));
  if (generation === listGeneration) listCache = { key, until, data };
  return data;
}

/**
 * list_teams' note for an empty list: the signed-in account (from its token: name, sign-in
 * address, tenant id; a token has no tenant name) is in no teams. Never the token itself.
 */
function noTeamsNote(account, mri) {
  const who = [account?.name, account?.address && (account.name ? `(${account.address})` : account.address)].filter(Boolean).join(" ") || mri || "the signed-in account";
  const tenant = account?.tenantId ? `, in tenant ${account.tenantId},` : "";
  return `Teams is signed in as ${who}${tenant} and this account is in no teams. If you expected teams, they may be under another account or tenant: switch accounts or organizations in the Teams tab, then list again with refresh.`;
}

/** A result's note when names are missing (`missing`, see lookupNames): throttled, or why. */
function namesNote(what, missing) {
  if (!missing.throttled) return `${what} missing: some people couldn't be looked up, so they are shown without their names. Try again. The lookup failed with: ${missing.error}`;
  const wait = missing.until - Date.now();
  return `${what} missing (throttled): Teams asked to slow down, so some people couldn't be looked up and are shown without their names.${wait > 0 ? ` Try again in ${busySeconds(wait)} s.` : " Try again."}`;
}

const names = new Map(); // mri -> display name; bounded, starts over when full
const NAMES_MAX = 5000;

/**
 * Looks up display names for MRIs not seen yet (mt short profiles, 100 at a time). Returns
 * null when it could ask for all of them, else why some were left out (the caller says so):
 * { throttled: true, until } while Teams throttles mt, or { error } for another failure, with
 * `mris`: those it couldn't ask for (the failed batches, and the ones a throttle left out).
 * Names are a nicety, so it doesn't wait out a throttle unless `wait`.
 */
async function lookupNames(mris, ctx = null, { wait = false } = {}) {
  const unknown = [...new Set(mris)].filter((m) => m && !names.has(m) && /^8:/.test(m));
  let missing = null;
  const notAsked = new Set();
  for (let i = 0; i < unknown.length; i += 100) {
    if (missing?.throttled) {
      for (const m of unknown.slice(i)) notAsked.add(m);
      break;
    }
    // Names that can't be looked up are left out, but a withdrawn request ends here (and isn't cached).
    ctx?.check();
    const batch = unknown.slice(i, i + 100);
    let readAs = null; // the session the names were looked up with
    const json = await api("mt", "/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true", {
      method: "POST",
      body: batch,
      ctx,
      wait,
      repeatable: true,
      onCapture: (c) => (readAs = c),
    }).catch((err) => {
      ctx?.check(); // a withdrawn request ends here (and isn't cached)
      missing = err?.throttled ? { throttled: true, until: err.until } : (missing ?? { error: err?.message ?? String(err) });
      for (const m of batch) notAsked.add(m);
      return null;
    });
    // Names looked up as an account that is no longer signed in aren't kept.
    if (json && accountKey(readAs) !== accountKey(await getCapture("mt"))) {
      missing ??= { error: ACCOUNT_CHANGED_WHILE("names were looked up", "looks them up as that account") };
      for (const m of batch) notAsked.add(m);
      continue;
    }
    if (names.size > NAMES_MAX) names.clear();
    for (const p of teams.parseProfiles(json)) if (p.mri && p.name) names.set(p.mri, p.name);
  }
  ctx?.check();
  return missing && { ...missing, mris: notAsked };
}

/** Names untitled chats by their members; returns why names are missing, if they are (see lookupNames). */
async function nameChats(chats, ctx = null) {
  const me = await myMri();
  const missing = await lookupNames(chats.filter((c) => !c.title).flatMap((c) => c.members), ctx);
  for (const c of chats) {
    c.memberNames = c.members.filter((m) => m !== me).map((m) => names.get(m)).filter(Boolean);
    c.title = teams.chatTitle(c, names, me);
  }
  return missing;
}

async function resolve(conversation, ctx = null) {
  const q = String(conversation ?? "").trim();
  if (!q) throw new Error("Say which chat or channel: an id, 'Team/Channel', a chat title or a person's name.");
  if (/^(19|48):/.test(q)) {
    const data = await teamsAndChats(false, ctx).catch(() => ({ teams: [], chats: [] }));
    ctx?.check();
    return describe(q.split(";messageid=")[0], data);
  }
  const data = await teamsAndChats(false, ctx);
  try {
    return teams.resolveConversation(q, data);
  } catch (err) {
    // Untitled chats are found by their members' names: without them a match can be missed.
    if (data.namesMissing?.chats) err.message += `\n${namesNote("Chat names", data.namesMissing.chats)}`;
    throw err;
  }
}

/** What we know about a conversation id from the lists. */
function describe(id, { teams: ts, chats }) {
  if (id === "48:notes") return { id, kind: "self", title: "Notes to self" };
  for (const t of ts) {
    const c = t.channels.find((x) => x.id === id);
    if (c) return { id, kind: "channel", title: `${t.name}/${c.name}`, team: t.name, channel: c.name, teamId: t.id };
  }
  const chat = chats.find((c) => c.id === id);
  if (chat) return { id, kind: chat.kind, title: chat.title };
  return { id, kind: /@thread\.(tacv2|skype)$/.test(id) ? "channel" : null, title: null };
}

/** People search as in Teams' people picker (substrate suggestions). */
async function searchPeople(query, limit, ctx = null) {
  const body = {
    EntityRequests: [{ Query: { QueryString: query, DisplayQueryString: query }, EntityType: "People", Size: limit, Fields: ["Id", "MRI", "DisplayName", "EmailAddresses", "PeopleType", "PeopleSubtype", "UserPrincipalName", "GivenName", "Surname", "JobTitle", "Department", "CompanyName", "OfficeLocation", "ExternalDirectoryObjectId"] }],
    cvid: crypto.randomUUID(),
    logicalId: crypto.randomUUID(),
    AppName: "Microsoft Teams",
    Scenario: { Name: "peoplepicker.newChat" },
  };
  return teams.parseSuggestions(await api("substrate", "/search/api/v1/suggestions?scenario=peoplepicker.newChat", { method: "POST", body, ctx, repeatable: true }));
}

/** Each name or address as the one person it means (see teams.pickPerson). */
async function resolvePeople(queries, me, ctx = null) {
  const people = [];
  for (const q of queries) {
    const query = String(q).trim();
    if (/^8:orgid:/i.test(query)) {
      // The window must show who it is: wait out a throttle if the deadline allows, else fail as busy.
      const missing = await lookupNames([query], ctx, { wait: true });
      if (missing?.throttled) throw busy(missing.until);
      people.push({ mri: query, name: names.get(query) ?? query, email: null });
      continue;
    }
    let found = await searchPeople(query, 10, ctx);
    // People search can miss a full name it would find by one of its words (seen with
    // "KIM MIN JUN" for "김민준(KIM MIN JUN)"): then search each word, keeping exact names.
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    if (!found.length && words.length > 1) {
      for (const w of words) {
        found = (await searchPeople(w, 25, ctx)).filter((p) => teams.sameName(p.name, query));
        if (found.length) break;
      }
    }
    people.push(teams.pickPerson(query, found, me));
  }
  const unique = people.filter((p, i) => people.findIndex((x) => x.mri === p.mri) === i);
  if (unique.some((p) => p.mri === me)) throw new Error("You don't need to add yourself; you are always in the chat.");
  return unique;
}

// ------------------------------------------------------------ SharePoint (meeting recordings and transcripts)

const SHAREPOINT_URL = /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i;
const spTabs = new Map(); // origin -> id of the tab this extension opened there
const spOpening = new Map(); // origin -> Promise of that tab, so parallel calls open one

/**
 * A tab on a SharePoint origin, for requests with its cookies: transcripts live in the
 * organizer's OneDrive, which doesn't answer the Teams page across origins. Opens the
 * origin in a pinned background tab when none is open.
 */
async function sharepointTab(origin, ctx = null) {
  const open = (await openTabs(ctx)).filter((t) => !t.discarded && t.url?.startsWith(`${origin}/`));
  const ready = open.find((t) => t.status === "complete") ?? open[0];
  if (ready) return ready;
  if (!spOpening.has(origin)) {
    const p = (async () => {
      let tab = spTabs.has(origin) ? await chrome.tabs.get(spTabs.get(origin)).catch(() => null) : null;
      if (!tab) {
        const url = `${origin}/`;
        tab = await chrome.tabs
          .create({ url, active: false, pinned: true })
          .catch(async () => (await chrome.windows.create({ url, focused: false })).tabs[0]);
        spTabs.set(origin, tab.id);
      }
      // Single sign-on goes through login.microsoftonline.com and comes back.
      const t = await waitForTab(tab.id, (x) => x.status === "complete" && !!x.url?.startsWith(`${origin}/`), OPEN_TAB_WAIT_MS);
      if (t === null) throw new Error("The SharePoint tab that was opened was closed. Try again.");
      if (!t) throw new Error(`OneDrive (${origin}) was opened in a background tab but isn't signed in yet. Sign in there, then try again.`);
      return t;
    })().finally(() => spOpening.delete(origin));
    spOpening.set(origin, p);
  }
  return knownTab(ctx, await spOpening.get(origin));
}

/** A GET on SharePoint with the browser's own SharePoint session. */
async function sharepointGet(url, ctx = null) {
  if (!SHAREPOINT_URL.test(url)) throw new Error("Not a SharePoint URL");
  ctx?.check();
  const origin = new URL(url).origin;
  const findTab = () => sharepointTab(origin, ctx);
  return sendTo(gateKey("sharepoint", origin), await guarded(findTab(), ctx), findTab, url, "GET", {}, null, ctx, true);
}

// "<accountKey of chatsvc>\n<transcript URL>" -> parsed transcript; a finished transcript doesn't
// change, but what one user may read isn't another's. Bounded by size: each counts the length
// of the response text it was parsed from, least recently used out first, and one longer than
// the cap isn't kept at all.
const TRANSCRIPTS_MAX_BYTES = 8 * 1024 * 1024;
const transcripts = new teams.ByteCache(TRANSCRIPTS_MAX_BYTES);

/** A call's transcript (Stream transcript.json) from the organizer's OneDrive. */
async function transcriptOf(info, session, ctx = null) {
  const key = `${accountKey(await getCapture("chatsvc")) ?? ""}\n${session.transcriptUrl}`;
  const cached = transcripts.get(key);
  if (cached) return cached;
  const url = session.transcriptUrl + (session.transcriptUrl.includes("?") ? "&" : "?") + "format=json";
  const res = await sharepointGet(url, ctx);
  if (res.status === 403 || res.status === 404) {
    throw new Error(`The transcript of "${info.title}" (${session.start}) is no longer available to you (HTTP ${res.status}): the organizer may have deleted it or not shared it.`);
  }
  if (res.status >= 400) throw new Error(`OneDrive HTTP ${res.status} while reading the transcript.`);
  const json = JSON.parse(res.text);
  // Not kept for an account that signed in while it was read.
  if (key !== `${accountKey(await getCapture("chatsvc")) ?? ""}\n${session.transcriptUrl}`) return json;
  transcripts.set(key, json, res.text.length);
  return json;
}

/** A meeting chat by id, title or subject. */
async function resolveMeeting(meeting, ctx = null) {
  const conv = await resolve(meeting, ctx);
  const info = (await teamsAndChats(false, ctx)).meetings.find((m) => m.id === conv.id);
  if (!info) throw new Error(`"${conv.title ?? conv.id}" is not a meeting chat. list_meetings lists them.`);
  return info;
}

const SESSIONS_CACHE_MS = 60_000;
const SESSIONS_CACHE_MAX = 50;
/** "<accountKey of chatsvc>\n<meeting id>" -> { at, sessions }: one tenant's meetings never answer another's. */
const meetingSessionsCache = new Map();
const sessionsKey = (cap, id) => (cap ? `${accountKey(cap)}\n${id}` : null);

/**
 * The calls held in a meeting chat (see teams.meetingSessions). Cached for a minute, so
 * read_transcript's continueFrom pages and get_meeting don't read the whole chat again.
 */
async function sessionsOf(info, ctx = null) {
  const key = sessionsKey(await getCapture("chatsvc"), info.id);
  const hit = key && meetingSessionsCache.get(key);
  if (hit && Date.now() - hit.at < SESSIONS_CACHE_MS) return hit.sessions;
  const sessions = await readSessions(info, ctx);
  // Kept only when the chat was read as the account it is filed under: a session that changed
  // meanwhile (a switch, or a 401 that brought another base) may have read part of it.
  if (key && key === sessionsKey(await getCapture("chatsvc"), info.id)) {
    meetingSessionsCache.delete(key);
    if (meetingSessionsCache.size >= SESSIONS_CACHE_MAX) meetingSessionsCache.delete(meetingSessionsCache.keys().next().value);
    meetingSessionsCache.set(key, { at: Date.now(), sessions });
  }
  return sessions;
}

async function readSessions(info, ctx = null) {
  let raw;
  try {
    raw = await fetchMessages(info.id, { limit: 2000, includeSystem: true, ctx });
  } catch (err) {
    if (/HTTP 403/.test(err.message) && info.external) {
      throw new Error(`"${info.title}" was organized by another organization, and Teams no longer lets you read its meeting chat.`);
    }
    throw err;
  }
  return teams.meetingSessions(raw);
}

const MESSAGES_VIEW = "msnp24Equivalent|supportsMessageProperties";

/**
 * Messages of a conversation, newest first, until `limit` messages (after dropping system
 * events when not wanted) or `before` is reached. Follows chatsvc's backward links.
 */
async function fetchMessages(id, opts) {
  return (await fetchMessagePages(id, opts)).raw;
}

const MAX_PAGES = 20;
const MESSAGES_ACCOUNT_CHANGED = ACCOUNT_CHANGED_WHILE("messages were read", "reads them as that account");

/** The conversation id chatsvc pages: the conversation, or one channel post's thread. */
const messagesTarget = (id, threadId) => (threadId ? `${id};messageid=${threadId}` : id);

/**
 * fetchMessages with where each message came from: `linkOf` (message id → the link of its
 * page), `first` (the first page's link), `next` (the backward link not followed yet, if
 * any) and `capped` (stopped after MAX_PAGES pages short of `limit`). Starts at the newest
 * page, or at `from` (a link from a cursor, see teams.readMessagesCursor), and takes only
 * messages older than `olderThan` ({ time, id }, see teams.compareMessageKeys) if given.
 */
async function fetchMessagePages(id, { limit, olderThan, includeSystem, threadId, from, ctx = null }) {
  const target = messagesTarget(id, threadId);
  const first = from ?? `/v1/users/ME/conversations/${encodeURIComponent(target)}/messages?view=${encodeURIComponent(MESSAGES_VIEW)}&pageSize=${Math.min(200, Math.max(20, limit * 2))}&startTime=1`;
  let path = first;
  const raw = [];
  const linkOf = new Map();
  let counted = 0;
  let pages = 0;
  // Every page is read as one account: the user of the first page's session (its oid; a 401
  // can bring the same user a session on another base), with no switch landing meanwhile.
  const switches = accountSwitches;
  let readAs; // the oid the pages are read as, from the first session used
  const sameAccount = (cap) => {
    if (readAs === undefined) readAs = cap.oid ?? null;
    if ((cap.oid ?? null) !== readAs) throw new Error(MESSAGES_ACCOUNT_CHANGED);
  };
  while (path) {
    if (pages === MAX_PAGES) return { raw, linkOf, first, next: path, capped: true, pages };
    const json = await api("chatsvc", path, { ctx, onCapture: sameAccount });
    if (switches !== accountSwitches) throw new Error(MESSAGES_ACCOUNT_CHANGED);
    pages++;
    const msgs = json?.messages ?? [];
    for (const m of msgs) {
      if (olderThan && teams.compareMessageKeys(teams.messageKey(m), olderThan) >= 0) continue;
      raw.push(m);
      linkOf.set(String(m.id ?? m.clientmessageid ?? ""), path);
      if (includeSystem || !/^(ThreadActivity\/|Event\/|Control\/)/i.test(m.messagetype ?? "")) counted++;
    }
    const next = msgs.length ? (json?._metadata?.backwardLink ?? null) : null;
    if (counted >= limit) return { raw, linkOf, first, next, capped: false, pages };
    path = next;
  }
  return { raw, linkOf, first, next: null, capped: false, pages };
}

export const handlers = {
  async status() {
    const tabs = await userTeamsTabs(await chrome.tabs.query({ url: TEAMS_URLS }));
    const sessions = {};
    for (const s of ["chatsvc", "csa", "mt", "substrate"]) {
      const cap = await getCapture(s);
      sessions[s] = cap ? new Date(cap.at).toISOString() : null;
    }
    return {
      extensionVersion: VERSION,
      teamsTabs: tabs.length,
      // For the bridge's choice between browsers.
      sessions: [{ sessionCaptured: !!sessions.chatsvc }],
      services: sessions,
      region: (await getCapture("chatsvc"))?.region ?? null,
      signedInAs: await myMri(),
      ...(await teamsCalls().then((c) => ({ lastTeamsCall: callAt(c?.lastTeamsCall), lastSignedInCall: callAt(c?.lastSignedInCall) }))),
      droppedOldCaptures: await droppedOldCaptures(),
      accountUnsure: await accountUnsureStatus(),
    };
  },

  // The three lists share teamsAndChats' one-minute cache; `refresh` reads it again first.
  // `openTab`: setup, which opens Teams for a new user and waits for the sign-in.
  async listTeams({ refresh = false, openTab = false } = {}, ctx) {
    if (!openTab) await requireTeamsTab(ctx);
    const list = (await teamsAndChats(refresh === true, ctx)).teams;
    // An empty list is easily taken for a failure: say whose it is (the list is the csa session's account's).
    if (list.length) return { teams: list };
    return { teams: list, note: noTeamsNote(teams.tokenAccount((await getCapture("csa"))?.headers), await myMri()) };
  },

  async listChats({ query, limit = 30, unreadOnly = false, refresh = false }, ctx) {
    await requireTeamsTab(ctx);
    const data = await teamsAndChats(refresh === true, ctx);
    let chats = data.chats;
    if (unreadOnly) chats = chats.filter((c) => c.unread);
    if (query) chats = chats.filter((c) => teams.matchesWords(c.title, query) || c.memberNames?.some((n) => teams.matchesWords(n, query)));
    chats.sort((a, b) => (b.lastMessage?.time ?? "").localeCompare(a.lastMessage?.time ?? ""));
    return {
      total: chats.length,
      chats: chats.slice(0, limit).map(({ members, memberNames, lastFrom, ...c }) => ({ ...c, memberCount: members.length || undefined })),
      ...(data.namesMissing.chats ? { note: namesNote("Chat names", data.namesMissing.chats) } : {}),
    };
  },

  async readMessages({ conversation, limit = 30, before, cursor, includeSystem = false, threadId, maxLength }, ctx) {
    if (cursor && before) throw new Error("Give either cursor or before, not both (cursor already knows where to go on).");
    const conv = await resolve(conversation, ctx);
    // A cursor resumes at the page that held the oldest message returned last time, and
    // only takes what is older than that message (by time, then id).
    const from = cursor ? teams.readMessagesCursor(cursor, messagesTarget(conv.id, threadId)) : null;
    if (from) before = from.before ?? undefined;
    const mark = from ? { time: from.before, id: from.id } : { time: before ?? null, id: null };
    const olderThan = mark.time != null || mark.id != null ? mark : null;
    const { raw, linkOf, first, next, capped, pages } = await fetchMessagePages(conv.id, { limit, olderThan, includeSystem, threadId, from: from?.path, ctx });
    const { messages, more, oldest } = teams.newestEntries(raw, { limit, includeSystem, channel: conv.kind === "channel" && !threadId });
    let olderCursor = null;
    if (oldest && (more || next)) olderCursor = teams.messagesCursor(linkOf.get(oldest.id) ?? first, oldest.time, oldest.id);
    else if (!oldest && next) olderCursor = teams.messagesCursor(next, olderThan?.time ?? null, olderThan?.id ?? null);
    return {
      conversation: conv,
      count: messages.length,
      // Cut here, so long texts don't cross the bridge only to be cut by the server.
      messages: teams.capText(messages, maxLength),
      ...(more || raw.length ? { olderBefore: oldest?.time ?? null } : {}),
      ...(olderCursor ? { olderCursor } : {}),
      ...(capped && messages.length < limit
        ? {
            truncated: true,
            note: `Stopped after reading ${pages} pages (${MAX_PAGES} at most per call)${before ? ` without reaching all messages older than ${before}` : ""}. Older history exists: pass olderCursor as cursor to go on.`,
          }
        : {}),
    };
  },

  async searchMessages({ query, limit = 25, offset = 0 }, ctx) {
    const body = {
      entityRequests: [
        {
          entityType: "Message",
          contentSources: ["Teams"],
          fields: ["Extension_SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId_String", "Extension_SkypeSpaces_ConversationPost_Extension_FileData_String", "Extension_SkypeSpaces_ConversationPost_Extension_ThreadType_String"],
          propertySet: "Optimized",
          query: { queryString: query, displayQueryString: query },
          from: offset,
          size: limit,
          topResultsCount: 0,
        },
      ],
      cvid: crypto.randomUUID(),
      logicalId: crypto.randomUUID(),
      scenario: { Dimensions: [{ DimensionName: "QueryType", DimensionValue: "All" }, { DimensionName: "FormFactor", DimensionValue: "general.web.reactSearch" }], Name: "powerbar" },
    };
    const r = teams.parseSearch(await api("substrate", "/searchservice/api/v2/query", { method: "POST", body, ctx, repeatable: true }));
    return { query, ...r, results: r.results.slice(0, limit) };
  },

  async findPeople({ query, limit = 10 }, ctx) {
    const people = await searchPeople(query, limit, ctx);
    return { count: people.length, people };
  },

  async listMeetings({ query, limit = 20, transcriptOnly = false, refresh = false }, ctx) {
    const data = await teamsAndChats(refresh === true, ctx);
    let meetings = data.meetings;
    if (query) meetings = meetings.filter((m) => teams.matchesWords(m.title, query) || teams.matchesWords(m.organizerName, query));
    if (transcriptOnly) meetings = meetings.filter((m) => m.hasTranscript);
    meetings = [...meetings].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
    return {
      total: meetings.length,
      meetings: meetings.slice(0, limit).map(({ organizer, organizerName, organizerNameMissing, joinUrl, lastJoinAt, ...m }) => ({ ...m, organizer: organizerName ?? organizer })),
      ...(data.namesMissing.organizers ? { note: namesNote("Organizer names", data.namesMissing.organizers) } : {}),
    };
  },

  async getMeeting({ meeting, limit = 10 }, ctx) {
    const info = await resolveMeeting(meeting, ctx);
    const sessions = await sessionsOf(info, ctx);
    const { organizer, organizerName, organizerNameMissing, lastJoinAt, ...rest } = info;
    return {
      meeting: { ...rest, organizer: organizerName ?? organizer },
      sessionCount: sessions.length,
      sessions: sessions.slice(-limit).reverse().map(({ transcriptUrl, ...s }) => s),
      // Only when its own lookup failed; the list it came from isn't kept long then (teamsAndChats).
      ...(organizerNameMissing ? { note: namesNote("Organizer name", organizerNameMissing) } : {}),
    };
  },

  async readTranscript({ meeting, session, from, maxLength = 40_000 }, ctx) {
    const info = await resolveMeeting(meeting, ctx);
    const all = await sessionsOf(info, ctx);
    const withTranscript = all.filter((s) => s.transcriptUrl);
    if (!withTranscript.length) {
      throw new Error(`"${info.title}" has no transcript${all.length ? ` in its ${all.length} recorded call(s)` : ""}. Teams keeps one only when transcription was turned on in the meeting.`);
    }
    let s = withTranscript.at(-1);
    if (session) {
      const key = String(session).trim();
      const matches = withTranscript.filter((x) => x.callId === key || (x.start ?? "").startsWith(key));
      if (!matches.length) {
        throw new Error(`No transcript for "${key}". Calls with a transcript: ${withTranscript.map((x) => `${x.start} (${x.callId})`).join(", ")}`);
      }
      s = matches.at(-1);
    }
    const json = await transcriptOf(info, s, ctx);
    const fromSeconds = from ? (String(from).split(":").reduce((a, x) => a * 60 + Number(x), 0) || 0) : 0;
    const lines = teams.transcriptLines(json, { fromSeconds });
    let text = "";
    let shown = 0;
    for (const l of lines) {
      if (text.length + l.length + 1 > maxLength && shown) break;
      text += (shown ? "\n" : "") + l;
      shown++;
    }
    const next = lines[shown]?.match(/^\[([\d:]+)\]/)?.[1] ?? null;
    return {
      meeting: info.title,
      session: { callId: s.callId, start: s.start, end: s.end, minutes: s.minutes },
      speakers: teams.transcriptSpeakers(json),
      language: json.entries?.find((e) => e.spokenLanguageTag)?.spokenLanguageTag ?? null,
      otherSessionsWithTranscript: withTranscript.filter((x) => x !== s).map((x) => x.start),
      ...(next ? { truncated: true, continueFrom: next } : {}),
      transcript: text,
    };
  },

  async searchTranscripts({ query, meeting, limit = 30, meetings: maxMeetings = 10 }, ctx) {
    let list = meeting ? [await resolveMeeting(meeting, ctx)] : (await teamsAndChats(true, ctx)).meetings.filter((m) => m.hasTranscript);
    list = [...list].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "")).slice(0, maxMeetings);
    const results = [];
    const skipped = [];
    let total = 0;
    let shown = 0;
    let searched = 0;
    for (const info of list) {
      if (shown >= limit) break; // enough matches; older meetings aren't read
      ctx?.check(); // withdrawn: no more meetings are read
      searched++;
      let sessions;
      try {
        sessions = (await sessionsOf(info, ctx)).filter((s) => s.transcriptUrl);
      } catch (err) {
        ctx?.check();
        skipped.push({ meeting: info.title, reason: err.message });
        continue;
      }
      for (const s of sessions.reverse()) {
        let json;
        try {
          json = await transcriptOf(info, s, ctx);
        } catch (err) {
          ctx?.check();
          skipped.push({ meeting: info.title, session: s.start, reason: err.message });
          continue;
        }
        const hits = teams.searchTranscript(json, query);
        total += hits.length;
        if (hits.length && shown < limit) {
          const matches = hits.slice(0, limit - shown);
          shown += matches.length;
          results.push({ meeting: info.title, id: info.id, session: s.start, callId: s.callId, matches });
        }
      }
    }
    const notSearched = list.length - searched;
    return {
      query,
      meetingsSearched: searched,
      matches: total,
      results,
      ...(skipped.length ? { skipped } : {}),
      ...(notSearched ? { notSearched, note: `Stopped at limit: ${notSearched} older meetings with a transcript weren't searched. Raise limit to search them.` } : {}),
    };
  },

  /** Read-only diagnostics for development: a GET on a service, never its headers. */
  async probe({ service, path, url }, ctx) {
    if (url) {
      const res = await sharepointGet(url, ctx);
      return { status: res.status, text: res.text.slice(0, 20_000_000) };
    }
    if (!["chatsvc", "csa", "mt", "substrate"].includes(service)) throw new Error("Unknown service");
    const res = await api(service, path, { raw: true, ctx });
    return { status: res.status, text: res.text.slice(0, 20_000_000) };
  },

  async apiTraffic({ filter, limit = 100, clear = false, record }) {
    if (typeof record === "boolean") {
      // In the log's queue, so events already reported are recorded (or not) under the old setting.
      await (trafficQueue = trafficQueue.then(async () => {
        trafficUntil = record ? Date.now() + TRAFFIC_RECORD_MS : 0;
        await chrome.storage.session.set({ [TRAFFIC_UNTIL_KEY]: trafficUntil });
      }).catch(() => {}));
    }
    let list;
    await updateTraffic((l) => {
      list = l;
      return clear && l.length ? [] : l;
    });
    const until = await recordingUntil();
    const recording = Date.now() < until;
    return {
      recording,
      ...(recording ? { recordingUntil: new Date(until).toISOString() } : {}),
      recorded: list.length,
      requests: teams.filterTraffic(list, { filter, limit }),
      ...(recording
        ? {}
        : { note: "Recording is off. Call api_traffic with record: true, use the feature in the Teams tab, then call api_traffic again to list its requests." }),
    };
  },

  /**
   * Reloads the extension from disk (after an update). Refused while a send waits for
   * the user's decision, since reloading would close that window.
   */
  async reload() {
    if (pendingSends.size) throw new Error("A message is waiting for your decision in the confirmation window; reload after that.");
    if (autoSending) throw new Error("A message is being posted; reload after that.");
    setTimeout(() => chrome.runtime.reload(), 250); // after this response is sent
    return { reloading: true, version: VERSION };
  },

  async requestSend({ conversation, to, title, text, threadId, subject, autoSendTo }, ctx) {
    if (!String(text ?? "").trim()) throw new Error("The message is empty.");
    // While it isn't certain which account Teams shows, nothing is sent, nor looked up for a send.
    const unsure = await accountUnsure();
    if (unsure) return { sent: false, reason: UNSURE_SEND(unsure) };
    // Who the window (or an auto-send) is for: taken before anything is looked up for it.
    const switches = accountSwitches;
    const account = await signedInAccount();
    // The server's allowlist (config autoSendTo) only permits; whether this send goes without the
    // window is decided below from the target as resolved here (see sendsToMeAlone, isMeAlone).
    const allow = teams.normalizeAddresses(autoSendTo);
    if (to?.length) {
      if (conversation) throw new Error("Give either a conversation or people (to), not both.");
      if (threadId || subject) throw new Error("reply_to and subject are for channels; a new chat takes people and an optional title.");
      // A cold start: the chat list waits for Teams' session (at most as long as any lookup does),
      // which shows who is signed in. That account, read once, is "me" for the rest, and the send
      // goes only through the window, unless a switch landed meanwhile.
      let who = account;
      if (!who) {
        await teamsAndChats(false, ctx).catch(() => ctx?.check());
        who = await signedInAccount();
        if (switches !== accountSwitches) return { sent: false, reason: ACCOUNT_CHANGED_BEFORE };
        if (!who) throw new Error(NOT_SHOWN);
      }
      const me = `8:orgid:${who}`;
      if (allow.length && !title && (await sendsToMeAlone(to, me, allow, ctx))) {
        if (switches !== accountSwitches) return { sent: false, reason: ACCOUNT_CHANGED_BEFORE };
        const note = { conversation: NOTES_TO_SELF, text: String(text) };
        return account ? sendWithoutConfirming(note, ctx, account) : askUserToConfirm(note, ctx, who);
      }
      const people = await resolvePeople(to, me, ctx);
      if (title && people.length < 2) throw new Error("A title is only for group chats (two or more people besides you).");
      const existing = teams.findExistingChat((await teamsAndChats(true, ctx)).chats, people.map((p) => p.mri), me, title);
      const request = existing
        ? { conversation: { id: existing.id, kind: existing.kind, title: existing.title }, people, text: String(text), existingChat: true }
        : { conversation: null, newChat: { members: people.map((p) => p.mri), title: title ?? null }, people, text: String(text) };
      if (switches !== accountSwitches) return { sent: false, reason: ACCOUNT_CHANGED_BEFORE };
      return askUserToConfirm(request, ctx, who);
    }
    const conv = await resolve(conversation, ctx);
    if (threadId && conv.kind !== "channel") throw new Error("reply_to is only for channel posts; in a chat, just send the message.");
    if (subject && (conv.kind !== "channel" || threadId)) throw new Error("A subject is only for a new channel post.");
    let replyingTo = null;
    if (threadId) {
      const root = (await fetchMessages(conv.id, { limit: 1, threadId, includeSystem: false, ctx })).find((m) => String(m.id) === String(threadId));
      replyingTo = root ? teams.parseMessage(root) : { id: threadId };
    }
    const request = { conversation: conv, text: String(text), threadId: threadId ?? null, subject: subject ?? null, replyingTo };
    // Without an account known from the start, the decision to send goes to the user (the window).
    if (account) {
      const alone = allow.length && !threadId && !subject && (await isMeAlone(conv, `8:orgid:${account}`, allow, ctx));
      // Lookups that spanned a switch (even one back to this account) may have been another account's.
      if (switches !== accountSwitches) return { sent: false, reason: ACCOUNT_CHANGED_BEFORE };
      return alone ? sendWithoutConfirming(request, ctx, account) : askUserToConfirm(request, ctx, account);
    }
    // A cold start: the lookups may have shown who is signed in. The window rests on that account,
    // unless a switch landed since the send began, when they may have been another account's.
    const shown = await signedInAccount();
    if (switches !== accountSwitches) return { sent: false, reason: ACCOUNT_CHANGED_BEFORE };
    if (!shown) throw new Error(NOT_SHOWN);
    return askUserToConfirm(request, ctx, shown);
  },
};

/**
 * Creates a chat with these members and me (called only after the user clicked Send).
 * A 1:1 chat that already exists on Teams' side comes back as that chat.
 */
async function createChat({ members, title }, account) {
  const me = await myMri();
  const oneOnOne = members.length === 1;
  const body = {
    members: [me, ...members].map((id) => ({ id, role: "Admin" })),
    properties: {
      threadType: "chat",
      chatFilesIndexId: "2",
      ...(oneOnOne ? { fixedRoster: "true", uniquerosterthread: "true" } : {}),
      ...(title ? { topic: title } : {}),
    },
  };
  let answer;
  try {
    answer = await api("chatsvc", "/v1/threads", { method: "POST", body, withLocation: true, onCapture: asConfirmed(account) });
  } finally {
    // The chat list changed, or may have: without an answer the chat may exist, and the
    // list_chats the AI is told to check with must not show the list from before it.
    dropList();
  }
  const { json, location } = answer;
  const id = teams.threadIdFrom(location, json) ?? (oneOnOne ? teams.oneOnOneId(me, members[0]) : null);
  if (!id) throw new Error("Teams created no chat (its answer had no chat id).");
  return id;
}

/**
 * An onCapture check for a post confirmed as `account` (an oid; requestSend goes no further
 * without one): fails before anything is sent when the session it would go out with is
 * another account's (Teams switched since the click), or when the account is unsure (#77).
 */
const asConfirmed = (account) => async (cap) => {
  if ((cap.oid ?? (await signedInAccount())) !== account) throw Object.assign(new Error(ACCOUNT_CHANGED), { accountChanged: true });
  const unsure = await accountUnsure();
  if (unsure) throw Object.assign(new Error(UNSURE_SEND(unsure)), { accountUnsure: true });
};

const UNREADABLE = Symbol("unreadable answer");
const TIME_UNCONFIRMED = "Posted: Teams accepted the message, but its answer couldn't be read, so the time isn't confirmed.";

/** Posts a confirmed message; `account`: who confirmed it (see asConfirmed). */
async function sendMessage({ conversation, newChat, people, text, threadId, subject }, account) {
  if (newChat) {
    let id;
    try {
      id = await createChat(newChat, account);
    } catch (err) {
      // Without an answer the chat may exist, but the message was never sent.
      if (err.outcomeUnknown) err.chatMayExist = true;
      throw err;
    }
    const title = newChat.title ?? people.map((p) => p.name).join(", ");
    let r;
    try {
      r = await sendMessage({ conversation: { id, title }, text }, account);
    } catch (err) {
      if (err.accountChanged || err.accountUnsure) err.chatCreated = true;
      throw err;
    }
    return { ...r, newChat: true, conversationId: id };
  }
  const target = threadId ? `${conversation.id};messageid=${threadId}` : conversation.id;
  const me = await myMri();
  if (me) await lookupNames([me]);
  const body = {
    id: "-1",
    type: "Message",
    conversationid: target,
    from: me ?? undefined,
    composetime: new Date().toISOString(),
    originalarrivaltime: new Date().toISOString(),
    content: teams.textToHtml(text),
    messagetype: "RichText/Html",
    contenttype: "Text",
    imdisplayname: (me && names.get(me)) || "",
    clientmessageid: teams.clientMessageId(),
    properties: { importance: "", subject: subject ?? "", title: "", cards: "[]", links: "[]", mentions: "[]", onbehalfof: null, files: "[]", policyViolation: null, formatVariant: "TEAMS" },
    postType: "Standard",
    crossPostChannels: [],
  };
  // Teams took the message (2xx) even when its answer can't be read: reported as sent, so
  // nothing invites posting it again, with its time marked as unconfirmed. The same holds when
  // the answer's time isn't a date.
  const r = await api("chatsvc", `/v1/users/ME/conversations/${encodeURIComponent(target)}/messages`, { method: "POST", body, onCapture: asConfirmed(account), unreadable: UNREADABLE });
  dropList(); // its last message changed: a list_chats right after must not show the old one
  const sent = { sent: true, conversation: conversation.title ?? conversation.id };
  const at = r && r !== UNREADABLE ? r.OriginalArrivalTime : null;
  const time = teams.isoTime(at);
  if (r === UNREADABLE || (at && !time)) return { ...sent, time: null, timeNote: TIME_UNCONFIRMED };
  return { ...sent, time };
}

// ------------------------------------------------------------ auto-send to self (autoSendTo)

/**
 * With autoSendTo in the server's config, a message to the signed-in user alone is posted
 * without the confirmation window. The server only passes the allowlist; the decision is made
 * here, from the target as resolved here: Teams' notes-to-self chat (48:notes), a chat whose
 * only member is me, or `to` naming just me. And one of my own addresses (email or UPN, from
 * my profile) must be on the list. Anything else (a group, meeting or channel, other people, a
 * chat whose members aren't known, a failed lookup) gets the window as usual.
 */
const NOTES_TO_SELF = { id: "48:notes", kind: "self", title: "Notes to self" };
const AUTO_SENT_NOTE = "Sent without confirmation (auto-send to self): it went only to you, and your address is in autoSendTo in the mcp-teams config.";
let myAddressCache = null; // { me, addresses }
let autoSending = 0; // auto-sends being posted (reload waits for them as for a window)

/** The signed-in user's own addresses (email, UPN), from their mt short profile. */
async function myAddresses(me, ctx) {
  if (myAddressCache?.me === me) return myAddressCache.addresses;
  const json = await api("mt", "/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true", {
    method: "POST",
    body: [me],
    ctx,
    repeatable: true,
  });
  const addresses = teams.profileAddresses(json, me);
  if (addresses.length) myAddressCache = { me, addresses };
  return addresses;
}

/** myAddresses, or none when they can't be looked up (then the window shows). */
async function myAddressesOrNone(me, ctx) {
  return myAddresses(me, ctx).catch(() => {
    ctx?.check(); // a withdrawn request ends here
    return [];
  });
}

/**
 * `to` is just me (my MRI, or one of my own addresses), and one of my addresses is allowed.
 * `me`: the MRI of the account the send rests on, read once by requestSend (see isMeAlone).
 */
async function sendsToMeAlone(to, me, allow, ctx) {
  if (to.length !== 1) return false;
  const q = String(to[0]).trim().toLowerCase();
  const isMyMri = q === me.toLowerCase();
  if (!isMyMri && !q.includes("@")) return false; // a name is never auto-sent
  const mine = await myAddressesOrNone(me, ctx);
  if (!isMyMri && !mine.includes(q)) return false;
  return mine.some((a) => allow.includes(a));
}

/**
 * The resolved conversation reaches me alone, and one of my addresses is allowed. `me`: the MRI
 * of the account the send started with, which the judgement is for (never read again here).
 */
async function isMeAlone(conv, me, allow, ctx) {
  let alone = conv.id === NOTES_TO_SELF.id;
  if (!alone && conv.kind !== "channel" && conv.kind !== "meeting") {
    // Members from a fresh list: a chat that has anyone else in it is never auto-sent.
    const data = await teamsAndChats(true, ctx).catch(() => {
      ctx?.check();
      return null;
    });
    const chat = data?.chats.find((c) => c.id === conv.id);
    const members = [...new Set(chat?.members ?? [])];
    alone = !!chat && chat.kind !== "meeting" && chat.kind !== "channel" && members.length === 1 && members[0] === me;
  }
  return alone && (await myAddressesOrNone(me, ctx)).some((a) => allow.includes(a));
}

/**
 * Posts without the window (see above). Once started, the post runs to the end, as after a click.
 * `account`: who it was judged to reach alone; as after a click, it isn't posted as another (3.3).
 */
async function sendWithoutConfirming(request, ctx, account) {
  if (ctx?.cancelled) return WITHDRAWN;
  autoSending++;
  try {
    if ((await signedInAccount()) !== account) return { sent: false, autoSent: true, reason: ACCOUNT_CHANGED };
    const unsure = await accountUnsure();
    if (unsure) return { sent: false, autoSent: true, reason: UNSURE_SEND(unsure) };
    return { ...(await sendMessage(request, account)), autoSent: true, note: AUTO_SENT_NOTE };
  } catch (err) {
    return { sent: false, autoSent: true, reason: sendFailure(err) };
  } finally {
    autoSending--;
  }
}

// ------------------------------------------------------------ send confirmation

/**
 * The AI can only *request* a send. The message is posted only after the user clicks
 * Send in an extension-owned window, showing exactly what will be posted where.
 */
const pendingSends = new Map();

/** How many confirmation windows wait for the user's decision. */
export function pendingSendCount() {
  return pendingSends.size;
}

const ACCOUNT_CHANGED = "The signed-in Teams account changed since this was confirmed; nothing was sent.";
const ACCOUNT_CHANGED_BEFORE = "The signed-in Teams account changed while this send was being prepared; nothing was sent. Check who is signed in, then try again.";
const NOT_SHOWN = "Teams hasn't shown who is signed in yet. Reload the Teams tab and try again.";
const CHAT_CREATED_ACCOUNT_CHANGED =
  "The chat was created, but no message was sent: the signed-in Teams account changed while it was being sent. Check with list_chats (as the account that confirmed it) before trying again.";

/**
 * The signed-in user's object id (one tenant's), or null before Teams has shown it. A send
 * window remembers it: a click after a switch to another account posts nothing.
 */
async function signedInAccount() {
  return (await chrome.storage.session.get("oid")).oid ?? null;
}

const WITHDRAWN = {
  sent: false,
  reason: "The request was withdrawn (cancelled, or the server stopped waiting), so the confirmation window was closed; nothing was sent.",
};

/**
 * Shows the confirmation window and resolves with the outcome. When the request is
 * withdrawn while the window is open (ctx: the server cancelled it, or the connection it
 * came on closed), the window closes and nothing is sent, so a late click can't post after
 * the AI was told the send failed. Once the user clicked Send, the post runs to the end
 * and its outcome is the answer.
 */
async function askUserToConfirm(request, ctx, account) {
  if (ctx?.cancelled) return WITHDRAWN;
  // Unsure since the send began (during its lookups): no window (#77).
  const unsure = await accountUnsure();
  if (unsure) return { sent: false, reason: UNSURE_SEND(unsure) };
  const id = crypto.randomUUID();
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`confirm.html?id=${id}`),
    type: "popup",
    width: 600,
    height: 640,
    focused: true,
  });
  return new Promise((resolve) => {
    let stopWatching = () => {};
    // fromSend: the outcome of the post the user started; anything else is ignored then.
    const finish = (result, fromSend = false) => {
      const p = pendingSends.get(id);
      if (!p || (p.sending && !fromSend)) return;
      pendingSends.delete(id);
      clearTimeout(p.timer);
      stopWatching();
      chrome.windows.remove(p.windowId).catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish({ sent: false, reason: "No decision within 5 minutes; nothing was sent." }), CONFIRM_TIMEOUT_MS);
    pendingSends.set(id, { request, account, windowId: win.id, timer, finish, sending: false });
    // Withdrawn while the window was opening, or later.
    if (ctx?.cancelled) finish(WITHDRAWN);
    else if (ctx) stopWatching = ctx.onCancel(() => finish(WITHDRAWN));
  });
}

/** Why a post failed, as told to the AI. */
function sendFailure(err) {
  // Without an answer the post may have gone through: saying it failed would invite a second one.
  const cause = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  if (err.accountUnsure) return err.chatCreated ? `The chat was created, but no message was sent: ${err.message}` : err.message;
  return err.accountChanged
    ? err.chatCreated
      ? CHAT_CREATED_ACCOUNT_CHANGED
      : ACCOUNT_CHANGED
    : err.chatMayExist
    ? `Creating the chat did not finish: ${cause} The chat may have been created, without the message: check with list_chats before trying again.`
    : err.outcomeUnknown
      ? `Sending did not finish: ${cause} The message may have been posted: check with read_messages before sending again.`
      : `Sending failed: ${err.message}`;
}

function onWindowRemoved(windowId) {
  for (const p of pendingSends.values()) {
    if (p.windowId === windowId) p.finish({ sent: false, reason: "The user closed the confirmation window; nothing was sent." });
  }
}

function onConfirmMessage(msg, sender, sendResponse) {
  // Only our own confirmation page may decide.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("confirm.html"))) return;
  const p = pendingSends.get(msg.id);
  if (msg.type === "confirm:get") {
    sendResponse(p ? { request: p.request } : { error: "This request has expired." });
    return;
  }
  if (msg.type === "confirm:decide" && p) {
    (async () => {
      if (!msg.approve) {
        p.finish({ sent: false, reason: "The user declined; nothing was sent." });
        return sendResponse({ ok: true });
      }
      // From here on the post runs to the end: a withdrawal no longer closes the window.
      p.sending = true;
      // Confirmed as one account, clicked after Teams switched to another: its session would post it.
      if ((await signedInAccount()) !== p.account) {
        p.finish({ sent: false, reason: ACCOUNT_CHANGED }, true);
        return sendResponse({ ok: false, error: ACCOUNT_CHANGED });
      }
      try {
        p.finish(await sendMessage(p.request, p.account), true);
        sendResponse({ ok: true });
      } catch (err) {
        p.finish({ sent: false, reason: sendFailure(err) }, true);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
}

// Popup lives at popup.html; it is allowed to query status too.
function onPopupMessage(msg, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("popup.html"))) return;
  if (msg.type === "popup:status") sendResponse({ state, lastError, version: VERSION });
  if (msg.type === "popup:reconnect") {
    reconnectNow();
    connect().then(() => sendResponse({ state, lastError }));
    return true;
  }
}

// ------------------------------------------------------------ bridge connection

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.some((b) => /Edge/i.test(b))) return "Edge";
  if (brands.some((b) => /Chrome/i.test(b))) return "Chrome";
  return "Chromium";
}

let starting = false; // a connect() is between its checks and opening the socket
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;

/**
 * The hub sends {type:"ping"} every keep-alive period (its welcome's heartbeatMs; 20 s in every
 * version). When none has come for about 2 periods (this long without heartbeatMs), the hub is
 * frozen or hung: drop its connection and connect again (or to whoever took the port over).
 */
export const HEARTBEAT_TIMEOUT_MS = 45_000;
/** The watchdog never waits less: a busy machine runs timers late, and that isn't a frozen hub. */
const MIN_HEARTBEAT_TIMEOUT_MS = 2_000;
/**
 * A watchdog that runs later than this fraction of its wait after it was due finds the worker
 * stalled. Overdue timers run before the messages that came meanwhile are read, so the hub's ping
 * may wait unread: it waits once more instead, but not twice in a row, so a frozen hub is still
 * dropped (as in src/bridge.ts).
 */
const STALL_SLACK = 0.5;

/** Whether a check that waited `waitMs` and was due at `due` ran late (see STALL_SLACK). */
function ranLate(due, waitMs) {
  return Date.now() - due > waitMs * STALL_SLACK;
}

let watchdog = null; // { socket, ms, timer } of the current connection

/** (Re)starts the watchdog of `socket`: no ping within `ms` drops it and connects again. */
function watchHeartbeat(socket, ms, afterLate = false) {
  clearTimeout(watchdog?.timer);
  const due = Date.now() + ms;
  const timer = setTimeout(() => {
    if (watchdog?.timer !== timer) return;
    watchdog = null;
    if (ws !== socket) return;
    if (!afterLate && ranLate(due, ms)) return watchHeartbeat(socket, ms, true);
    // Its close may never complete: nobody can be told the outcome of what came on it, now.
    withdrawAll(socket);
    reconnectNow();
    connect();
  }, ms);
  watchdog = { socket, ms, timer };
}

function stopWatchdog(socket) {
  if (watchdog?.socket !== socket) return;
  clearTimeout(watchdog.timer);
  watchdog = null;
}

/** Drops the current connection (even one still closing) and connects again. */
function reconnectNow() {
  const old = ws;
  ws = null;
  old?.close();
  retryMs = RETRY_MIN_MS;
}

let reconnecting = true; // false only after stopReconnecting()

/**
 * For tests only (nothing in the extension calls it): the worker never connects again, and no
 * retry or watchdog is left waiting. A test's teardown calls it before the hub's connections end
 * and its fake chrome goes, since a retry would otherwise run connect() without chrome.
 */
export function stopReconnecting() {
  reconnecting = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearTimeout(watchdog?.timer);
  watchdog = null;
}

/**
 * The pairing token: one saved under Advanced, else the one setup wrote into this
 * folder (pairing.json, only in the installed copy). Null when there is none.
 */
async function pairingToken(saved) {
  if (saved) return saved;
  try {
    const res = await fetch(chrome.runtime.getURL("pairing.json"), { cache: "no-store" });
    return res.ok ? ((await res.json()).token ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Connects to the local MCP server. Both sides prove they know the pairing token without
 * sending it (see src/bridge.ts): the extension answers the server's challenge, and acts
 * on requests only after the server answered its own nonce. Any other program that holds
 * the port gets nothing.
 */
async function connect() {
  if (!reconnecting || starting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  starting = true;
  let token, port, instance;
  try {
    ({ token, port, instance } = await chrome.storage.local.get(["token", "port", "instance"]));
    // Identifies this browser profile to the server across reconnects (Chrome and Edge,
    // or two profiles, can be connected at the same time).
    if (!instance) {
      instance = crypto.randomUUID();
      await chrome.storage.local.set({ instance });
    }
  } finally {
    starting = false;
  }
  // stopReconnecting() may have run while the storage read was waiting.
  if (ws || !reconnecting) return;
  state = "connecting";
  const socket = new WebSocket(`ws://127.0.0.1:${port || DEFAULT_PORT}`);
  ws = socket;
  const nonce = crypto.randomUUID();
  let secret = null;
  let challenged = false;
  let authed = false;
  let opened = false;
  // The welcome's proof is checked asynchronously, and the server may send requests right behind
  // it: they wait for the check (in the order they came) instead of being dropped.
  let checking = null;
  socket.onopen = () => (opened = true);
  const refuse = (error) => {
    socket.close();
    if (ws !== socket) return; // replaced meanwhile: the newer connection's state stays
    state = "unauthorized";
    lastError = error;
  };
  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (checking) await checking;
    // Closed or replaced meanwhile: nobody could be told the outcome (its requests were withdrawn).
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (!authed) {
      if (msg.type === "challenge" && !challenged && typeof msg.nonce === "string") {
        challenged = true;
        secret = await pairingToken(token);
        if (!secret) return refuse("This copy of the extension has no pairing file. Run `npx mcp-teams setup` and load the extension from the folder it shows.");
        const proof = await teams.pairingProof(secret, "client", msg.nonce);
        socket.send(JSON.stringify({ type: "hello", proof, nonce, version: VERSION, browser: browserName(), instance, capabilities: CAPABILITIES }));
      } else if (msg.type === "welcome" && !checking) {
        const notProven = () => refuse(`The program on port ${port || DEFAULT_PORT} could not prove it is your mcp-teams server, so the extension doesn't answer it.`);
        checking = (async () => {
          if (!secret || msg.proof !== (await teams.pairingProof(secret, "server", nonce))) return notProven();
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return; // a newer connection's state stays
          authed = true;
          state = "connected";
          lastError = null;
          retryMs = RETRY_MIN_MS;
          const heartbeatMs = Number(msg.heartbeatMs);
          watchHeartbeat(socket, heartbeatMs > 0 ? Math.max(MIN_HEARTBEAT_TIMEOUT_MS, Math.round(2.25 * heartbeatMs)) : HEARTBEAT_TIMEOUT_MS);
        })().catch(notProven);
        await checking;
      }
      return;
    }
    if (msg.type === "ping") {
      if (watchdog?.socket === socket) watchHeartbeat(socket, watchdog.ms);
      return;
    }
    await dispatch(msg, (reply) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(reply)), socket);
  };
  socket.onclose = (ev) => {
    // Nobody can be told the outcome of what came on this connection: withdraw it
    // (an open confirmation window closes; nothing is sent).
    withdrawAll(socket);
    stopWatchdog(socket);
    if (ws && ws !== socket) return; // replaced by a newer connection (reconnectNow)
    ws = null;
    // When a server session ends, another one takes over the port within a second:
    // retry soon, backing off to the alarm's pace.
    clearTimeout(retryTimer);
    retryTimer = reconnecting ? setTimeout(connect, retryMs) : null;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    if (state === "unauthorized" && !authed && lastError) {
      // refuse() said why.
    } else if (opened && !challenged) {
      state = "unauthorized";
      lastError = "The mcp-teams server is older than this extension (0.2.0 or before). Restart your AI app, in Claude Code with /mcp.";
    } else if (ev.code === 4401) {
      state = "unauthorized";
      lastError = "The MCP server refused this extension. Run `npx mcp-teams setup` and load the extension from the folder it shows.";
    } else {
      state = "disconnected";
    }
  };
  socket.onerror = () => {
    lastError = "MCP server not reachable (is your AI client running mcp-teams?)";
  };
}

/** Requests being run, by id, so they can be withdrawn (a cancel from the server, or their connection closed). */
const running = new Map();

/** True when version a is newer than b (x.y.z; anything else never counts as newer), as isNewer in src/bridge.ts. */
function isNewerVersion(a, b) {
  const parse = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// chrome.storage.local: { version, at } of the last reload into a newer version found on disk.
const SELF_UPDATE_KEY = "selfUpdateTried";
/** A reload into the same version on disk is tried again only after this long (no reload loop). */
export const SELF_UPDATE_RETRY_MS = 10 * 60_000;

/** The version in this extension's folder on disk (read fresh, not the one loaded), or null. */
async function versionOnDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    return res.ok ? ((await res.json()).version ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * #111: a server updated this extension's folder (syncExtension) but its reload never got
 * through, e.g. the hub restarted while it asked, or that server's session ended first. The
 * old code then kept running against the new files until someone reloaded the extension by
 * hand. On each reconnect alarm, the extension compares its folder with what it runs and
 * reloads itself into a newer version, without any server. Never while it runs a request (a
 * send's confirmation window would close), and the same version at most every
 * SELF_UPDATE_RETRY_MS, so a version Chrome fails to load can't make it reload on every alarm.
 */
export async function reloadIfUpdatedOnDisk(now = Date.now()) {
  const onDisk = await versionOnDisk();
  if (!isNewerVersion(onDisk, VERSION)) return false;
  if (running.size || pendingSends.size || autoSending) return false; // the next alarm looks again
  const tried = (await chrome.storage.local.get(SELF_UPDATE_KEY))[SELF_UPDATE_KEY];
  if (tried?.version === onDisk && now - tried.at < SELF_UPDATE_RETRY_MS) return false;
  await chrome.storage.local.set({ [SELF_UPDATE_KEY]: { version: onDisk, at: now } });
  // Again: a request may have come in during the storage calls.
  if (running.size || pendingSends.size || autoSending) return false;
  chrome.runtime.reload();
  return true;
}

/**
 * What a handler gets besides its params: whether the request was withdrawn (by the server,
 * its connection closing, or its deadline passing), onCancel(f) (returns a stop function),
 * check() (throws once withdrawn) and its absolute `deadline` (null without timeoutMs).
 */
function requestContext(conn, timeoutMs, sentDeadline) {
  const listeners = new Set();
  let timer = null;
  // The server's own deadline when it sends one (newer servers): it stopped waiting then, and the
  // request may have taken a moment to arrive.
  const deadline = timeoutMs > 0 ? Math.min(Date.now() + timeoutMs, sentDeadline > 0 ? sentDeadline : Infinity) : null;
  const limitReached = () => `The request's time limit (${secondsOf(timeoutMs)} s) passed before Teams answered.`;
  const ctx = {
    conn,
    cancelled: false,
    reason: null,
    deadline,
    cancel(reason = "The request was withdrawn.") {
      if (ctx.cancelled) return;
      ctx.cancelled = true;
      ctx.reason = new Error(reason);
      clearTimeout(timer);
      for (const f of [...listeners]) f();
    },
    onCancel(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    check() {
      // The deadline counts even before its timer fired (e.g. a server deadline that passed on the way).
      if (!ctx.cancelled && deadline !== null && Date.now() >= deadline) ctx.cancel(limitReached());
      if (ctx.cancelled) throw ctx.reason;
    },
    /** The request ended: its deadline no longer matters. */
    end() {
      clearTimeout(timer);
    },
  };
  if (deadline) timer = setTimeout(() => ctx.cancel(limitReached()), Math.max(0, deadline - Date.now()));
  return ctx;
}

/** `promise`, unless the request (ctx) is withdrawn first: then its reason. The promise itself goes on (others may share it). */
function guarded(promise, ctx) {
  if (!ctx) return promise;
  if (ctx.cancelled) return Promise.reject(ctx.reason);
  return new Promise((resolve, reject) => {
    const stop = ctx.onCancel(() => reject(ctx.reason));
    promise.then(resolve, reject).finally(stop);
  });
}

/**
 * The hub's turn a request holds (newer hubs say so with `turn: true`): giveBack() lets other
 * calls have it ({type:"gate-wait"}), takeAgain() asks for one ({type:"gate-open"}) and resolves
 * when the hub's {type:"turn"} comes (given()).
 */
function hubTurn(id, send) {
  let resume = null;
  return {
    giveBack: () => send({ type: "gate-wait", id }),
    takeAgain: () =>
      new Promise((resolve) => {
        resume = resolve;
        send({ type: "gate-open", id });
      }),
    given() {
      resume?.();
      resume = null;
    },
  };
}

/** Withdraws the requests that came on `conn`: their answers can no longer arrive. */
function withdrawAll(conn) {
  for (const ctx of running.values()) if (ctx.conn === conn) ctx.cancel();
}

/** The handlers that read Teams for the AI: their answers carry a note while the account is unsure (#77). */
const READS = new Set(["listTeams", "listChats", "readMessages", "searchMessages", "findPeople", "listMeetings", "getMeeting", "readTranscript", "searchTranscripts"]);

/**
 * Runs one request from the server with its handler and sends back the response.
 * {type:"cancel", id} withdraws a running request that came on the same connection (`conn`);
 * an unknown one is ignored, as is any other message.
 */
export async function dispatch(msg, send, conn = null) {
  if (msg.type === "cancel" || msg.type === "turn") {
    const ctx = running.get(msg.id);
    if (ctx?.conn !== conn) return;
    if (msg.type === "cancel") ctx.cancel();
    else ctx.turn?.given();
    return;
  }
  if (msg.type !== "request") return;
  const ctx = requestContext(conn, Number(msg.timeoutMs), Number(msg.deadline));
  if (msg.turn === true) ctx.turn = hubTurn(msg.id, send);
  running.set(msg.id, ctx);
  const handler = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : null;
  try {
    if (!handler) throw new Error(`Unknown method ${msg.method}`);
    let result = await handler(msg.params ?? {}, ctx);
    // A read while the account is unsure (#77) goes on, and says so.
    const unsure = READS.has(msg.method) && result && typeof result === "object" ? await accountUnsure() : null;
    if (unsure) result = { ...result, accountNote: UNSURE_READ(unsure) };
    send({ type: "response", id: msg.id, ok: true, result });
  } catch (err) {
    send({ type: "response", id: msg.id, ok: false, error: err?.message ?? String(err) });
  } finally {
    ctx.end();
    if (running.get(msg.id) === ctx) running.delete(msg.id);
  }
}

function onStorageChanged(changes, area) {
  if (area === "local" && (changes.token || changes.port)) {
    state = "disconnected";
    reconnectNow();
    connect();
  }
}

/** Registers the worker's chrome event listeners (no connection; see below). */
export function registerListeners() {
  chrome.webRequest.onBeforeSendHeaders.addListener(captureSession, captureFilter, ["requestHeaders", "extraHeaders"]);
  chrome.webRequest.onBeforeSendHeaders.addListener(recordRequest, trafficFilter, ["requestHeaders", "extraHeaders"]);
  chrome.webRequest.onCompleted.addListener(recordCompleted, trafficFilter);
  chrome.windows.onRemoved.addListener(onWindowRemoved);
  chrome.runtime.onMessage.addListener(onConfirmMessage);
  chrome.runtime.onMessage.addListener(onPopupMessage);
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== "reconnect") return;
    reloadIfUpdatedOnDisk().catch(() => {});
    connect();
    closeLeftoverHelperTab().catch(() => {});
    recaptureOnce().catch(() => {});
  });
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(connect);
  // The captured sessions were cleared (see recaptureMissingChatSession).
  chrome.runtime.onStartup.addListener(() => recaptureOnce().catch(() => {}));
  // A browser update (reason "chrome_update") isn't a reload: the sessions are still there.
  chrome.runtime.onInstalled.addListener((d) => (d?.reason === "install" || d?.reason === "update") && recaptureOnce().catch(() => {}));
}

// In the browser: listen and connect synchronously on load, as MV3 needs for its listeners
// to wake the worker. Tests import this module under a fake chrome, where neither happens.
const IN_EXTENSION = typeof ServiceWorkerGlobalScope === "function" && globalThis instanceof ServiceWorkerGlobalScope;
if (IN_EXTENSION) {
  registerListeners();
  chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  connect();
  closeLeftoverHelperTab().catch(() => {});
}
