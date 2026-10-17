// Service worker: connects to the local MCP server over WebSocket and runs Teams
// requests inside an open Teams tab, with the session Teams itself uses.

import * as teams from "./teams.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 47393;
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
  const capture = { base: svc.base, region: svc.region ?? null, headers, at: Date.now() };
  const update = { [`capture:${svc.service}`]: capture };
  if (svc.oid) update.oid = svc.oid;
  chrome.storage.session.set(update);
}

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
 */
const TRAFFIC_KEY = "traffic";
let traffic = null;
let trafficSave = null;
let trafficQueue = Promise.resolve();

/** Applies fn to the log one update at a time, so events that land together don't overwrite each other. */
function updateTraffic(fn) {
  trafficQueue = trafficQueue
    .then(async () => {
      traffic ??= (await chrome.storage.session.get(TRAFFIC_KEY))[TRAFFIC_KEY] ?? [];
      traffic = fn(traffic);
      clearTimeout(trafficSave);
      trafficSave = setTimeout(() => chrome.storage.session.set({ [TRAFFIC_KEY]: traffic }), 500);
    })
    .catch(() => {});
  return trafficQueue;
}

const trafficFilter = { urls: teams.TRAFFIC_URLS, types: ["xmlhttprequest", "other", "media"] };

function recordRequest(details) {
  if (!teams.isTeamsOrigin(details.initiator)) return;
  const entry = teams.summarizeRequest(details);
  updateTraffic((list) => teams.recordTraffic(list, entry));
}

function recordCompleted(details) {
  if (!teams.isTeamsOrigin(details.initiator)) return;
  const url = new URL(details.url);
  const key = `${details.method} ${url.host}${url.pathname.slice(0, 300)}`;
  updateTraffic((list) => teams.recordStatus(list, key, details.statusCode));
}

async function getCapture(service) {
  const key = `capture:${service}`;
  return (await chrome.storage.session.get(key))[key] ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until a session newer than `since` is captured for the service; null on timeout. */
async function waitForCapture(service, since, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(250)) {
    const cap = await getCapture(service);
    if (cap && cap.at > since) return cap;
  }
  return null;
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

/** The Teams tab to run requests in: one on the origin of the service's capture, else any. */
async function findTeamsTab(origin) {
  const tabs = await chrome.tabs.query({ url: TEAMS_URLS });
  if (!tabs.length) return openTeamsTab();
  const sameOrigin = tabs.filter((t) => origin && t.url?.startsWith(origin));
  const pool = sameOrigin.length ? sameOrigin : tabs;
  return pool.find((t) => !t.discarded && t.status === "complete") ?? pool[0];
}

// Teams keeps routing for a moment after the page has loaded.
const SETTLE_MS = 1_000;

async function waitForTabLoaded(tabId, timeoutMs = 30_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(250)) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (t.status === "complete") return sleep(SETTLE_MS);
  }
}

const refreshing = new Map(); // service -> Promise<capture|null>, so parallel calls reload once

/**
 * A captured token is lost when the extension reloads and expires after about an hour.
 * Teams' next own request to the service brings a fresh one; if none comes soon, reload
 * the Teams tab, which makes Teams call its services again.
 */
function refreshSession(service, tab, { quickWaitMs = 4_000 } = {}) {
  if (!refreshing.has(service)) {
    const since = Date.now();
    const p = (async () => {
      const quick = quickWaitMs ? await waitForCapture(service, since, quickWaitMs) : null;
      if (quick) return quick;
      await chrome.tabs.reload(tab.id);
      const cap = await waitForCapture(service, since, 45_000);
      if (cap) await waitForTabLoaded(tab.id);
      return cap;
    })().finally(() => refreshing.delete(service));
    refreshing.set(service, p);
  }
  return refreshing.get(service);
}

const SERVICE_HELP = {
  chatsvc: "Teams' chat session is not available. Reload the Teams tab and try again.",
  csa: "Teams' team list session is not available. Reload the Teams tab and try again.",
  mt: "Teams' people session is not available. Reload the Teams tab and try again.",
  substrate:
    "Teams' search session is not available yet. Click into the search box at the top of Teams once (that makes Teams sign in to search), then try again.",
};

/**
 * Runs inside the Teams page (MAIN world) so cookies and origin are the page's own.
 * status 0: no answer (network error or timeoutMs passed).
 */
