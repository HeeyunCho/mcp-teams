#!/usr/bin/env node
// Manual heap check of the extension worker's transcript cache (#190, #178): how much heap the
// cached transcripts hold, against the byte count the cache keeps for them. Not part of CI; see
// docs/testing.md.
//
//   node --expose-gc scripts/measure-worker-cache.mjs [--extension extension] [--transcripts 10] [--entries 600] [--runs 5]
//
// It loads the real worker (`--extension`'s background.js, which imports that folder's
// teams.js) under a minimal fake chrome with a Teams tab and a OneDrive tab open, and reads
// `transcripts` meetings' transcripts with read_transcript, so transcriptOf fills its cache as in
// the browser. Each transcript is shaped like Stream's transcript.json: `entries` entries, each
// with every field Stream sends (ids, speaker id and name, text, offsets, confidence,
// hasBeenEdited, roleId, spokenLanguageTag), sentences of 3 to 40 words, six speakers, and some
// German and Korean text. The sizes keep everything under the cache's 8 MB cap, so nothing is
// evicted (the run fails if anything is).
//
// The heap the cache holds is heapUsed (after gc) with the cache full, less heapUsed (after gc)
// once that cache is cleared: what the worker keeps besides it (meeting lists, the fake
// responses) is in both. The count is the cache's own `bytes`. Each run is a fresh process, as
// module state and the heap start over; the table gives the middle run, and the spread.
//
// Before and after a change to the cache, same machine, Node and sizes: the after side is this
// checkout's extension/; for the before side, export the base branch's extension/ folder and
// point --extension at it, e.g.
//
//   dir=$(mktemp -d) && git archive origin/main extension | tar -x -C "$dir"
//   node --expose-gc scripts/measure-worker-cache.mjs --extension "$dir/extension"   # before
//   node --expose-gc scripts/measure-worker-cache.mjs                                # after
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
};
const num = (name, fallback) => {
  const n = Number(opt(name, fallback));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number above 0`);
  return n;
};
const self = fileURLToPath(import.meta.url);
const sizes = { extension: resolve(opt("extension", resolve(self, "../../extension"))), transcripts: num("transcripts", 10), entries: num("entries", 600) };
const MB = 1024 * 1024;

// ------------------------------------------------------------------ fictional Stream transcripts

/** A small seeded PRNG (mulberry32), so every run reads the same transcripts. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SPEAKERS = ["Alex Doe", "Sam Roe", "Jürgen Weiß", "Søren Ødegård", "Kim Min-jun", "김서연"];
const EN = "so I think the plan for next quarter still needs one more review of the budget timeline and staffing before we agree on the launch checklist and who owns each of the open risks we listed last week".split(" ");
const DE = "also ich glaube wir müssen die Prüfung der Größe noch einmal anschauen bevor wir über die nächsten Schritte für das Büro sprechen".split(" ");
const KO = "그럼 다음 주까지 예산 검토를 마치고 출시 일정을 다시 확인하는 걸로 하겠습니다".split(" ");
const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
const hex = (rnd, n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const uuid = (rnd) => `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-8${hex(rnd, 3)}-${hex(rnd, 12)}`;

/** Meeting n's transcript.json, as Stream writes it. */
function streamTranscript(n, entries) {
  const rnd = random(n);
  const speakerIds = SPEAKERS.map(() => `${uuid(rnd)}@${uuid(rnd)}`);
  const recording = uuid(rnd);
  let at = 3;
  return {
    $schema: "http://stream.office.com/schemas/transcript.json",
    version: "1.0.0",
    type: "Transcript",
    entries: Array.from({ length: entries }, (_, i) => {
      const who = Math.floor(rnd() * SPEAKERS.length);
      const lang = rnd();
      const words = lang < 0.06 ? KO : lang < 0.16 ? DE : EN;
      const count = 3 + Math.floor(rnd() * 38);
      const text = Array.from({ length: count }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      const start = at;
      at += 1 + Math.ceil(count / 2.5);
      return {
        id: `${recording}/${i + 17}-0`,
        speechServiceResultId: uuid(rnd),
        text: text[0].toUpperCase() + text.slice(1) + ".",
        speakerId: speakerIds[who],
        speakerDisplayName: SPEAKERS[who],
        confidence: 0.6 + rnd() * 0.4,
        startOffset: `${hms(start)}.${String(Math.floor(rnd() * 1e7)).padStart(7, "0")}`,
        endOffset: `${hms(at - 1)}.${String(Math.floor(rnd() * 1e7)).padStart(7, "0")}`,
        hasBeenEdited: rnd() < 0.02,
        roleId: uuid(rnd),
        spokenLanguageTag: words === KO ? "ko-kr" : words === DE ? "de-de" : "en-us",
      };
    }),
    events: [{ id: uuid(rnd), eventType: "CallStarted", userId: speakerIds[0], userDisplayName: SPEAKERS[0] }],
  };
}

// ------------------------------------------------------------------ a fake Teams and OneDrive

const TEAMS_ORIGIN = "https://teams.cloud.microsoft";
const SHAREPOINT_ORIGIN = "https://contoso-my.sharepoint.com";
const BASES = { chatsvc: `${TEAMS_ORIGIN}/api/chatsvc/emea`, csa: `${TEAMS_ORIGIN}/api/csa/emea`, mt: `${TEAMS_ORIGIN}/api/mt/emea`, substrate: "https://substrate.office.com" };
const meetingId = (n) => `19:meeting_contoso-${String(n).padStart(3, "0")}@thread.v2`;
const callId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const transcriptUrl = (n) => `${SHAREPOINT_ORIGIN}/personal/alex_contoso_example/_api/v2.1/drives/d/items/i${n}/versions/current/media/transcripts/t${n}/content`;
const dayOf = (n) => new Date(Date.parse("2026-09-30T09:00:00Z") - n * 86_400_000);
const usDate = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()} 09:00:00`;

/** What each fake service answers to a URL (as text), or undefined for a 404. */
function services(count, bodies) {
  const csa = JSON.stringify({
    teams: [],
    chats: Array.from({ length: count }, (_, i) => ({
      id: meetingId(i + 1),
      chatType: "meeting",
      title: `Contoso review ${i + 1}`,
      meetingInformation: { subject: `Contoso review ${i + 1}`, startTime: dayOf(i + 1).toISOString() },
      meetingObjectsConfig: { configurations: { transcriptConfig: { hasTranscript: true } } },
      lastJoinAt: dayOf(i + 1).toISOString(),
    })),
  });
  const chat = (n) =>
    JSON.stringify({
      messages: [
        {
          id: "3",
          messagetype: "RichText/Media_CallRecording",
          originalarrivaltime: new Date(dayOf(n).getTime() + 3_700_000).toISOString(),
          content: `<URIObject type="Video.2/CallRecording.1"><RecordingStatus status="Success" code="200" /><Title>Contoso review ${n}</Title><Identifiers><Id type="callId" value="${callId(n)}" /></Identifiers><RecordingContent contentTypes="Transcript" timestamp="${dayOf(n).toISOString()}" duration="1:00:00.00"><item type="onedriveForBusinessTranscript" uri="${transcriptUrl(n)}" /></RecordingContent></URIObject>`,
        },
        { id: "2", messagetype: "Event/Call", originalarrivaltime: new Date(dayOf(n).getTime() + 3_600_000).toISOString(), properties: { skypeguid: callId(n) }, content: `<ended/><partlist alt="" count="1"><part identity="8:orgid:00000000-0000-4000-8000-00000000000a"><displayName>Alex Doe</displayName><duration>3600</duration></part></partlist><callEventType>callEnded</callEventType><callId>${callId(n)}</callId>` },
        { id: "1", messagetype: "Event/Call", originalarrivaltime: dayOf(n).toISOString(), properties: { skypeguid: callId(n) }, content: `<partlist alt=""></partlist><callEventType>callStarted</callEventType><conversationStartTime>${usDate(dayOf(n))}</conversationStartTime><callId>${callId(n)}</callId>` },
      ],
      _metadata: {},
    });
  return (url) => {
    if (url.startsWith(`${SHAREPOINT_ORIGIN}/`)) return bodies.get(Number(/\/items\/i(\d+)\//.exec(url)?.[1]));
    if (url.startsWith(`${BASES.csa}/`)) return csa;
    const m = url.startsWith(`${BASES.chatsvc}/`) && /\/conversations\/([^/?]+)\/messages\?/.exec(url);
    const n = m && Number(/^19:meeting_contoso-(\d+)@thread\.v2$/.exec(decodeURIComponent(m[1]))?.[1]);
    return n ? chat(n) : undefined;
  };
}

/** Just enough of chrome for read_transcript: storage, two open tabs, and pageFetch run with a fake fetch. */
function fakeChrome(answer) {
  const event = () => {
    const listeners = [];
    return { listeners, addListener: (fn) => void listeners.push(fn), removeListener: (fn) => void listeners.splice(listeners.indexOf(fn) >>> 0, 1) };
  };
  const area = (map) => ({
    get: async (keys) => (keys == null ? Object.fromEntries(map) : Object.fromEntries([keys].flat().filter((k) => map.has(k)).map((k) => [k, map.get(k)]))),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => map.set(k, v)),
    remove: async (keys) => void [keys].flat().forEach((k) => map.delete(k)),
  });
  const session = new Map([["oid", "00000000-0000-4000-8000-000000000001"]]);
  for (const [s, base] of Object.entries(BASES)) session.set(`capture:${s}`, { base, region: s === "substrate" ? null : "emea", headers: { authorization: "Bearer fake" }, at: 1 });
  const tabs = [
    { id: 1, url: `${TEAMS_ORIGIN}/v2/`, status: "complete" },
    { id: 2, url: `${SHAREPOINT_ORIGIN}/`, status: "complete" },
  ];
  const pattern = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const fetch = async (url) => {
    const text = answer(url);
    return new Response(text ?? "", { status: text === undefined ? 404 : 200 });
  };
  return {
    runtime: { id: "fake-extension-id", getManifest: () => ({ version: "0.0.0" }), getURL: (p) => `chrome-extension://fake-extension-id/${p}`, reload() {}, onMessage: event(), onStartup: event(), onInstalled: event() },
    webRequest: { onBeforeSendHeaders: { addListener() {} }, onCompleted: { addListener() {} } },
    storage: { session: area(session), local: area(new Map()), onChanged: event() },
    tabs: {
      query: async ({ url } = {}) => tabs.filter((t) => !url || [url].flat().some((p) => pattern(p).test(t.url))).map((t) => ({ ...t })),
      get: async (id) => ({ ...tabs.find((t) => t.id === id) }),
      create: async () => {
        throw new Error("measure-worker-cache: no tab should open");
      },
      reload: async () => {},
      remove: async () => {},
      onUpdated: event(),
      onRemoved: event(),
    },
    windows: { create: async () => ({ id: 1, tabs: [] }), remove: async () => {}, onRemoved: event() },
    // As Chrome: the function runs from its source in the page, with the page's fetch.
    scripting: { executeScript: async ({ func, args: a }) => [{ result: await new Function("fetch", `return (${func.toString()})`)(fetch)(...a) }] },
    alarms: { create() {}, onAlarm: event() },
  };
}

// ------------------------------------------------------------------ one run, in its own process

/** UTF-8 bytes of every string value in `x` (object keys aren't counted: V8 shares them). */
function stringBytes(x) {
  if (typeof x === "string") return Buffer.byteLength(x);
  if (Array.isArray(x)) return x.reduce((n, v) => n + stringBytes(v), 0);
  if (x && typeof x === "object") return Object.values(x).reduce((n, v) => n + stringBytes(v), 0);
  return 0;
}

async function run() {
  const bodies = new Map();
  let responseChars = 0;
  for (let n = 1; n <= sizes.transcripts; n++) {
    bodies.set(n, JSON.stringify(streamTranscript(n, sizes.entries)));
    responseChars += bodies.get(n).length;
  }
  globalThis.chrome = fakeChrome(services(sizes.transcripts, bodies));
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("measure-worker-cache: the worker should not connect");
    }
  };
  if (!globalThis.navigator?.userAgentData) Object.defineProperty(globalThis, "navigator", { value: { userAgentData: { brands: [{ brand: "Google Chrome", version: "130" }] } }, configurable: true });

  // The worker's transcript cache is the ByteCache whose keys end in a SharePoint URL; its values'
  // strings are counted as they go in, without keeping a reference to them.
  const teams = await import(pathToFileURL(resolve(sizes.extension, "teams.js")).href);
  let cache = null;
  const kept = new Map();
  const set = teams.ByteCache.prototype.set;
  teams.ByteCache.prototype.set = function (key, value, bytes) {
    if (String(key).includes(`\n${SHAREPOINT_ORIGIN}/`)) {
      cache = this;
      kept.set(key, { strings: stringBytes(value), entries: value?.entries?.length ?? 0 });
    }
    return set.call(this, key, value, bytes);
  };
  const worker = await import(pathToFileURL(resolve(sizes.extension, "background.js")).href);

  const heap = () => {
    for (let i = 0; i < 4; i++) globalThis.gc();
    return process.memoryUsage().heapUsed;
  };
  for (let n = 1; n <= sizes.transcripts; n++) await worker.handlers.readTranscript({ meeting: meetingId(n), maxLength: 1000 });
  if (!cache) throw new Error("no transcript was cached: is this the worker's extension folder?");
  if (cache.size !== sizes.transcripts) throw new Error(`the cache kept ${cache.size} of ${sizes.transcripts} transcripts (count ${cache.bytes} of ${cache.maxBytes}): use fewer or smaller ones`);
  const count = cache.bytes;
  const full = heap();
  cache.clear();
  const empty = heap();
  const values = [...kept.values()];
  return {
    heap: full - empty,
    count,
    entries: values.reduce((n, v) => n + v.entries, 0),
    strings: values.reduce((n, v) => n + v.strings, 0),
    responseChars,
  };
}

