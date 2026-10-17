import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the extension
import * as teams from "../../extension/teams.js";
// @ts-expect-error plain JS script without types
import { nextVersion } from "../../scripts/bump-version.mjs";

const OID = "99999999-8888-4777-8666-555555555555";

describe("session capture", () => {
  it("knows each Teams service and its base URL", () => {
    expect(teams.serviceOf("https://teams.cloud.microsoft/api/chatsvc/kr/v1/users/ME/properties")).toEqual({
      service: "chatsvc",
      base: "https://teams.cloud.microsoft/api/chatsvc/kr",
      region: "kr",
    });
    expect(teams.serviceOf(`https://teams.cloud.microsoft/api/mt/apac/beta/users/${OID}/profilepicturev2/8:orgid:x`)).toEqual({
      service: "mt",
      base: "https://teams.cloud.microsoft/api/mt/apac",
      region: "apac",
      oid: OID,
    });
    expect(teams.serviceOf("https://teams.microsoft.com/api/csa/emea/api/v1/teams/users/me")?.base).toBe(
      "https://teams.microsoft.com/api/csa/emea",
    );
    expect(teams.serviceOf("https://kr.ng.msg.teams.microsoft.com/v1/users/ME/conversations")).toMatchObject({
      service: "chatsvc",
      base: "https://kr.ng.msg.teams.microsoft.com",
    });
    expect(teams.serviceOf("https://substrate.office.com/search/api/v1/suggestions")).toEqual({
      service: "substrate",
      base: "https://substrate.office.com",
    });
    expect(teams.serviceOf("https://teams.cloud.microsoft/v2/")).toBeNull();
    expect(teams.serviceOf("not a url")).toBeNull();
  });

  it("keeps only the credential headers, and only from requests that carry credentials", () => {
    const h = (name: string, value: string) => ({ name, value });
    expect(teams.pickHeaders([h("Authorization", "Bearer x"), h("Cookie", "c"), h("x-ms-client-version", "1")])).toEqual({
      authorization: "Bearer x",
      "x-ms-client-version": "1",
    });
    expect(teams.pickHeaders([h("Authentication", "skypetoken=y")])).toEqual({ authentication: "skypetoken=y" });
    expect(teams.pickHeaders([h("x-ms-client-version", "1")])).toBeNull();
  });

  it("moves chatsvc paging links onto the base we send requests to", () => {
    expect(
      teams.rebase("https://kr.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aa/messages?syncState=s", "https://teams.cloud.microsoft/api/chatsvc/kr"),
    ).toBe("https://teams.cloud.microsoft/api/chatsvc/kr/v1/users/ME/conversations/19%3Aa/messages?syncState=s");
  });
});

describe("message content", () => {
  it("turns message HTML into readable text", () => {
    const html =
      '<p>Hi <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Ana</span>,</p><p>see <a href="https://x.com/doc">the doc</a> &amp; <a href="https://x.com">https://x.com</a> <img alt="😀" src="e.png"></p><ul><li>one</li><li>two</li></ul>';
    expect(teams.htmlToText(html)).toBe("Hi Ana,\n\nsee the doc (https://x.com/doc) & https://x.com 😀\n\n• one\n• two");
  });

  it("shows a quoted reply as > lines", () => {
    const html = '<blockquote itemtype="http://schema.skype.com/Reply"><strong>Bo</strong><p>original</p></blockquote><p>answer</p>';
    expect(teams.htmlToText(html)).toBe("> Bo\n> original\n\nanswer");
  });

  it("leaves plain text alone and decodes entities", () => {
    expect(teams.htmlToText("  plain  ")).toBe("plain");
    expect(teams.decodeEntities("&lt;a&gt; &#39;b&#x27; &nbsp;")).toBe("<a> 'b'  ");
  });

  it("writes text as escaped HTML paragraphs with clickable links", () => {
    expect(teams.textToHtml("a < b & c\n\nhttps://x.com/p?q=1.")).toBe(
      '<p>a &lt; b &amp; c</p><p>&nbsp;</p><p><a href="https://x.com/p?q=1">https://x.com/p?q=1</a>.</p>',
    );
  });

  it("makes 19-digit client message ids", () => {
    expect(teams.clientMessageId()).toMatch(/^[1-9]\d{18}$/);
  });
});