async function pageFetch(url, method, headers, body, timeoutMs) {
  try {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: body == null ? headers : { ...headers, "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  } catch (err) {
    return { status: 0, text: "", error: err?.name === "TimeoutError" ? "timeout" : String(err?.message ?? err) };
  }
}

async function runInTab(tab, url, method, headers, body) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: pageFetch,
    // executeScript can't pass undefined.
    args: [url, method, headers, body ?? null, REQUEST_TIMEOUT_MS],
  });
  const res = injection?.result;
  if (!res) throw new Error("Could not run inside the Teams tab. Reload the Teams tab and try again.");
  if (res.status === 0) {
    throw new Error(
      res.error === "timeout"
        ? `Teams did not answer within ${REQUEST_TIMEOUT_MS / 1000} s. Reload the Teams tab and try again.`
        : `Could not reach Teams: ${res.error}`,
    );
  }
  return res;
}

/**
 * One request to a Teams service. `path` is relative to the service's base URL (or a
 * full URL on it). Returns the parsed JSON (null for an empty answer).
 */
async function api(service, path, { method = "GET", body, raw = false, withLocation = false } = {}) {
  let cap = await getCapture(service);
  let tab = await findTeamsTab(cap ? new URL(cap.base).origin : null);
  if (!cap) {
    cap = await refreshSession(service, tab, { quickWaitMs: service === "substrate" ? 2_000 : 4_000 });
    if (!cap) throw new Error(SERVICE_HELP[service]);
  }
  const urlFor = (c) => teams.serviceUrl(path, c.base);
  let res = await runInTab(tab, urlFor(cap), method, cap.headers, body);
  if (res.status === 401) {
    // Rejected before running (expired token), so trying once more is safe. A 403 is a
    // real answer (e.g. no longer a member of that chat).
    cap = await refreshSession(service, tab, { quickWaitMs: 0 });
    if (!cap) throw new Error(SERVICE_HELP[service]);
    tab = await findTeamsTab(new URL(cap.base).origin);
    res = await runInTab(tab, urlFor(cap), method, cap.headers, body);
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
    throw new Error(`Teams returned something that isn't JSON (${service}, HTTP ${res.status}).`);
  }
}

// ------------------------------------------------------------ data

/** The signed-in user's MRI ("8:orgid:<guid>"), from the people service's request paths. */
async function myMri() {
  const { oid } = await chrome.storage.session.get("oid");
  return oid ? `8:orgid:${oid}` : null;
}

const LIST_CACHE_MS = 60_000;
let listCache = null; // { at, data: { teams, chats } }

