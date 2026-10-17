// Pure helpers for Teams' web API: where requests go, and turning its JSON into what the
// tools return. No chrome.* here, so the tests can import it.
//
// Teams on the web (v2) talks to several services through its own origin:
//   chatsvc  /api/chatsvc/<region>/v1/users/ME/conversations…   chats, channels, messages
//   csa      /api/csa/<region>/api/v1/teams/users/me…           teams, channels and the chat list
//   mt       /api/mt/<region>/beta/users/…                      people, profiles
// and substrate.office.com for search. Each has its own token, which the extension
// learns from Teams' own requests.

/** Which service a Teams request went to, and the base URL to send our requests to. */
export function serviceOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/api\/(chatsvc|csa|mt)\/([a-z0-9-]+)\//i.exec(u.pathname);
  if (m) {
    const service = m[1].toLowerCase();
    const base = `${u.origin}/api/${m[1]}/${m[2]}`;
    // mt calls carry the signed-in user's object id in their path.
    const oid = service === "mt" ? /\/users\/([0-9a-f-]{36})\//i.exec(u.pathname)?.[1]?.toLowerCase() : undefined;
    return { service, base, region: m[2], ...(oid ? { oid } : {}) };
  }
  // Older clients call the chat service directly.
  const ng = /^([a-z0-9-]+)\.ng\.msg\.teams\.microsoft\.com$/i.exec(u.hostname);
  if (ng && u.pathname.startsWith("/v1/")) return { service: "chatsvc", base: u.origin, region: ng[1] };
  if (u.hostname === "substrate.office.com") return { service: "substrate", base: u.origin };
  return null;
}

/** Headers of Teams' own requests that we replay (never logged or returned). */
export const REPLAY_HEADERS = [
  "authorization",
  "authentication",
  "x-skypetoken",
  "x-ms-client-version",
  "x-ms-client-type",
  "behavioroverride",
  "clientinfo",
  "x-anchormailbox",
  "x-client-version",
];

/** The replayable headers of a request, or null when it carries no credentials. */
export function pickHeaders(requestHeaders) {
  const headers = {};
  for (const h of requestHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (REPLAY_HEADERS.includes(name) && h.value) headers[name] = h.value;
  }
  return headers.authorization || headers.authentication || headers["x-skypetoken"] ? headers : null;
}

/** A paging link from chatsvc (often on its own host) on the base we send requests to. */
export function rebase(link, base) {
  const i = link.indexOf("/v1/");
  return i === -1 ? link : `${base}${link.slice(i)}`;
}

/**
 * The URL a request to a service goes to: `path` relative to its base, or a full URL put
 * on the base. Throws for anything that would leave the base's origin, since the request
 * carries the service's captured tokens.
 */
export function serviceUrl(path, base) {
  const p = String(path ?? "");
  const url = /^https:/i.test(p) ? rebase(p, base) : p.startsWith("/") ? `${base}${p}` : null;
  let ok = false;
  try {
    ok = url !== null && new URL(url).origin === new URL(base).origin;
  } catch {
    // not a URL
  }
  if (!ok) throw new Error(`Refusing a request outside ${new URL(base).origin}`);
  return url;
}

// ------------------------------------------------------------ read_messages cursor

const toBase64Url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/**
 * An opaque read_messages cursor: where to resume (a chatsvc messages link, kept as a path
 * from /v1/ so it goes to whatever base the session uses) and, optionally, the message the
 * next page must be older than: its time `before` and its `id` (see compareMessageKeys).
 * Cursors without an id (made before ids were kept) mean "older than that time".
 */
export function messagesCursor(link, before, id = null) {
  const s = String(link);
  const i = s.indexOf("/v1/");
  return toBase64Url(JSON.stringify({ p: i === -1 ? s : s.slice(i), b: before ?? null, ...(id != null ? { i: String(id) } : {}) }));
}

/** Ids compare as numbers when both are digits (chatsvc's are), else as plain strings. */
export function compareMessageIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * When a message was sent, in ms: its time, else its id when that is digits (chatsvc ids
 * are the arrival time in ms), else -Infinity (oldest).
 */
const msOfKey = ({ time, id }) => {
  const t = time ? Date.parse(time) : NaN;
  if (!Number.isNaN(t)) return t;
  return id != null && /^\d{1,16}$/.test(id) ? Number(id) : -Infinity;
};

/** { time, id } of a raw chatsvc message, as parseMessage reads them. */
export const messageKey = (m) => ({ time: isoTime(m.originalarrivaltime ?? m.composetime ?? m.composeTime), id: String(m.id ?? m.clientmessageid ?? "") });

/**
 * Orders messages by { time, id }: by time, then by id. A key `b` without an id stands for
 * a moment: messages at that time compare equal to it (so "older than b" is strictly older).
 */
export function compareMessageKeys(a, b) {
  const x = msOfKey(a);
  const y = msOfKey(b);
  if (x !== y) return x < y ? -1 : 1;
  if (a.id == null || b.id == null) return 0;
  return compareMessageIds(a.id, b.id);
}

/**
 * Reads a cursor back for conversation `target` (its id, with ";messageid=…" for a thread).
 * Throws unless it points at exactly that conversation's messages on chatsvc: a caller can't
 * steer the request (and the session's tokens) at another path.
 */