const msg = (id: string, time: string, extra: Record<string, unknown> = {}) => ({
  id,
  originalarrivaltime: time,
  messagetype: "RichText/Html",
  content: `<p>m${id}</p>`,
  imdisplayname: "Ana Lee",
  from: `https://kr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:${OID}`,
  ...extra,
});

describe("messages", () => {
  it("parses a message with files, reactions, edits", () => {
    const m = teams.parseMessage(
      msg("1", "2026-10-10T08:00:00.000Z", {
        properties: {
          edittime: "1791631460008",
          files: JSON.stringify([{ fileName: "plan.xlsx", fileType: "xlsx", fileInfo: { shareUrl: "https://sp/plan" } }]),
          emotions: [{ key: "like", users: [{ mri: "8:orgid:a" }, { mri: "8:orgid:b" }] }, { key: "heart", users: [] }],
        },
      }),
    );
    expect(m).toEqual({
      id: "1",
      time: "2026-10-10T08:00:00.000Z",
      from: { name: "Ana Lee", mri: `8:orgid:${OID}` },
      text: "m1",
      edited: new Date(1791631460008).toISOString(),
      files: [{ name: "plan.xlsx", url: "https://sp/plan", type: "xlsx" }],
      reactions: [{ reaction: "like", count: 2 }],
    });
  });

  it("empties deleted messages and marks system events", () => {
    expect(teams.parseMessage(msg("2", "2026-10-10T08:00:00Z", { properties: { deletetime: "1" } }))).toMatchObject({ text: "", deleted: true });
    expect(teams.parseMessage(msg("3", "2026-10-10T08:00:00Z", { messagetype: "ThreadActivity/AddMember", content: "<addmember/>" })).system).toBe(
      "ThreadActivity/AddMember",
    );
  });

  it("orders a chat oldest first and drops system events unless asked", () => {
    const raw = [
      msg("3", "2026-10-10T10:00:00Z"),
      msg("2", "2026-10-10T09:00:00Z", { messagetype: "Event/Call" }),
      msg("1", "2026-10-10T08:00:00Z"),
    ];
    expect(teams.buildConversation(raw).map((m: { id: string }) => m.id)).toEqual(["1", "3"]);
    expect(teams.buildConversation(raw, { includeSystem: true }).map((m: { id: string }) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("nests channel replies under their post, and keeps replies whose post wasn't read", () => {
    const ch = "19:abc@thread.tacv2";
    const raw = [
      msg("30", "2026-10-10T10:00:00Z", { conversationLink: `x/${ch};messageid=10` }),
      msg("20", "2026-10-10T09:00:00Z", { conversationLink: `x/${ch};messageid=5` }),
      msg("10", "2026-10-10T08:00:00Z", { conversationLink: `x/${ch};messageid=10` }),
      msg("11", "2026-10-10T08:30:00Z", { conversationLink: `x/${ch}` }),
    ];
    const posts = teams.buildConversation(raw, { channel: true });
    expect(posts.map((p: { id: string }) => p.id)).toEqual(["10", "11", "20"]);
    expect(posts[0].replies.map((r: { id: string }) => r.id)).toEqual(["30"]);
    expect(posts[2].replyTo).toBe("5");
  });
});

describe("teams and chats", () => {
  it("parses teams with their channels", () => {
    const json = {
      teams: [
        {
          id: "19:t@thread.tacv2",
          displayName: "Engineering",
          channels: [
            { id: "19:g@thread.tacv2", displayName: "General", isGeneral: true },
            { id: "19:p@thread.tacv2", displayName: "Secret", membershipType: "private" },
            { id: "19:d@thread.tacv2", displayName: "Gone", isDeleted: true },
          ],
        },
      ],
    };
    expect(teams.parseTeams(json)).toEqual([
      {
        id: "19:t@thread.tacv2",
        name: "Engineering",
        channels: [
          { id: "19:g@thread.tacv2", name: "General", general: true },
          { id: "19:p@thread.tacv2", name: "Secret", membership: "private" },
        ],
      },
    ]);
  });

  it("parses the chat list and names untitled chats after the other members", () => {
    const me = `8:orgid:${OID}`;
    const [one, group] = teams.parseCsaChats({
      chats: [
        {
          id: `19:${OID}_x@unq.gbl.spaces`,
          chatType: "oneOnOne",
          members: [{ mri: me }, { mri: "8:orgid:x" }],
          isRead: false,
          lastMessage: { imdisplayname: "Bo Kim", content: "<p>hi</p>", composetime: "2026-10-10T08:00:00Z" },
        },
        { id: "19:g@thread.v2", chatType: "group", title: "Launch", members: [{ mri: me }] },
      ],
    });
    expect(one).toMatchObject({ kind: "oneOnOne", unread: true, lastMessage: { from: "Bo Kim", preview: "hi", time: "2026-10-10T08:00:00.000Z" } });
    expect(teams.chatTitle(one, new Map([["8:orgid:x", "Bo Kim"]]), me)).toBe("Bo Kim");
    expect(teams.chatTitle(group, new Map(), me)).toBe("Launch");
  });

  it("finds one conversation by id, Team/Channel, title or person", () => {
    const lists = {
      teams: [{ id: "T", name: "Engineering", channels: [{ id: "19:g@thread.tacv2", name: "General" }] }],
      chats: [
        { id: "19:a@unq.gbl.spaces", kind: "oneOnOne", title: "Bo Kim", memberNames: ["Bo Kim"] },
        { id: "19:b@thread.v2", kind: "group", title: "Bo Kim, Ana Lee", memberNames: ["Bo Kim", "Ana Lee"] },
        { id: "19:c@thread.v2", kind: "group", title: "Launch planning", memberNames: [] },
        { id: "19:d@thread.v2", kind: "group", title: "Launch party", memberNames: [] },
      ],
    };
    expect(teams.resolveConversation("19:x@thread.v2;messageid=5", lists).id).toBe("19:x@thread.v2");
    expect(teams.resolveConversation("engineering/general", lists)).toMatchObject({ id: "19:g@thread.tacv2", kind: "channel", title: "Engineering/General" });
    expect(teams.resolveConversation("Bo Kim", lists).id).toBe("19:a@unq.gbl.spaces");
    expect(teams.resolveConversation("bo", lists).id).toBe("19:a@unq.gbl.spaces"); // the 1:1 beats a group with Bo
    expect(teams.resolveConversation("launch planning", lists).id).toBe("19:c@thread.v2");
    expect(() => teams.resolveConversation("launch", lists)).toThrow(/matches 2 conversations/);
    expect(() => teams.resolveConversation("nobody", lists)).toThrow(/No chat or channel matches/);
  });
});

describe("people and search", () => {
  it("parses short profiles", () => {
    expect(
      teams.parseProfiles({ value: [{ mri: "8:orgid:x", displayName: "Bo Kim", email: "bo@x.com", jobTitle: "PM", userType: "Guest" }] }),
    ).toEqual([{ mri: "8:orgid:x", name: "Bo Kim", email: "bo@x.com", jobTitle: "PM", userType: "Guest" }]);
  });

  it("parses people suggestions", () => {
    const json = {
      Groups: [
        {
          Suggestions: [
            { EntityType: "People", DisplayName: "Bo Kim", EmailAddresses: ["bo@x.com"], ExternalDirectoryObjectId: "ABC", JobTitle: "PM" },
            { EntityType: "Text", DisplayName: "bo" },
          ],
        },
      ],
    };
    expect(teams.parseSuggestions(json)).toEqual([{ name: "Bo Kim", email: "bo@x.com", mri: "8:orgid:abc", jobTitle: "PM" }]);
  });
});

describe("shapes seen live", () => {
  it("reads csa's chat list: isOneOnOne, camelCase last message, bots named after their last message", () => {
    const me = `8:orgid:${OID}`;
    const [person, bot, gone] = teams.parseCsaChats({
      chats: [
        { id: "19:a_b@unq.gbl.spaces", chatType: "chat", isOneOnOne: true, isRead: true, members: [{ mri: me }, { mri: "8:orgid:x" }],
          lastMessage: { imDisplayName: "Bo", originalArrivalTime: "2026-10-01T08:26:06.3000000Z", content: "<p>\n  hi\n</p>", from: me } },
        { id: "19:c_d@unq.gbl.spaces", chatType: "chat", isOneOnOne: true, members: [{ mri: me }, { mri: "28:bot" }],
          lastMessage: { imDisplayName: "Jira Cloud", messageType: "RichText/Media_Card", content: "Card - access it on https://go.skype.com/cards.unsupported  . Card   29:1VHec0 You have 37 overdue", from: "https://x/v1/users/ME/contacts/28:bot" } },
        { id: "19:e@thread.v2", chatType: "chat", isConversationDeleted: true, members: [] },
      ],
    });
    expect(gone).toBeUndefined();
    expect(person).toMatchObject({ kind: "oneOnOne", lastMessage: { from: "Bo", time: "2026-10-01T08:26:06.300Z", preview: "hi" } });
    expect(bot.lastMessage.preview).toBe("[card] You have 37 overdue");
    expect(teams.chatTitle(bot, new Map(), me)).toBe("Jira Cloud");
    expect(teams.chatTitle(person, new Map(), me)).toBeNull(); // my own last message doesn't name the chat
  });

  it("shows pasted pictures as [image] and ignores line breaks in the HTML source", () => {
    const html = '<p>status:</p>\n<p>&nbsp;</p>\n<p><img src="https://x/views/imgo" itemtype="http://schema.skype.com/AMSImage" alt="image"></p>';
    expect(teams.htmlToText(html)).toBe("status:\n\n[image]");
  });

  it("reads bot cards (base64 Adaptive Card JSON in <Swift>) as text", () => {
    const card = {
      attachments: [{ content: { type: "AdaptiveCard", body: [
        { type: "RichTextBlock", inlines: [{ type: "TextRun", text: "You have " }, { type: "TextRun", text: "2 overdue items" }] },
        { type: "Container", items: [{ type: "ColumnSet", columns: [
          { type: "Column", items: [{ type: "Image", url: "x" }] },
          { type: "Column", items: [{ type: "TextBlock", text: "MLYP-668 Koppelbox ✓" }] },
        ] }, { type: "ColumnSet", columns: [{ type: "Column", items: [{ type: "Badge", text: "2 Oct" }] }, { type: "Column", items: [{ type: "TextBlock", text: "P1" }] }] }] },
        { type: "FactSet", facts: [{ title: "Status", value: "Open" }] },
      ] } }],
    };
    const b64 = Buffer.from(JSON.stringify(card)).toString("base64");
    const content = `<URIObject type="SWIFT.1">Card - access it on <a href="https://go.skype.com/cards.unsupported">https://go.skype.com/cards.unsupported</a>. <Title>Card</Title><Swift b64="${b64}"></Swift></URIObject>`;
    expect(teams.parseMessage(msg("9", "2026-10-09T06:23:52Z", { messagetype: "RichText/Media_Card", content })).text).toBe(
      "[card]\nYou have 2 overdue items\nMLYP-668 Koppelbox ✓\n2 Oct · P1\nStatus: Open",
    );
  });

  it("maps search results to their conversation and message", () => {
    const json = {
      EntitySets: [{ ResultSets: [{ Total: 8, Results: [{
        HitHighlightedSummary: "the <c0>EMC</c0>   report",
        Source: {
          ClientConversationId: "19:a_b@unq.gbl.spaces;messageid=1790749785801",
          ClientThreadId: "19:a_b@unq.gbl.spaces",
          InternetMessageId: "1790749785801",
          DateTimeReceived: "2026-09-30T06:29:45.801Z",
          From: { EmailAddress: { Name: "Bo Kim", Address: "bo@x.com" } },
          Extensions: { SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId: "8:orgid:x", SkypeSpaces_ConversationPost_Extension_ThreadType: "chat" },
        },
      }] }] }],
    };
    expect(teams.parseSearch(json)).toEqual({ total: 8, results: [{
      conversationId: "19:a_b@unq.gbl.spaces", messageId: "1790749785801", time: "2026-09-30T06:29:45.801Z",
      from: "Bo Kim", fromEmail: "bo@x.com", fromMri: "8:orgid:x", threadType: "chat", text: "the EMC report",
    }] });
  });
});

describe("new chats", () => {
  const me = `8:orgid:${OID}`;
  const people = [
    { name: "Novak, Jana (QA)", email: "jana.novak@example.com", mri: null },
    { name: "김민준(KIM MIN JUN)", email: "minjun.kim@example.com", mri: "8:orgid:11111111-2222-4333-8444-555555555555" },
    { name: "Kim, Bo", email: "bo@x.com", mri: "8:orgid:b0" },
    { name: "Kim, Bora", email: "bora@x.com", mri: "8:orgid:b1" },
  ];

  it("picks one person by email, by the only result, or by an exact full name", () => {
    expect(teams.pickPerson("BO@x.com", people, me).mri).toBe("8:orgid:b0");
    expect(teams.pickPerson("김민준", [people[1]], me).mri).toBe(people[1].mri);
    expect(teams.pickPerson("Bo Kim", people.slice(2), me).mri).toBe("8:orgid:b0"); // "Kim, Bo" ~ "Bo Kim"
    // The part in parentheses is a name too (seen live: several Kims come back for this query).
    expect(teams.pickPerson("KIM MIN JUN", people, me).mri).toBe(people[1].mri);
    expect(teams.pickPerson("min jun kim", people, me).mri).toBe(people[1].mri);
  });

  it("refuses ambiguous names, nobody, and people without a Teams id", () => {
    expect(() => teams.pickPerson("Kim", people.slice(1), me)).toThrow(/matches 3 people/);
    expect(() => teams.pickPerson("nobody@x.com", people, me)).toThrow(/Nobody found/);
    expect(() => teams.pickPerson("Jana Novak", [people[0]], me)).toThrow(/no Teams account/);
    expect(() => teams.pickPerson("me", [{ name: "Me", email: "m@x.com", mri: me }], me)).toThrow(/Nobody found/);
  });

  it("derives the 1:1 chat id from both object ids, sorted (as Teams does)", () => {
    expect(teams.oneOnOneId(me, "8:orgid:11111111-2222-4333-8444-555555555555")).toBe(
      `19:11111111-2222-4333-8444-555555555555_${OID}@unq.gbl.spaces`,
    );
    expect(teams.oneOnOneId(me, "28:bot")).toBeNull();
  });

  it("reuses an existing chat with exactly those people", () => {
    const chats = [
      { id: "1on1", kind: "oneOnOne", title: "Bo", members: [me, "8:orgid:b0"] },
      { id: "group", kind: "group", title: "Plan", members: ["8:orgid:b1", me, "8:orgid:b0"] },
      { id: "meet", kind: "meeting", title: "M", members: [me, "8:orgid:b0", "8:orgid:b1"] },
    ];
    expect(teams.findExistingChat(chats, ["8:orgid:b0"], me)?.id).toBe("1on1");
    expect(teams.findExistingChat(chats, ["8:orgid:b0", "8:orgid:b1"], me)?.id).toBe("group");
    expect(teams.findExistingChat(chats, ["8:orgid:b0", "8:orgid:b1"], me, "Other")).toBeNull();
    expect(teams.findExistingChat(chats, ["8:orgid:b1"], me)).toBeNull();
  });

  it("reads the new chat's id from the Location header or the body", () => {
    expect(teams.threadIdFrom("https://x/api/chatsvc/kr/v1/threads/19%3Aabc%40thread.v2", null)).toBe("19:abc@thread.v2");
    expect(teams.threadIdFrom(null, { id: "19:def@thread.v2" })).toBe("19:def@thread.v2");
    expect(teams.threadIdFrom(null, {})).toBeNull();
  });
});

describe("meetings", () => {
  const me = "8:orgid:00000000-0000-0000-0000-00000000000a";
  const csa = {
    chats: [
      { id: "19:a@unq.gbl.spaces", chatType: "chat", tenantId: "home" },
      { id: "19:b@thread.v2", chatType: "chat", tenantId: "home" },
      {
        id: "19:meeting_A@thread.v2",
        chatType: "meeting",
        tenantId: "home",
        title: "Sync",
        lastJoinAt: "2026-10-01T07:00:00Z",
        meetingInformation: { subject: "Weekly sync", startTime: "2026-07-21T07:00:00Z", endTime: "2026-07-21T08:00:00Z", organizerId: "0000000a", eventRecurrencePattern: { patternType: 2 }, meetingJoinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
        meetingObjectsConfig: { configurations: { transcriptConfig: { hasTranscript: true } } },
        lastMessage: { imDisplayName: "Bo", originalArrivalTime: "2026-10-06T08:01:51.238Z", content: "<p>bye</p>", messageType: "RichText/Html" },
      },
      { id: "19:meeting_B@thread.v2", chatType: "meeting", tenantId: "other", title: "Customer review" },
      { id: "19:meeting_C@thread.v2", chatType: "meeting", tenantId: "home", isConversationDeleted: true },
    ],
  };

  it("lists meeting chats with their meeting, marking another organization's", () => {
    expect(teams.homeTenant(csa)).toBe("home");
    const [a, b, ...rest] = teams.parseCsaMeetings(csa);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ id: "19:meeting_A@thread.v2", title: "Weekly sync", start: "2026-07-21T07:00:00Z", recurring: true, hasTranscript: true, organizer: "8:orgid:0000000a", lastActivity: "2026-10-06T08:01:51.238Z" });
    expect(a.external).toBeUndefined();
    expect(b).toMatchObject({ title: "Customer review", external: true, start: null });
  });

  const started = {
    messagetype: "Event/Call",
    originalarrivaltime: "2026-10-06T06:55:10.8630000Z",
    properties: { skypeguid: "call-1" },
    content:
      '<partlist alt =""></partlist><meetingDetails><meetingDetails><organizerUpn>bo@x.com</organizerUpn><startTime>07/21/2026 07:00:00</startTime><instanceDetails><startTime>10/06/2026 07:00:00 +00:00</startTime><endTime>10/06/2026 08:00:00 +00:00</endTime><subject>Weekly sync</subject></instanceDetails></meetingDetails></meetingDetails><callEventType>callStarted</callEventType>\n<conversationStartTime>10/06/2026 06:54:39</conversationStartTime>\n<callId>call-1</callId>',
  };
  const ended = {
    messagetype: "Event/Call",
    originalarrivaltime: "2026-10-06T08:06:54.0570000Z",
    properties: { skypeguid: "call-1" },
    content:
      `<ended/><partlist alt="" count="2"><part identity="${me}"><name>${me}</name><displayName>Heeyun Cho</displayName><duration>4335</duration></part><part identity="8:orgid:b"><name>8:orgid:b</name><displayName>Bo &amp; Co</displayName><duration>4335</duration></part></partlist><callEventType>callEnded</callEventType><callId>call-1</callId>`,
  };
  const recording = {
    messagetype: "RichText/Media_CallRecording",
    originalarrivaltime: "2026-10-06T08:10:00Z",
    content:
      '<URIObject type="Video.2/CallRecording.1"><RecordingStatus status="Success" code="200" /><Title>Weekly sync</Title><Identifiers><Id type="callId" value="call-1" /></Identifiers><RecordingContent contentTypes="Recording+Transcript" timestamp="2026-10-06T06:55:37Z" duration="1:10:47.42"><item type="amsTranscript" uri="https://kr-prod.asyncgw.teams.microsoft.com/v1/objects/0-x/views/transcript" /><item type="onedriveForBusinessVideo" uri="https://x-my.sharepoint.com/:v:/p/bo/abc" /><item type="onedriveForBusinessTranscript" uri="https://x-my.sharepoint.com/personal/bo/_api/v2.1/drives/d/items/i/versions/current/media/transcripts/t/content?a=1&amp;b=2" /></RecordingContent></URIObject>',
  };
  const inProgress = { ...recording, content: recording.content.replace('status="Success"', 'status="ChunkFinished"') };

  it("reads calls: when, who joined, recording and transcript", () => {
    expect(teams.callTime("10/06/2026 07:00:00 +00:00")).toBe("2026-10-06T07:00:00Z");
    expect(teams.parseRecording(inProgress)).toBeNull();
    expect(teams.parseRecording(recording)).toMatchObject({ callId: "call-1", seconds: 4247, video: "https://x-my.sharepoint.com/:v:/p/bo/abc" });
    const sessions = teams.meetingSessions([ended, recording, inProgress, started, { messagetype: "RichText/Html", content: "hi" }]);
    expect(sessions).toEqual([
      {
        callId: "call-1",
        subject: "Weekly sync",
        start: "2026-10-06T06:54:39Z",
        end: "2026-10-06T08:06:54Z",
        minutes: 72,
        scheduled: { start: "2026-10-06T07:00:00Z", end: "2026-10-06T08:00:00Z" },
        attendees: ["Heeyun Cho", "Bo & Co"],
        recording: "https://x-my.sharepoint.com/:v:/p/bo/abc",
        transcript: true,
        transcriptUrl: "https://x-my.sharepoint.com/personal/bo/_api/v2.1/drives/d/items/i/versions/current/media/transcripts/t/content?a=1&b=2",
      },
    ]);
  });

  const transcript = {
    entries: [
      { text: "Hello", speakerDisplayName: "Bo", startOffset: "00:00:01.5", endOffset: "00:00:03.5" },
      { text: "everyone.", speakerDisplayName: "Bo", startOffset: "00:00:04.0", endOffset: "00:00:05.0" },
      { text: " ", speakerDisplayName: "Ana", startOffset: "00:00:05.0", endOffset: "00:00:05.1" },
      { text: "The sample ships Monday.", speakerDisplayName: "Ana", startOffset: "00:01:00.0", endOffset: "00:02:00.0" },
      { text: "Which SAMPLE?", startOffset: "00:02:01.0", endOffset: "00:02:03.0" },
    ],
  };

  it("renders a transcript by speaker turn, from a point, and searches it", () => {
    expect(teams.transcriptLines(transcript)).toEqual([
      "[00:00:01] Bo: Hello everyone.",
      "[00:01:00] Ana: The sample ships Monday.",
      "[00:02:01] Unknown: Which SAMPLE?",
    ]);
    expect(teams.transcriptLines(transcript, { fromSeconds: 60 })[0]).toBe("[00:01:00] Ana: The sample ships Monday.");
    expect(teams.transcriptSpeakers(transcript)).toEqual([
      { name: "Ana", minutes: 1 },
      { name: "Bo", minutes: 0.1 },
      { name: "Unknown", minutes: 0 },
    ]);
    expect(teams.searchTranscript(transcript, "sample")).toEqual([
      { before: "[00:00:01] Bo: Hello everyone.", line: "[00:01:00] Ana: The sample ships Monday." },
      { before: "[00:01:00] Ana: The sample ships Monday.", line: "[00:02:01] Unknown: Which SAMPLE?" },
    ]);
    // A speaker's name doesn't count as what they said.
    expect(teams.searchTranscript(transcript, "ana")).toEqual([]);
  });
});

describe("traffic log", () => {
  it("records names, never values", () => {
    const entry = teams.summarizeRequest({
      url: "https://x-my.sharepoint.com/personal/a/_api/v2.1/items?format=json&tempauth=SECRET",
      method: "GET",
      type: "xmlhttprequest",
      requestHeaders: [{ name: "Authorization", value: "Bearer SECRET" }],
    });
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(entry).toMatchObject({ host: "x-my.sharepoint.com", queryParams: ["format", "tempauth"], headerNames: ["authorization"], auth: "bearer" });
    expect(teams.authScheme([{ name: "authentication", value: "skypetoken=SECRET" }])).toBe("authentication:skypetoken");
    let list = teams.recordTraffic([], entry, 1000);
    list = teams.recordTraffic(list, entry, 2000);
    list = teams.recordStatus(list, entry.key, 200);
    expect(list).toHaveLength(1);
    expect(teams.filterTraffic(list, { filter: "_api" })[0]).toMatchObject({ count: 2, status: 200, lastAt: "1970-01-01T00:00:02.000Z" });
    expect(teams.filterTraffic(list, { filter: "teams" })).toEqual([]);
    expect(teams.isTeamsOrigin("https://teams.cloud.microsoft")).toBe(true);
    expect(teams.isTeamsOrigin("https://evil.com")).toBe(false);
  });
});

describe("versions", () => {
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

  it("package.json, package-lock.json and the extension manifest agree", () => {
    const { version } = read("package.json");
    expect(read("extension/manifest.json").version).toBe(version);
    expect(read("package-lock.json").version).toBe(version);
    expect(read("package-lock.json").packages[""].version).toBe(version);
  });

  it("picks the bump from commit messages", () => {
    expect(nextVersion("0.1.0", ["Fix search"])).toBe("0.1.1");
    expect(nextVersion("0.1.3", ["fix: x", "feat(search): folders"])).toBe("0.2.0");
    expect(nextVersion("0.1.0", ["feat: x\n\n- major for\n  BREAKING CHANGE / type!:, minor for feat:"])).toBe("0.2.0");
  });
});

describe("serviceUrl", () => {
  const base = "https://teams.cloud.microsoft/api/chatsvc/kr";
  it("puts paths and chatsvc links on the service's base", () => {
    expect(teams.serviceUrl("/v1/users/ME", base)).toBe(`${base}/v1/users/ME`);
    expect(teams.serviceUrl("https://kr.ng.msg.teams.microsoft.com/v1/x?y=1", base)).toBe(`${base}/v1/x?y=1`);
  });
  it("never sends a service's tokens to another host", () => {
    expect(() => teams.serviceUrl("https://evil.example/collect", base)).toThrow(/Refusing/);
    expect(() => teams.serviceUrl(".evil.example/v1/x", "https://kr.ng.msg.teams.microsoft.com")).toThrow(/Refusing/);
    expect(() => teams.serviceUrl("@evil.example/x", "https://substrate.office.com")).toThrow(/Refusing/);
    expect(teams.serviceUrl("//evil.example/x", "https://substrate.office.com")).toBe("https://substrate.office.com//evil.example/x");
    expect(() => teams.serviceUrl("http://teams.cloud.microsoft/x", base)).toThrow(/Refusing/);
  });
});

describe("read_messages cursor", () => {
  const CHAT = "19:contoso-history@thread.v2";
  const path = (id: string, rest = "/messages?startTime=1&syncState=abc&pageSize=60") => `/v1/users/ME/conversations/${encodeURIComponent(id)}${rest}`;
  it("1.1: round-trips a chatsvc backward link (as a path on the service) and a time", () => {
    const c = teams.messagesCursor(`https://emea.ng.msg.teams.microsoft.com${path(CHAT)}`, "2026-01-01T00:00:00.000Z");
    expect(teams.readMessagesCursor(c, CHAT)).toEqual({ path: path(CHAT), before: "2026-01-01T00:00:00.000Z" });
    const thread = `${CHAT};messageid=1700000000000`;
    const t = teams.messagesCursor(path(thread, "/messages?pageSize=20"), null);
    expect(teams.readMessagesCursor(t, thread)).toEqual({ path: path(thread, "/messages?pageSize=20"), before: null });
  });
  it("1.1: rejects cursors for other hosts, paths or conversations", () => {
    const forge = (p: string, b?: string) => Buffer.from(JSON.stringify({ p, b })).toString("base64url");
    const bad = [
      "not a cursor",
      forge(`https://evil.example${path(CHAT)}`),
      forge(`//evil.example${path(CHAT)}`),
      forge(path("19:other@thread.v2")),
      forge(path(CHAT, "/properties")),
      forge(path(CHAT, "/messages/../../x/messages")),
      forge(`/v1/users/ME/conversations/x/../${encodeURIComponent(CHAT)}/messages`),
      forge(path(`${CHAT}/messages/../x`, "/messages")),
      forge(path(CHAT, "/messages\\..\\x")),
      forge(path(CHAT), "not a time"),
    ];
    for (const c of bad) expect(() => teams.readMessagesCursor(c, CHAT), c).toThrow(/not a valid cursor/i);
  });
});