/** Teams, channels and chats (csa), with names for untitled chats. Cached for a minute. */
async function teamsAndChats(fresh = false) {
  if (!fresh && listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.data;
  const json = await api("csa", "/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true&enableRC2Fetch=false");
  const data = { teams: teams.parseTeams(json), chats: teams.parseCsaChats(json), meetings: teams.parseCsaMeetings(json) };
  await nameChats(data.chats);
  await lookupNames(data.meetings.map((m) => m.organizer));
  for (const m of data.meetings) m.organizerName = names.get(m.organizer) ?? null;
  listCache = { at: Date.now(), data };
  return data;
}

const names = new Map(); // mri -> display name; bounded, starts over when full
const NAMES_MAX = 5000;

/** Looks up display names for MRIs not seen yet (mt short profiles, 100 at a time). */
async function lookupNames(mris) {
  const unknown = [...new Set(mris)].filter((m) => m && !names.has(m) && /^8:/.test(m));
  for (let i = 0; i < unknown.length; i += 100) {
    const batch = unknown.slice(i, i + 100);
    const json = await api("mt", "/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true", {
      method: "POST",
      body: batch,
    }).catch(() => null);
    if (names.size > NAMES_MAX) names.clear();
    for (const p of teams.parseProfiles(json)) if (p.mri && p.name) names.set(p.mri, p.name);
  }
}

async function nameChats(chats) {
  const me = await myMri();
  await lookupNames(chats.filter((c) => !c.title).flatMap((c) => c.members));
  for (const c of chats) {
    c.memberNames = c.members.filter((m) => m !== me).map((m) => names.get(m)).filter(Boolean);
    c.title = teams.chatTitle(c, names, me);
  }
}

async function resolve(conversation) {
  const q = String(conversation ?? "").trim();
  if (!q) throw new Error("Say which chat or channel: an id, 'Team/Channel', a chat title or a person's name.");
  if (/^(19|48):/.test(q)) {
    const data = await teamsAndChats().catch(() => ({ teams: [], chats: [] }));
    return describe(q.split(";messageid=")[0], data);
  }
  return teams.resolveConversation(q, await teamsAndChats());
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
async function searchPeople(query, limit) {
  const body = {
    EntityRequests: [{ Query: { QueryString: query, DisplayQueryString: query }, EntityType: "People", Size: limit, Fields: ["Id", "MRI", "DisplayName", "EmailAddresses", "PeopleType", "PeopleSubtype", "UserPrincipalName", "GivenName", "Surname", "JobTitle", "Department", "CompanyName", "OfficeLocation", "ExternalDirectoryObjectId"] }],
    cvid: crypto.randomUUID(),
    logicalId: crypto.randomUUID(),
    AppName: "Microsoft Teams",
    Scenario: { Name: "peoplepicker.newChat" },
  };
  return teams.parseSuggestions(await api("substrate", "/search/api/v1/suggestions?scenario=peoplepicker.newChat", { method: "POST", body }));
}

/** Each name or address as the one person it means (see teams.pickPerson). */
async function resolvePeople(queries, me) {
  const people = [];
  for (const q of queries) {
    const query = String(q).trim();
    if (/^8:orgid:/i.test(query)) {
      await lookupNames([query]);
      people.push({ mri: query, name: names.get(query) ?? query, email: null });
      continue;
    }
    let found = await searchPeople(query, 10);
    // People search can miss a full name it would find by one of its words (seen with
    // "KIM MIN JUN" for "김민준(KIM MIN JUN)"): then search each word, keeping exact names.
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    if (!found.length && words.length > 1) {
      for (const w of words) {
        found = (await searchPeople(w, 25)).filter((p) => teams.sameName(p.name, query));
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
async function sharepointTab(origin) {
  const open = (await chrome.tabs.query({ url: `${origin}/*` })).filter((t) => !t.discarded);
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
      for (const end = Date.now() + OPEN_TAB_WAIT_MS; Date.now() < end; await sleep(500)) {
        const t = await chrome.tabs.get(tab.id).catch(() => null);
        if (!t) throw new Error("The SharePoint tab that was opened was closed. Try again.");
        if (t.status === "complete" && t.url?.startsWith(`${origin}/`)) return t;
      }
      throw new Error(`OneDrive (${origin}) was opened in a background tab but isn't signed in yet. Sign in there, then try again.`);
    })().finally(() => spOpening.delete(origin));
    spOpening.set(origin, p);
  }
  return spOpening.get(origin);
}

/** A GET on SharePoint with the browser's own SharePoint session. */
async function sharepointGet(url) {
  if (!SHAREPOINT_URL.test(url)) throw new Error("Not a SharePoint URL");
  return runInTab(await sharepointTab(new URL(url).origin), url, "GET", {}, null);
}

const transcripts = new Map(); // transcript URL -> parsed transcript; a finished transcript doesn't change
const TRANSCRIPTS_MAX = 50;

/** A call's transcript (Stream transcript.json) from the organizer's OneDrive. */
async function transcriptOf(info, session) {
  const cached = transcripts.get(session.transcriptUrl);
  if (cached) return cached;
  const url = session.transcriptUrl + (session.transcriptUrl.includes("?") ? "&" : "?") + "format=json";
  const res = await sharepointGet(url);
  if (res.status === 403 || res.status === 404) {
    throw new Error(`The transcript of "${info.title}" (${session.start}) is no longer available to you (HTTP ${res.status}): the organizer may have deleted it or not shared it.`);
  }
  if (res.status >= 400) throw new Error(`OneDrive HTTP ${res.status} while reading the transcript.`);
  const json = JSON.parse(res.text);
  if (transcripts.size >= TRANSCRIPTS_MAX) transcripts.delete(transcripts.keys().next().value);
  transcripts.set(session.transcriptUrl, json);
  return json;
}

/** A meeting chat by id, title or subject. */
async function resolveMeeting(meeting) {
  const conv = await resolve(meeting);
  const info = (await teamsAndChats()).meetings.find((m) => m.id === conv.id);
  if (!info) throw new Error(`"${conv.title ?? conv.id}" is not a meeting chat. list_meetings lists them.`);
  return info;
}

/** The calls held in a meeting chat (see teams.meetingSessions). */
async function sessionsOf(info) {
  let raw;
  try {
    raw = await fetchMessages(info.id, { limit: 2000, includeSystem: true });
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
async function fetchMessages(id, { limit, before, includeSystem, threadId }) {
  const target = threadId ? `${id};messageid=${threadId}` : id;
  let path = `/v1/users/ME/conversations/${encodeURIComponent(target)}/messages?view=${encodeURIComponent(MESSAGES_VIEW)}&pageSize=${Math.min(200, Math.max(20, limit * 2))}&startTime=1`;
  const beforeMs = before ? Date.parse(before) : null;
  const raw = [];
  let counted = 0;
  for (let page = 0; page < 20 && path; page++) {
    const json = await api("chatsvc", path);
    const msgs = json?.messages ?? [];
    for (const m of msgs) {
      const t = Date.parse(m.originalarrivaltime ?? m.composetime ?? "");
      if (beforeMs && t >= beforeMs) continue;
      raw.push(m);
      if (includeSystem || !/^(ThreadActivity\/|Event\/|Control\/)/i.test(m.messagetype ?? "")) counted++;
    }
    if (counted >= limit || !msgs.length) break;
    path = json?._metadata?.backwardLink ?? null;
  }
  return raw;
}

export const handlers = {
  async status() {
    const tabs = await chrome.tabs.query({ url: TEAMS_URLS });
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
    };
  },

  async listTeams() {
    return { teams: (await teamsAndChats(true)).teams };
  },

  async listChats({ query, limit = 30, unreadOnly = false }) {
    let chats = (await teamsAndChats(true)).chats;
    if (unreadOnly) chats = chats.filter((c) => c.unread);
    if (query) chats = chats.filter((c) => teams.matchesWords(c.title, query) || c.memberNames?.some((n) => teams.matchesWords(n, query)));
    chats.sort((a, b) => (b.lastMessage?.time ?? "").localeCompare(a.lastMessage?.time ?? ""));
    return {
      total: chats.length,
      chats: chats.slice(0, limit).map(({ members, memberNames, lastFrom, ...c }) => ({ ...c, memberCount: members.length || undefined })),
    };
  },

  async readMessages({ conversation, limit = 30, before, includeSystem = false, threadId }) {
    const conv = await resolve(conversation);
    const raw = await fetchMessages(conv.id, { limit, before, includeSystem, threadId });
    let messages = teams.buildConversation(raw, { includeSystem, channel: conv.kind === "channel" && !threadId });
    // Newest `limit` posts (a post counts once, with its replies).
    const more = messages.length > limit;
    messages = messages.slice(-limit);
    return {
      conversation: conv,
      count: messages.length,
      messages,
      ...(more || raw.length ? { olderBefore: messages[0]?.time ?? null } : {}),
    };
  },

  async searchMessages({ query, limit = 25, offset = 0 }) {
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
    const r = teams.parseSearch(await api("substrate", "/searchservice/api/v2/query", { method: "POST", body }));
    return { query, ...r, results: r.results.slice(0, limit) };
  },

  async findPeople({ query, limit = 10 }) {
    const people = await searchPeople(query, limit);
    return { count: people.length, people };
  },

  async listMeetings({ query, limit = 20, transcriptOnly = false }) {
    let meetings = (await teamsAndChats(true)).meetings;
    if (query) meetings = meetings.filter((m) => teams.matchesWords(m.title, query) || teams.matchesWords(m.organizerName, query));
    if (transcriptOnly) meetings = meetings.filter((m) => m.hasTranscript);
    meetings = [...meetings].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
    return {
      total: meetings.length,
      meetings: meetings.slice(0, limit).map(({ organizer, organizerName, joinUrl, lastJoinAt, ...m }) => ({ ...m, organizer: organizerName ?? organizer })),
    };
  },

  async getMeeting({ meeting, limit = 10 }) {
    const info = await resolveMeeting(meeting);
    const sessions = await sessionsOf(info);
    const { organizer, organizerName, lastJoinAt, ...rest } = info;
    return {
      meeting: { ...rest, organizer: organizerName ?? organizer },
      sessionCount: sessions.length,
      sessions: sessions.slice(-limit).reverse().map(({ transcriptUrl, ...s }) => s),
    };
  },

  async readTranscript({ meeting, session, from, maxLength = 40_000 }) {
    const info = await resolveMeeting(meeting);
    const all = await sessionsOf(info);
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
    const json = await transcriptOf(info, s);
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

  async searchTranscripts({ query, meeting, limit = 30, meetings: maxMeetings = 10 }) {
    let list = meeting ? [await resolveMeeting(meeting)] : (await teamsAndChats(true)).meetings.filter((m) => m.hasTranscript);
    list = [...list].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "")).slice(0, maxMeetings);
    const results = [];
    const skipped = [];
    let total = 0;
    let shown = 0;
    for (const info of list) {
      let sessions;
      try {
        sessions = (await sessionsOf(info)).filter((s) => s.transcriptUrl);
      } catch (err) {
        skipped.push({ meeting: info.title, reason: err.message });
        continue;
      }
      for (const s of sessions.reverse()) {
        let json;
        try {
          json = await transcriptOf(info, s);
        } catch (err) {
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
    return { query, meetingsSearched: list.length, matches: total, results, ...(skipped.length ? { skipped } : {}) };
  },

  /** Read-only diagnostics for development: a GET on a service, never its headers. */
  async probe({ service, path, url }) {
    if (url) {
      const res = await sharepointGet(url);
      return { status: res.status, text: res.text.slice(0, 20_000_000) };
    }
    if (!["chatsvc", "csa", "mt", "substrate"].includes(service)) throw new Error("Unknown service");
    const res = await api(service, path, { raw: true });
    return { status: res.status, text: res.text.slice(0, 20_000_000) };
  },

  async apiTraffic({ filter, limit = 100, clear = false }) {
    let list;
    await updateTraffic((l) => {
      list = l;
      return clear ? [] : l;
    });
    return { recorded: list.length, requests: teams.filterTraffic(list, { filter, limit }) };
  },

  /**
   * Reloads the extension from disk (after an update). Refused while a send waits for
   * the user's decision, since reloading would close that window.
   */
  async reload() {
    if (pendingSends.size) throw new Error("A message is waiting for your decision in the confirmation window; reload after that.");
    setTimeout(() => chrome.runtime.reload(), 250); // after this response is sent
    return { reloading: true, version: VERSION };
  },

  async requestSend({ conversation, to, title, text, threadId, subject }) {
    if (!String(text ?? "").trim()) throw new Error("The message is empty.");
    if (to?.length) {
      if (conversation) throw new Error("Give either a conversation or people (to), not both.");
      if (threadId || subject) throw new Error("reply_to and subject are for channels; a new chat takes people and an optional title.");
      const me = await myMri();
      if (!me) throw new Error("Teams hasn't shown who is signed in yet. Reload the Teams tab and try again.");
      const people = await resolvePeople(to, me);
      if (title && people.length < 2) throw new Error("A title is only for group chats (two or more people besides you).");
      const existing = teams.findExistingChat((await teamsAndChats(true)).chats, people.map((p) => p.mri), me, title);
      const request = existing
        ? { conversation: { id: existing.id, kind: existing.kind, title: existing.title }, people, text: String(text), existingChat: true }
        : { conversation: null, newChat: { members: people.map((p) => p.mri), title: title ?? null }, people, text: String(text) };
      return askUserToConfirm(request);
    }
    const conv = await resolve(conversation);
    if (threadId && conv.kind !== "channel") throw new Error("reply_to is only for channel posts; in a chat, just send the message.");
    if (subject && (conv.kind !== "channel" || threadId)) throw new Error("A subject is only for a new channel post.");
    let replyingTo = null;
    if (threadId) {
      const root = (await fetchMessages(conv.id, { limit: 1, threadId, includeSystem: false })).find((m) => String(m.id) === String(threadId));
      replyingTo = root ? teams.parseMessage(root) : { id: threadId };
    }
    const request = { conversation: conv, text: String(text), threadId: threadId ?? null, subject: subject ?? null, replyingTo };
    return askUserToConfirm(request);
  },
};

/**
 * Creates a chat with these members and me (called only after the user clicked Send).
 * A 1:1 chat that already exists on Teams' side comes back as that chat.
 */
async function createChat({ members, title }) {
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
  const { json, location } = await api("chatsvc", "/v1/threads", { method: "POST", body, withLocation: true });
  const id = teams.threadIdFrom(location, json) ?? (oneOnOne ? teams.oneOnOneId(me, members[0]) : null);
  if (!id) throw new Error("Teams created no chat (its answer had no chat id).");
  listCache = null; // the chat list changed
  return id;
}

async function sendMessage({ conversation, newChat, people, text, threadId, subject }) {
  if (newChat) {
    const id = await createChat(newChat);
    const title = newChat.title ?? people.map((p) => p.name).join(", ");
    const r = await sendMessage({ conversation: { id, title }, text });
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
  const r = await api("chatsvc", `/v1/users/ME/conversations/${encodeURIComponent(target)}/messages`, { method: "POST", body });
  return { sent: true, conversation: conversation.title ?? conversation.id, time: r?.OriginalArrivalTime ? new Date(r.OriginalArrivalTime).toISOString() : null };
}

// ------------------------------------------------------------ send confirmation

/**
 * The AI can only *request* a send. The message is posted only after the user clicks
 * Send in an extension-owned window, showing exactly what will be posted where.
 */
const pendingSends = new Map();

async function askUserToConfirm(request) {
  const id = crypto.randomUUID();
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`confirm.html?id=${id}`),
    type: "popup",
    width: 600,
    height: 640,
    focused: true,
  });
  return new Promise((resolve) => {
    const finish = (result) => {
      const p = pendingSends.get(id);
      if (!p) return;
      pendingSends.delete(id);
      clearTimeout(p.timer);
      chrome.windows.remove(p.windowId).catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish({ sent: false, reason: "No decision within 5 minutes; nothing was sent." }), CONFIRM_TIMEOUT_MS);
    pendingSends.set(id, { request, windowId: win.id, timer, finish });
  });
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
      try {
        p.finish(await sendMessage(p.request));
        sendResponse({ ok: true });
      } catch (err) {
        p.finish({ sent: false, reason: `Sending failed: ${err.message}` });
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

/** Drops the current connection (even one still closing) and connects again. */
function reconnectNow() {
  const old = ws;
  ws = null;
  old?.close();
  retryMs = RETRY_MIN_MS;
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
  if (starting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
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
  if (ws) return;
  state = "connecting";
  const socket = new WebSocket(`ws://127.0.0.1:${port || DEFAULT_PORT}`);
  ws = socket;
  const nonce = crypto.randomUUID();
  let secret = null;
  let challenged = false;
  let authed = false;
  let opened = false;
  socket.onopen = () => (opened = true);
  const refuse = (error) => {
    state = "unauthorized";
    lastError = error;
    socket.close();
  };
  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (!authed) {
      if (msg.type === "challenge" && !challenged && typeof msg.nonce === "string") {
        challenged = true;
        secret = await pairingToken(token);
        if (!secret) return refuse("This copy of the extension has no pairing file. Run `npx mcp-teams setup` and load the extension from the folder it shows.");
        const proof = await teams.pairingProof(secret, "client", msg.nonce);
        socket.send(JSON.stringify({ type: "hello", proof, nonce, version: VERSION, browser: browserName(), instance }));
      } else if (msg.type === "welcome") {
        if (!secret || msg.proof !== (await teams.pairingProof(secret, "server", nonce))) {
          return refuse(`The program on port ${port || DEFAULT_PORT} could not prove it is your mcp-teams server, so the extension doesn't answer it.`);
        }
        authed = true;
        state = "connected";
        lastError = null;
        retryMs = RETRY_MIN_MS;
      }
      return;
    }
    await dispatch(msg, (reply) => socket.send(JSON.stringify(reply)));
  };
  socket.onclose = (ev) => {
    if (ws && ws !== socket) return; // replaced by a newer connection (reconnectNow)
    ws = null;
    // When a server session ends, another one takes over the port within a second:
    // retry soon, backing off to the alarm's pace.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryMs);
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

/**
 * Runs one request from the server with its handler and sends back the response. Anything
 * but a request is ignored.
 */
export async function dispatch(msg, send) {
  if (msg.type !== "request") return;
  const handler = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : null;
  try {
    if (!handler) throw new Error(`Unknown method ${msg.method}`);
    const result = await handler(msg.params ?? {});
    send({ type: "response", id: msg.id, ok: true, result });
  } catch (err) {
    send({ type: "response", id: msg.id, ok: false, error: err?.message ?? String(err) });
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
  chrome.alarms.onAlarm.addListener((a) => a.name === "reconnect" && connect());
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(connect);
}

// In the browser: listen and connect synchronously on load, as MV3 needs for its listeners
// to wake the worker. Tests import this module under a fake chrome, where neither happens.
const IN_EXTENSION = typeof ServiceWorkerGlobalScope === "function" && globalThis instanceof ServiceWorkerGlobalScope;
if (IN_EXTENSION) {
  registerListeners();
  chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  connect();
}
