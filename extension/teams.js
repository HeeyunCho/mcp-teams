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
  const msgs = raw
    .map((m) => ({ ...parseMessage(m), root: threadRootOf(m) }))
    .filter((m) => includeSystem || !m.system)
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
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