export function readMessagesCursor(cursor, target) {
  const invalid = () => new Error("Not a valid cursor for this conversation. Pass olderCursor exactly as the previous read_messages call on the same conversation returned it.");
  let p, b, i;
  try {
    ({ p, b, i } = JSON.parse(fromBase64Url(String(cursor))));
  } catch {
    throw invalid();
  }
  if (typeof p !== "string" || !p.startsWith("/v1/users/ME/conversations/") || /[\\\s#]/.test(p)) throw invalid();
  if (b != null && (typeof b !== "string" || Number.isNaN(Date.parse(b)))) throw invalid();
  if (i != null && (typeof i !== "string" || i.length > 128)) throw invalid();
  let url;
  try {
    url = new URL(p, "https://cursor.invalid");
  } catch {
    throw invalid();
  }
  // The path as given, unchanged by URL normalization (no "..", "%2e%2e" or fragment).
  const segs = url.pathname.split("/");
  let id = null;
  try {
    id = decodeURIComponent(segs[5] ?? "");
  } catch {
    // not percent-encoded properly
  }
  const ok = url.origin === "https://cursor.invalid" && url.pathname === p.split("?")[0] && segs.length === 7 && segs[6] === "messages" && id === String(target);
  if (!ok) throw invalid();
  return { path: p, before: b ?? null, id: i ?? null };
}

// ------------------------------------------------------------ bridge pairing

/** HMAC-SHA256 of `${role}:${nonce}` with the pairing token, base64url (the server's proof() in src/bridge.ts). */
export async function pairingProof(token, role, nonce) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${role}:${nonce}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------ people

/** "8:orgid:<guid>" (or a contact URL ending in it) -> the MRI. */
export function mriOf(value) {
  if (!value) return null;
  const s = String(value);
  const i = s.lastIndexOf("/contacts/");
  return decodeURIComponent(i === -1 ? s : s.slice(i + "/contacts/".length));
}

export const oidOf = (mri) => /^8:orgid:([0-9a-f-]{36})$/i.exec(mri ?? "")?.[1]?.toLowerCase() ?? null;

/** Short profiles (mt fetchShortProfile) as people. */
export function parseProfiles(json) {
  const list = Array.isArray(json) ? json : (json?.value ?? []);
  return list.map((p) => ({
    mri: p.mri ?? (p.objectId ? `8:orgid:${p.objectId}` : null),
    name: p.displayName ?? null,
    email: p.email ?? p.userPrincipalName ?? null,
    ...(p.jobTitle ? { jobTitle: p.jobTitle } : {}),
    ...(p.department ? { department: p.department } : {}),
    ...(p.userType && p.userType !== "Member" ? { userType: p.userType } : {}),
  }));
}

/** People from substrate's suggestions API. */
export function parseSuggestions(json) {
  const groups = json?.Groups ?? json?.groups ?? [];
  const out = [];
  for (const g of groups) {
    for (const s of g.Suggestions ?? g.suggestions ?? []) {
      if ((s.EntityType ?? s.entityType) && !/people/i.test(s.EntityType ?? s.entityType)) continue;
      const email = s.EmailAddresses?.[0] ?? s.UserPrincipalName ?? s.emailAddresses?.[0] ?? null;
      const oid = (s.ExternalDirectoryObjectId ?? s.externalDirectoryObjectId ?? "").toLowerCase() || null;
      out.push({
        name: s.DisplayName ?? s.displayName ?? null,
        email,
        mri: s.MRI ?? (oid ? `8:orgid:${oid}` : null),
        // OrganizationUser: in your organization; ImplicitContact: someone you have mailed with.
        ...(s.PeopleSubtype ? { relation: s.PeopleSubtype === "OrganizationUser" ? "organization" : "contact" } : {}),
        ...(s.JobTitle ? { jobTitle: s.JobTitle } : {}),
        ...(s.Department ? { department: s.Department } : {}),
        ...(s.CompanyName ? { company: s.CompanyName } : {}),
        ...(s.OfficeLocation ? { office: s.OfficeLocation } : {}),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ message content

/** Teams' fallback text for adaptive cards (e.g. from bots), shortened to "[card]". */
const CARD_FALLBACK = /Card - access it on https:\/\/go\.skype\.com\/cards\.unsupported\s*\.?\s*(Card\s+\S+\s*)?/gi;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Message HTML as plain text: paragraphs and line breaks kept, links as "text (url)" when
 * they differ, emoji as their character, a quoted reply as "> " lines.
 */
export function htmlToText(html) {
  let s = String(html ?? "");
  if (!/[<&]/.test(s)) return s.replace(CARD_FALLBACK, "[card] ").trim();
  s = s
    // Line breaks in HTML source are just spaces; tags decide where lines break.
    .replace(/\s*[\r\n]\s*/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // Pasted pictures; emoji and stickers are images whose alt text is the emoji.
    .replace(/<img[^>]*>/gi, (tag) =>
      /AMSImage/i.test(tag) || !/\balt="/i.test(tag) ? "[image]" : decodeEntities(/\balt="([^"]*)"/i.exec(tag)[1]),
    )
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "");
      const url = decodeEntities(href);
      return decodeEntities(label).trim() === url || !/^https?:/i.test(url) ? label : `${label} (${href})`;
    })
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
      const quoted = htmlToText(inner);
      return `\n${quoted.split("\n").map((l) => `> ${l}`).join("\n")}\n`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .replace(CARD_FALLBACK, "[card] ")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of an Adaptive Card: one line per block, a ColumnSet's columns on one line. */
export function adaptiveCardText(card) {
  const lines = [];
  const inline = (el) => {
    if (!el || typeof el !== "object") return "";
    switch (el.type) {
      case "TextBlock":
      case "Badge":
        return String(el.text ?? "");
      case "RichTextBlock":
        return (el.inlines ?? []).map((i) => (typeof i === "string" ? i : (i.text ?? ""))).join("");
      case "FactSet":
        return (el.facts ?? []).map((f) => `${f.title}: ${f.value}`).join("\n");
      case "ColumnSet":
        return (el.columns ?? []).map(inline).filter(Boolean).join(" · ");
      case "Column":
      case "Container":
        return (el.items ?? []).map(inline).filter(Boolean).join(" ");
      default:
        return "";
    }
  };
  const block = (el) => {
    if (el?.type === "Container") return (el.items ?? []).forEach(block);
    const t = inline(el).trim();
    if (t) lines.push(t);
  };
  for (const el of card?.body ?? []) block(el);
  return lines.join("\n");
}

/** Message content as text: cards (base64 JSON in a <Swift> element) by their text, else the HTML. */
export function contentToText(content) {
  const b64 = /<Swift\b[^>]*\bb64="([^"]+)"/i.exec(String(content ?? ""))?.[1];
  if (b64) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const swift = JSON.parse(new TextDecoder().decode(bytes));
      const texts = (swift.attachments ?? []).map((a) => adaptiveCardText(a.content)).filter(Boolean);
      if (texts.length) return `[card]\n${texts.join("\n\n")}`;
    } catch {
      // Not a card we can read: fall back to its HTML.
    }
  }
  return htmlToText(content);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Plain text (as the AI writes it) as Teams message HTML: one paragraph per line, links clickable. */
export function textToHtml(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const linked = escapeHtml(line).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
      return `<p>${linked || "&nbsp;"}</p>`;
    })
    .join("");
}

/** A property that chatsvc sends as a JSON string or as the value itself. */
function jsonProp(v) {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const isoTime = (v) => {
  if (!v) return null;
  const d = new Date(/^\d+$/.test(String(v)) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The root message a channel reply belongs to (from ";messageid=<id>" in its conversation link). */
export function threadRootOf(m) {
  const link = m.conversationLink ?? m.conversationid ?? "";
  return /;messageid=(\d+)/.exec(link)?.[1] ?? m.properties?.parentMessageId ?? m.parentMessageId ?? null;
}

const SYSTEM_TYPES = /^(ThreadActivity\/|Event\/|RichText\/Media_CallRecording|Control\/)/i;

/** One chatsvc message, in the shape the tools return. */
export function parseMessage(m) {
  const p = m.properties ?? {};
  const type = m.messagetype ?? m.messageType ?? "";
  const deleted = !!(p.deletetime || m.deletetime);
  const files = (jsonProp(p.files) ?? []).map((f) => ({
    name: f.fileName ?? f.title ?? null,
    url: f.fileInfo?.shareUrl ?? f.fileInfo?.fileUrl ?? f.objectUrl ?? null,
    ...(f.fileType ? { type: f.fileType } : {}),
  }));
  const reactions = (jsonProp(p.emotions) ?? [])
    .map((e) => ({ reaction: e.key, count: (e.users ?? []).length }))
    .filter((r) => r.count);
  const html = /html/i.test(type) || /^RichText/i.test(type);
  const subject = p.subject || m.subject || null;
  const out = {
    id: String(m.id ?? m.clientmessageid ?? ""),
    time: isoTime(m.originalarrivaltime ?? m.composetime ?? m.composeTime),
    from: { name: m.imdisplayname ?? m.imDisplayName ?? null, mri: mriOf(m.from) },
    ...(subject ? { subject } : {}),
    text: deleted ? "" : html ? contentToText(m.content) : String(m.content ?? "").trim(),
    ...(deleted ? { deleted: true } : {}),
    ...(p.edittime ? { edited: isoTime(p.edittime) } : {}),
    ...(files.length ? { files } : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(p.importance && p.importance !== "normal" ? { importance: p.importance } : {}),
  };
  if (SYSTEM_TYPES.test(type)) out.system = type;
  return out;
}

/**
 * chatsvc messages (newest first, as returned) as a conversation: oldest first, system
 * events dropped unless asked for. Channel replies are nested under their post.
 */
export function buildConversation(raw, { includeSystem = false, channel = false } = {}) {
  return group(ordered(raw, includeSystem), channel);
}

/** Parsed messages, oldest first by compareMessageKeys, each with its channel `root`. */
const ordered = (raw, includeSystem) =>
  raw
    .map((m) => ({ ...parseMessage(m), root: threadRootOf(m) }))
    .filter((m) => includeSystem || !m.system)
    .sort(compareMessageKeys);

/**
 * buildConversation's newest `limit` entries (channel: posts, and replies whose post is
 * not among them). Cuts the ordered messages so that every message after the cut is
 * returned and none before it: `oldest` is the { time, id } of the oldest one returned,
 * and a later page takes exactly what is older (compareMessageKeys). In a channel, a reply
 * newer than the cut to a post older than it comes as a reply with `replyTo` on this page,
 * and its post on a later one.
 */
export function newestEntries(raw, { limit, includeSystem = false, channel = false }) {
  const msgs = ordered(raw, includeSystem);
  let start = Math.max(0, msgs.length - limit);
  if (channel) {
    // Entries the messages from i on make: each post and each reply whose post is older
    // than i. Take the longest run of newest messages that makes at most `limit`.
    const waiting = new Map(); // post id -> replies after it, counted as entries until the post joins
    let entries = 0;
    start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.root && m.root !== m.id) {
        entries++;
        waiting.set(m.root, (waiting.get(m.root) ?? 0) + 1);
      } else {
        entries += 1 - (waiting.get(m.id) ?? 0);
        waiting.delete(m.id);
      }
      if (entries <= limit) start = i;
    }
  }
  const kept = msgs.slice(start);
  return { messages: group(kept, channel), more: start > 0, oldest: kept.length ? { time: kept[0].time, id: kept[0].id } : null };
}

function group(msgs, channel) {
  if (!channel) return msgs.map(({ root, ...m }) => m);
  const posts = [];
  const byId = new Map();
  for (const { root, ...m } of msgs) {
    if (root && root !== m.id) {
      const parent = byId.get(root);
      if (parent) {
        (parent.replies ??= []).push(m);
        continue;
      }
      // Its post is older than what was read: keep the reply, saying which post it answers.
      posts.push({ ...m, replyTo: root });
      continue;
    }
    byId.set(m.id, m);
    posts.push(m);
  }
  return posts;
}

/** The first `n` UTF-16 units of `text`, one fewer if the last would be half a surrogate pair (an emoji). */
export function cutAt(text, n) {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Cuts each message's text (replies too) to `maxLength` UTF-16 units plus "…", marking it
 * `truncated`; never through an emoji. The server cuts the same way, for extensions older than this.
 */
export function capText(messages, maxLength) {
  if (!maxLength) return messages;
  const cut = (m) => {
    const r = m.text.length > maxLength ? { ...m, text: `${cutAt(m.text, maxLength)}…`, truncated: true } : m;
    return r.replies ? { ...r, replies: r.replies.map(cut) } : r;
  };
  return messages.map(cut);
}

// ------------------------------------------------------------ teams and chats

const kindOf = (id, t = {}) => {
  const type = `${t.productThreadType ?? ""} ${t.threadType ?? ""} ${t.chatType ?? ""}`.toLowerCase();
  if (/meeting/.test(type)) return "meeting";
  if (/onetoone|oneonone/.test(type) || /@unq\.gbl\.spaces$/.test(id)) return "oneOnOne";
  if (/channel|topic|space/.test(type) || /@thread\.(tacv2|skype)$/.test(id)) return "channel";
  if (/^48:/.test(id)) return "self";
  return "group";
};

/** Teams and their channels from csa's teams/users/me. */
export function parseTeams(json) {
  return (json?.teams ?? []).map((t) => ({
      id: t.id,
      name: t.displayName ?? t.name ?? null,
      ...(t.isArchived ? { archived: true } : {}),
      channels: (t.channels ?? [])
        .filter((c) => !c.isDeleted)
        .map((c) => ({
          id: c.id,
          name: c.displayName ?? c.name ?? null,
          ...(c.isGeneral ? { general: true } : {}),
          ...(c.membershipType && c.membershipType !== "standard" ? { membership: c.membershipType } : {}),
          ...(c.isFavorite === false || c.isHidden ? { hidden: true } : {}),
        })),
    }));
}

const lastMessageOf = (lm) =>
  lm && (lm.content || lm.imdisplayname || lm.composetime)
    ? {
        from: lm.imdisplayname ?? lm.imDisplayName ?? null,
        time: isoTime(lm.originalarrivaltime ?? lm.originalArrivalTime ?? lm.composetime ?? lm.composeTime),
        preview: contentToText(lm.content ?? "").replace(/^\[card\]\n/, "[card] ").slice(0, 200),
      }
    : null;

/**
 * Chats from csa's chat list. Each keeps its member MRIs, so the caller can look up
 * names for chats without a title.
 */
export function parseCsaChats(json) {
  return (json?.chats ?? [])
    .filter((c) => !c.isConversationDeleted)
    .map((c) => ({
      id: c.id,
      title: c.title || null,
      kind: c.isOneOnOne ? "oneOnOne" : kindOf(c.id, { chatType: c.chatType, threadType: c.threadType }),
      members: (c.members ?? []).map((m) => m.mri ?? m.id).filter(Boolean),
      lastMessage: lastMessageOf(c.lastMessage),
      lastFrom: mriOf(c.lastMessage?.from),
      unread: c.isRead === false || undefined,
    }));
}

/** Conversations from chatsvc's conversation list (chats and channels together). */
export function parseConversations(json) {
  return (json?.conversations ?? []).map((c) => {
    const t = c.threadProperties ?? {};
    const lm = c.lastMessage ?? {};
    const horizon = String(c.properties?.consumptionhorizon ?? "").split(";")[0];
    const last = Number(lm.id ?? 0);
    return {
      id: c.id,
      title: t.topic || t.spaceThreadTopic || null,
      kind: kindOf(c.id, t),
      members: [],
      lastMessage: lastMessageOf(lm),
      unread: last && horizon && Number(horizon) < last && mriOf(lm.from) !== null ? true : undefined,
    };
  });
}

/** A chat's title: its topic, else the other members' names. */
export function chatTitle(chat, names, meMri) {
  if (chat.title) return chat.title;
  const others = chat.members.filter((m) => m !== meMri).map((m) => names.get(m) ?? null).filter(Boolean);
  if (others.length) return others.length > 4 ? `${others.slice(0, 4).join(", ")} +${others.length - 4}` : others.join(", ");
  if (chat.kind === "self") return "(notes to self)";
  // A 1:1 chat with someone we can't look up (e.g. a bot): the name on their last message.
  if (chat.kind === "oneOnOne" && chat.lastFrom && chat.lastFrom !== meMri) return chat.lastMessage?.from ?? null;
  return null;
}

/** "a b" matches a text containing every word, ignoring case. */
export function matchesWords(text, query) {
  const t = String(text ?? "").toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

/**
 * Finds the one conversation a name means. `query` is an id ("19:…"), "Team/Channel",
 * or a chat title / member name. Exact matches beat partial ones; several equally good
 * matches are an error that lists them.
 */
export function resolveConversation(query, { teams = [], chats = [] }) {
  const q = String(query).trim();
  if (/^(19|48):/.test(q)) return { id: q.split(";messageid=")[0], kind: /@thread\.(tacv2|skype)$/.test(q) ? "channel" : null, title: null };
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const candidates = [];
  for (const t of teams) {
    for (const c of t.channels) {
      candidates.push({ id: c.id, kind: "channel", title: `${t.name}/${c.name}`, team: t.name, channel: c.name, teamId: t.id });
    }
  }
  for (const c of chats) candidates.push({ id: c.id, kind: c.kind, title: c.title, memberNames: c.memberNames ?? [] });

  const slash = q.lastIndexOf("/");
  const exact = candidates.filter(
    (c) =>
      norm(c.title) === norm(q) ||
      (c.kind === "channel" && slash > 0 && norm(c.team) === norm(q.slice(0, slash)) && norm(c.channel) === norm(q.slice(slash + 1))) ||
      // A 1:1 chat by the other person's name.
      (c.kind === "oneOnOne" && c.memberNames?.some((n) => norm(n) === norm(q))),
  );
  const partial = exact.length
    ? exact
    : candidates.filter((c) => matchesWords(c.title, q) || (c.kind === "oneOnOne" && c.memberNames?.some((n) => matchesWords(n, q))));
  // A 1:1 chat beats a group chat that happens to include the same person.
  const pick = partial.length > 1 && partial.filter((c) => c.kind === "oneOnOne").length === 1 ? partial.filter((c) => c.kind === "oneOnOne") : partial;
  if (pick.length === 1) {
    const { memberNames, ...c } = pick[0];
    return c;
  }
  if (!pick.length) throw new Error(`No chat or channel matches "${q}". Use list_chats or list_teams to find it.`);
  const shown = pick.slice(0, 10).map((c) => `${c.title ?? "(untitled)"} [${c.kind}] ${c.id}`);
  throw new Error(`"${q}" matches ${pick.length} conversations; give one of these ids:\n${shown.join("\n")}`);
}

// ------------------------------------------------------------ search

/** Teams messages from substrate search (v2 query). */
export function parseSearch(json) {
  const sets = json?.EntitySets ?? json?.entitySets ?? [];
  const out = [];
  let total = 0;
  for (const set of sets) {
    for (const rs of set.ResultSets ?? set.resultSets ?? []) {
      total += rs.Total ?? rs.total ?? 0;
      for (const r of rs.Results ?? rs.results ?? []) {
        const s = r.Source ?? r.source ?? {};
        const ext = s.Extensions ?? s.extensions ?? {};
        out.push({
          conversationId: s.ClientThreadId ?? s.ClientConversationId?.split(";")[0] ?? null,
          messageId: /;messageid=(\d+)/.exec(s.ClientConversationId ?? "")?.[1] ?? s.InternetMessageId ?? null,
          time: isoTime(s.DateTimeReceived ?? s.DateTimeSent ?? s.CreatedDateTime),
          from: s.From?.EmailAddress?.Name ?? s.Sender?.EmailAddress?.Name ?? null,
          fromEmail: s.From?.EmailAddress?.Address ?? null,
          fromMri: ext.SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId ?? null,
          ...(ext.SkypeSpaces_ConversationPost_Extension_ThreadType ? { threadType: ext.SkypeSpaces_ConversationPost_Extension_ThreadType } : {}),
          ...(s.ConversationTopic || ext.SkypeSpaces_ConversationPost_Extension_Topic ? { topic: s.ConversationTopic || ext.SkypeSpaces_ConversationPost_Extension_Topic } : {}),
          ...(ext.SkypeSpaces_ConversationPost_Extension_ChannelName ? { channel: ext.SkypeSpaces_ConversationPost_Extension_ChannelName } : {}),
          text: htmlToText(r.HitHighlightedSummary ?? s.Preview ?? s.Summary ?? "")
            .replace(/<\/?c0>/g, "")
            .replace(/[ \t]{2,}/g, " "),
        });
      }
    }
  }
  return { total, results: out };
}

/** A client message id like Teams uses: 19 random digits. */
export function clientMessageId() {
  let s = String(1 + Math.floor(Math.random() * 9));
  while (s.length < 19) s += Math.floor(Math.random() * 10);
  return s;
}

// ------------------------------------------------------------ new chats

/** Letters and digits of a name as a sorted set of words: "Novak, Jana" ~ "Jana Novak". */
const nameWords = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");

/** A display name's forms: whole, without "(…)", and each "(…)" part ("김민준(KIM MIN JUN)", "Novak, Jana (QA)"). */
const nameForms = (name) => {
  const s = String(name ?? "");
  const inner = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  return [s, s.replace(/\([^)]*\)/g, " "), ...inner].map(nameWords).filter(Boolean);
};

export const sameName = (name, query) => nameForms(name).includes(nameWords(query));

/**
 * The one person a name or address means, from people search results. An email matches
 * exactly; a name wins when it is the only result or the only exact full-name match.
 * People without a Teams id (MRI) can't be added to a chat.
 */
export function pickPerson(query, people, meMri) {
  const q = String(query).trim();
  const found = people.filter((p) => p.mri !== meMri);
  const isEmail = /^[^\s@]+@[^\s@]+$/.test(q);
  let matches = isEmail
    ? found.filter((p) => p.email?.toLowerCase() === q.toLowerCase())
    : found.length === 1
      ? found
      : found.filter((p) => sameName(p.name, q));
  if (!matches.length && !isEmail && found.length > 1) {
    const list = found.slice(0, 8).map((p) => `${p.name} <${p.email ?? "?"}>`);
    throw new Error(`"${q}" matches ${found.length} people; give a full name or an email address:\n${list.join("\n")}`);
  }
  if (!matches.length) throw new Error(`Nobody found for "${q}". Use find_people to look them up.`);
  if (matches.length > 1) {
    throw new Error(`"${q}" matches ${matches.length} people; give an email address:\n${matches.map((p) => `${p.name} <${p.email ?? "?"}>`).join("\n")}`);
  }
  const p = matches[0];
  if (!p.mri) {
    throw new Error(`${p.name} <${p.email ?? "?"}> has no Teams account that can be reached from yours (e.g. outside your organization), so no chat can be started with them.`);
  }
  return p;
}

/** The id Teams gives the 1:1 chat between two users: both object ids, sorted. */
export function oneOnOneId(mriA, mriB) {
  const [a, b] = [oidOf(mriA), oidOf(mriB)];
  if (!a || !b) return null;
  return `19:${[a, b].sort().join("_")}@unq.gbl.spaces`;
}

/** An existing chat with exactly these people (and me): the 1:1 for one person, else an untitled-or-matching group. */
export function findExistingChat(chats, memberMris, meMri, title) {
  const want = [...new Set([...memberMris, meMri])].sort().join("|");
  return (
    chats.find((c) => {
      if (c.kind === "meeting" || c.kind === "channel") return false;
      if (memberMris.length === 1 ? c.kind !== "oneOnOne" : c.kind === "oneOnOne") return false;
      if (memberMris.length > 1 && title && (c.title ?? "").toLowerCase() !== title.toLowerCase()) return false;
      return [...new Set(c.members)].sort().join("|") === want;
    }) ?? null
  );
}

/** The new thread's id from chatsvc's answer to creating it (Location header or body). */
export function threadIdFrom(location, json) {
  const fromLocation = /\/threads\/([^/?]+)/.exec(location ?? "")?.[1];
  const id = fromLocation ? decodeURIComponent(fromLocation) : (json?.id ?? json?.threadId ?? null);
  return id && /^19:/.test(id) ? id : null;
}

// ------------------------------------------------------------ traffic log (diagnostic)

/** Hosts the Teams web app calls besides its own origin; observed for the api_traffic log only. */
export const TRAFFIC_URLS = [
  "https://*.cloud.microsoft/*",
  "https://*.microsoft.com/*",
  "https://*.office.com/*",
  "https://*.office.net/*",
  "https://*.sharepoint.com/*",
  "https://*.svc.ms/*",
  "https://*.skype.com/*",
];

const TEAMS_ORIGIN = /^https:\/\/(teams\.cloud\.microsoft|teams\.microsoft\.com)$/i;

/** Whether a request comes from the Teams web app (its page or its workers). */
export const isTeamsOrigin = (origin) => TEAMS_ORIGIN.test(origin ?? "");

/** How a request authenticates, without revealing any secret. */
export function authScheme(headers) {
  const get = (n) => headers.find((h) => h.name.toLowerCase() === n)?.value;
  const auth = get("authorization");
  if (auth) return auth.split(/[ =]/)[0].toLowerCase();
  if (get("authentication")) return "authentication:" + get("authentication").split("=")[0].toLowerCase();
  if (get("x-skypetoken")) return "x-skypetoken";
  if (get("cookie")) return "cookie";
  return "none";
}

/** Describes one outgoing request for the traffic log: names only, never header or query values, which can carry tokens. */
export function summarizeRequest(details) {
  const url = new URL(details.url);
  const headers = details.requestHeaders ?? [];
  const path = url.pathname.slice(0, 300);
  return {
    key: `${details.method} ${url.host}${path}`,
    method: details.method,
    host: url.host,
    path,
    queryParams: [...new Set(url.searchParams.keys())].sort(),
    headerNames: [...new Set(headers.map((h) => h.name.toLowerCase()))].sort(),
    auth: authScheme(headers),
    type: details.type,
  };
}

export const MAX_TRAFFIC = 400;

/** Adds a request to the log (deduplicated by method + URL path), newest last. */
export function recordTraffic(list, entry, at = Date.now()) {
  const old = list.find((e) => e.key === entry.key);
  const rest = list.filter((e) => e.key !== entry.key);
  return [...rest, { ...old, ...entry, count: (old?.count ?? 0) + 1, lastAt: at }].slice(-MAX_TRAFFIC);
}

/** Records the response status for the request with this key. */
export function recordStatus(list, key, status) {
  return list.map((e) => (e.key === key ? { ...e, status } : e));
}

/** Newest first, optionally only entries whose host or path contains `filter`. */
export function filterTraffic(list, { filter, limit = 100 } = {}) {
  const needle = filter?.toLowerCase();
  return list
    .filter((e) => !needle || `${e.host}${e.path}`.toLowerCase().includes(needle))
    .reverse()
    .slice(0, limit)
    .map(({ key, ...e }) => ({ ...e, lastAt: new Date(e.lastAt).toISOString() }));
}

// ------------------------------------------------------------ meetings

/** The tenant most of the user's non-meeting chats live in: their own organization's. */
export function homeTenant(csaJson) {
  const count = new Map();
  for (const c of csaJson?.chats ?? []) {
    if (c.chatType === "meeting" || !c.tenantId) continue;
    count.set(c.tenantId, (count.get(c.tenantId) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Meeting chats from csa with their scheduled meeting. Another organization's meeting
 * chats (`external`) can usually no longer be read once the meeting is over.
 */
export function parseCsaMeetings(csaJson) {
  const home = homeTenant(csaJson);
  return (csaJson?.chats ?? [])
    .filter((c) => c.chatType === "meeting" && !c.isConversationDeleted)
    .map((c) => {
      const mi = c.meetingInformation ?? {};
      return {
        id: c.id,
        title: mi.subject || c.title || null,
        start: mi.startTime ?? null,
        end: mi.endTime ?? null,
        recurring: mi.eventRecurrencePattern ? true : undefined,
        cancelled: mi.isCancelled || undefined,
        organizer: mi.organizerId ? `8:orgid:${mi.organizerId}` : null,
        hasTranscript: c.meetingObjectsConfig?.configurations?.transcriptConfig?.hasTranscript || undefined,
        external: home && c.tenantId && c.tenantId !== home ? true : undefined,
        joinUrl: mi.meetingJoinUrl ?? null,
        lastActivity: lastMessageOf(c.lastMessage)?.time ?? c.lastJoinAt ?? null,
        lastJoinAt: c.lastJoinAt ?? null,
      };
    });
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]).trim() : null;
};
const attr = (xml, element, name) => {
  const m = new RegExp(`<${element}\\b[^>]*?\\b${name}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
};

/** "07/21/2026 07:00:00" or "10/06/2026 07:00:00 +00:00" (UTC) as ISO time. */
export function callTime(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? "").trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** An Event/Call message: who took part and for how long, and which meeting occurrence. */
export function parseCallEvent(m) {
  const c = m.content ?? "";
  const type = tag(c, "callEventType") ?? (/<ended\s*\/>/.test(c) ? "callEnded" : null);
  const parts = [...c.matchAll(/<part\b[^>]*identity="([^"]*)"[^>]*>([\s\S]*?)<\/part>/g)].map(([, identity, body]) => ({
    mri: decodeEntities(identity),
    name: tag(body, "displayName") || null,
    seconds: tag(body, "duration") ? Number(tag(body, "duration")) : null,
  }));
  const instance = /<instanceDetails>([\s\S]*?)<\/instanceDetails>/.exec(c)?.[1] ?? "";
  return {
    callId: tag(c, "callId") ?? m.properties?.skypeguid ?? null,
    type,
    at: m.originalarrivaltime ?? m.composetime ?? null,
    callStart: callTime(tag(c, "conversationStartTime")),
    subject: tag(instance, "subject") ?? null,
    scheduledStart: callTime(tag(instance, "startTime")),
    scheduledEnd: callTime(tag(instance, "endTime")),
    organizerUpn: tag(c, "organizerUpn"),
    participants: parts,
  };
}

/** "1:10:47.42" as seconds. */
const hms = (s) => {
  const p = String(s ?? "").split(":").map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? Math.round(p[0] * 3600 + p[1] * 60 + p[2]) : null;
};

/** A finished recording or transcript (RichText/Media_CallRecording) and where its files are. */
export function parseRecording(m) {
  const c = m.content ?? "";
  const status = attr(c, "RecordingStatus", "status");
  if (status !== "Success") return null; // progress notes while the call runs
  const item = (type) => {
    const r = new RegExp(`<item\\b[^>]*type="${type}"[^>]*>`).exec(c)?.[0];
    return r ? attr(r, "item", "uri") || null : null;
  };
  const contentTypes = attr(c, "RecordingContent", "contentTypes") ?? "";
  return {
    callId: /<Id type="callId" value="([^"]*)"/.exec(c)?.[1] ?? null,
    at: m.originalarrivaltime ?? null,
    title: tag(c, "Title"),
    started: attr(c, "RecordingContent", "timestamp"),
    seconds: hms(attr(c, "RecordingContent", "duration")),
    video: /Recording/.test(contentTypes) ? item("onedriveForBusinessVideo") : null,
    transcriptUrl: item("onedriveForBusinessTranscript"),
  };
}

/** "2026-10-06T08:06:54.0570000Z" as "2026-10-06T08:06:54Z". */
const isoSeconds = (t) => (t ? String(t).replace(/\.\d+Z$/, "Z") : null);

/**
 * The calls of a meeting chat, oldest first: when, who took part, and
 * the recording and transcript made in it.
 */
export function meetingSessions(rawMessages) {
  const byCall = new Map();
  const get = (id) => {
    if (!byCall.has(id)) byCall.set(id, { callId: id, participants: [], recordings: [] });
    return byCall.get(id);
  };
  for (const m of rawMessages) {
    if (m.messagetype === "Event/Call") {
      const e = parseCallEvent(m);
      if (!e.callId) continue;
      const s = get(e.callId);
      s.subject ??= e.subject;
      s.scheduledStart ??= e.scheduledStart;
      s.scheduledEnd ??= e.scheduledEnd;
      if (e.callStart) s.start = e.callStart;
      if (e.type === "callStarted" && !s.start) s.start = isoSeconds(e.at);
      if (e.type === "callEnded") {
        s.end = isoSeconds(e.at);
        s.participants = e.participants;
      }
    } else if (m.messagetype === "RichText/Media_CallRecording") {
      const r = parseRecording(m);
      if (r?.callId) get(r.callId).recordings.push(r);
    }
  }
  return [...byCall.values()]
    .map((s) => ({
      callId: s.callId,
      subject: s.subject ?? s.recordings[0]?.title ?? null,
      start: s.start ?? null,
      end: s.end ?? null,
      minutes: s.start && s.end ? Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000) : null,
      ...(s.scheduledStart ? { scheduled: { start: s.scheduledStart, end: s.scheduledEnd } } : {}),
      // Teams reports the call's length for every participant, so only who joined is known.
      attendees: s.participants.map((p) => p.name ?? p.mri),
      recording: s.recordings.find((r) => r.video)?.video ?? null,
      transcript: s.recordings.some((r) => r.transcriptUrl),
      transcriptUrl: s.recordings.find((r) => r.transcriptUrl)?.transcriptUrl ?? null,
    }))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

/** "00:01:06.5193352" as "00:01:06". */
const offset = (s) => String(s ?? "").split(".")[0] || "00:00:00";
const seconds = (s) => hms(offset(s)) ?? 0;

/**
 * A Teams transcript (Stream transcript.json) as lines "[hh:mm:ss] Speaker: text", with
 * consecutive entries of one speaker joined. `fromSeconds` skips what was said before.
 */
export function transcriptLines(json, { fromSeconds = 0 } = {}) {
  const lines = [];
  let last = null;
  for (const e of json?.entries ?? []) {
    const text = String(e.text ?? "").trim();
    if (!text || seconds(e.startOffset) < fromSeconds) continue;
    const who = e.speakerDisplayName || "Unknown";
    if (last && last.who === who) {
      last.text += ` ${text}`;
      continue;
    }
    last = { at: offset(e.startOffset), who, text };
    lines.push(last);
  }
  return lines.map((l) => `[${l.at}] ${l.who}: ${l.text}`);
}

/** Speakers of a transcript with how long each spoke, most first. */
export function transcriptSpeakers(json) {
  const total = new Map();
  for (const e of json?.entries ?? []) {
    const who = e.speakerDisplayName || "Unknown";
    total.set(who, (total.get(who) ?? 0) + Math.max(0, seconds(e.endOffset) - seconds(e.startOffset)));
  }
  return [...total].sort((a, b) => b[1] - a[1]).map(([name, s]) => ({ name, minutes: Math.round(s / 6) / 10 }));
}

/**
 * Lines of a transcript that contain all words of `query` (case-insensitive), each with
 * the line before it for context, as "[hh:mm:ss] Speaker: text".
 */
export function searchTranscript(json, query) {
  const lines = transcriptLines(json);
  const hits = [];
  lines.forEach((line, i) => {
    const said = line.replace(/^\[[\d:]+\] [^:]*: /, "");
    if (!matchesWords(said, query)) return;
    hits.push(i > 0 ? { before: lines[i - 1], line } : { line });
  });
  return hits;
}