if (args.includes("--run")) {
  if (typeof globalThis.gc !== "function") throw new Error("run with node --expose-gc");
  process.send(await run().catch((err) => ({ error: String(err?.stack ?? err) })));
  process.exit(0);
} else {
  const runs = num("runs", 5);
  if (!process.execArgv.includes("--expose-gc")) console.log("(not run with --expose-gc; each run uses it anyway)");
  const results = [];
  for (let i = 0; i < runs; i++) {
    const c = spawn(process.execPath, ["--expose-gc", self, "--run", ...args], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const r = await new Promise((done, fail) => {
      c.once("message", done);
      c.once("exit", (code) => fail(new Error(`run ${i + 1} exited (${code}) before answering`)));
    });
    if (r.error) {
      console.error(`run ${i + 1} failed: ${r.error}`);
      process.exit(1);
    }
    results.push(r);
  }
  const { count, entries, strings, responseChars } = results[0];
  const heaps = results.map((r) => r.heap).sort((a, b) => a - b);
  const mid = heaps[Math.floor(heaps.length / 2)];
  const f = (n, d = 2) => n.toFixed(d);
  console.log(`\n${sizes.extension}`);
  console.log(`${sizes.transcripts} transcripts of ${sizes.entries} entries (${f(responseChars / MB)} MB of response text); ${runs} runs; node ${process.version}\n`);
  console.log("| heap held (MB) | runs' spread (MB) | count (MB) | heap / count | heap per entry (B) | count per entry (B) | heap per entry beyond its UTF-8 strings (B) |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|");
  console.log(`| ${f(mid / MB)} | ${f(heaps[0] / MB)}-${f(heaps.at(-1) / MB)} | ${f(count / MB)} | ${f(mid / count)} | ${f(mid / entries, 0)} | ${f(count / entries, 0)} | ${f((mid - strings) / entries, 0)} |`);
}
