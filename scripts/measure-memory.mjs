#!/usr/bin/env node
// Manual memory check (3.5, #20): how much memory the hub, a peer and the extension's side
// use for the two biggest reads. Not part of CI; see docs/testing.md.
//
//   npm run build && npm run measure-memory -- [--lines 20000] [--messages 5000] [--page 50] [--chunk 40000]
//
// Scenarios:
//   transcript  read_transcript of a meeting with `lines` transcript lines, read to the end by
//               following continueFrom, `chunk` characters a call (the tool's max_length).
//   history     read_messages of a chat with `messages` messages, paged back to the first one
//               by olderCursor, `page` messages a call (the tool's limit).
//
// Each scenario runs in fresh processes, so neither one's peak hides the other's, and in
// three of them, so the numbers don't mix: the hub (--hub), a peer (--peer) that runs the
// real tools (dist/tools.js) through an in-memory MCP client, as an AI app's server session
// would, and a fake extension (--extension) that answers the bridge with fictional data
// shaped like the real extension's answers. This process only starts them and prints the
// table. Each one samples heapUsed every 2 ms and reports it with its peak RSS (the OS's
// maxRSS) once the read is done.
//
// The run uses a free port and a pairing token made for it, and points TEAMS_MCP_HOME at a
// temporary folder: nothing reads or writes ~/.mcp-teams or uses the configured port.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MB = 1024 * 1024;
const TOKEN = process.env.MEASURE_TOKEN;
const PORT = Number(process.env.MEASURE_PORT);
const MEETING = "Fictional Planning Sync";
const CHAT = "19:00000000-0000-0000-0000-000000000001@unq.gbl.spaces";

/** Samples heapUsed every 2 ms; report() gives its peak and the OS's peak RSS. */
function sampler() {
  let peakHeap = 0;
  const sample = () => (peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed));
  setInterval(sample, 2).unref();
  sample();
  return () => {
    sample();
    return { peakRssMB: (process.resourceUsage().maxRSS * 1024) / MB, peakHeapUsedMB: peakHeap / MB }; // maxRSS is in KB
  };
}

/** Answers "report" with the peaks, then closes and exits. */
function reportOnRequest(report, close) {
  process.on("message", (msg) => {
    if (msg !== "report") return;
    process.send(report());
    void Promise.resolve(close()).then(() => process.exit(0));
  });
}

async function connected(bridge) {
  for (const t0 = Date.now(); !bridge.connected; ) {
    if (Date.now() - t0 > 10_000) throw new Error("the bridge never saw the extension");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ------------------------------------------------------------------ fictional Teams data

const SPEAKERS = ["Alex Doe", "Sam Roe", "Kim Lee", "Jo Park", "Riley Moss", "Casey Ford"];
const WORDS = "the plan for next quarter needs one more review of budget timeline staffing risks and the launch checklist before we agree".split(" ");
const sentence = (i, words) => Array.from({ length: words }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(" ");
const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");

/** A transcript of `count` lines, one a second, as teams.transcriptLines gives them. */
function transcript(count) {
  return Array.from({ length: count }, (_, i) => `[${hms(i)}] ${SPEAKERS[i % SPEAKERS.length]}: ${sentence(i, 12 + (i % 15))}.`);
}

/** Message number `n` (1 is the oldest), shaped like teams.parseMessage's output. */
function message(n) {
  const who = n % SPEAKERS.length;
  return {
    id: String(1_700_000_000_000 + n),
    time: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    from: { name: SPEAKERS[who], mri: `8:orgid:00000000-0000-0000-0000-00000000000${who}` },
    text: sentence(n, 20 + (n % 60)),
    ...(n % 9 === 0 ? { files: [{ name: `notes-${n}.docx`, url: `https://contoso.example/files/notes-${n}.docx`, type: "docx" }] } : {}),
    ...(n % 4 === 0 ? { reactions: [{ reaction: "like", count: 1 + (n % 3) }] } : {}),
  };
}

const extensionAnswers = (lines, messages) => ({
  status: () => ({ teamsTabs: 1 }),
  // As background.js readTranscript: lines from `from` on, up to maxLength characters.
  readTranscript: ({ from, maxLength = 40_000 }) => {
    const fromSeconds = from ? String(from).split(":").reduce((a, x) => a * 60 + Number(x), 0) : 0;
    const shownLines = [];
    let length = 0;
    let i = fromSeconds;
    for (; i < lines.length; i++) {
      if (length + lines[i].length + 1 > maxLength && shownLines.length) break;
      length += lines[i].length + 1;
      shownLines.push(lines[i]);
    }
    return {
      meeting: MEETING,
      session: { callId: "00000000-0000-0000-0000-0000000000c1", start: "2026-01-05T09:00:00Z", end: null, minutes: Math.ceil(lines.length / 60) },
      speakers: SPEAKERS.map((name) => ({ name, minutes: Math.round(lines.length / 60 / SPEAKERS.length) })),
      language: "en-us",
      otherSessionsWithTranscript: [],
      ...(i < lines.length ? { truncated: true, continueFrom: hms(i) } : {}),
      transcript: shownLines.join("\n"),
    };
  },
  // As background.js readMessages with a cursor: the `limit` newest messages older than the
  // cursor's, oldest first, and an olderCursor while older ones exist.
  readMessages: ({ limit = 30, cursor }) => {
    const below = cursor ? Number(JSON.parse(Buffer.from(cursor, "base64url").toString()).n) : messages + 1;
    const oldest = Math.max(1, below - limit);
    const page = [];
    for (let n = oldest; n < below; n++) page.push(message(n));
    return {
      conversation: { id: CHAT, kind: "oneOnOne", title: "Sam Roe" },
      count: page.length,
      messages: page,
      ...(page.length ? { olderBefore: page[0].time } : {}),
      ...(oldest > 1 ? { olderCursor: Buffer.from(JSON.stringify({ n: oldest })).toString("base64url") } : {}),
    };
  },
});

// ------------------------------------------------------------------ the three processes

if (args.includes("--hub")) {
  const { ExtensionBridge } = await import("../dist/bridge.js");
  const hub = new ExtensionBridge(PORT, TOKEN, "1.0.0");
  await hub.start();
  if (hub.role !== "hub") throw new Error(`expected to be the hub, got ${hub.role}`);
  reportOnRequest(sampler(), () => hub.close());
  process.send({ ready: true });
} else if (args.includes("--extension")) {
  const { default: WebSocket } = await import("ws");
  const { proof } = await import("../dist/bridge.js");
  const { EXTENSION_ORIGIN } = await import("../dist/extension.js");
  const answers = extensionAnswers(transcript(opt("lines", 0)), opt("messages", 0));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: EXTENSION_ORIGIN, maxPayload: 256 * MB });
  const nonce = randomUUID();
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("close", (code) => reject(new Error(`the hub closed the extension's connection (${code})`)));
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") {
        ws.send(JSON.stringify({ type: "hello", proof: proof(TOKEN, "client", msg.nonce), nonce, version: "1.0.0", browser: "Chrome", instance: "measure" }));
      } else if (msg.type === "welcome") {
        if (msg.proof !== proof(TOKEN, "server", nonce)) reject(new Error("the hub's proof is wrong"));
        resolve();
      } else if (msg.type === "request") {
        const answer = answers[msg.method];
        const reply = answer
          ? { type: "response", id: msg.id, ok: true, result: answer(msg.params ?? {}) }
          : { type: "response", id: msg.id, ok: false, error: `measure-memory: no answer for ${msg.method}` };
        ws.send(JSON.stringify(reply));
      }
    });
  });
  ws.removeAllListeners("close");
  reportOnRequest(sampler(), () => ws.close());
  process.send({ ready: true });
} else if (args.includes("--peer")) {
  const { ExtensionBridge } = await import("../dist/bridge.js");
  const { registerTools } = await import("../dist/tools.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const peer = new ExtensionBridge(PORT, TOKEN, "1.0.0");
  await peer.start();
  if (peer.role !== "peer") throw new Error(`expected to be a peer, got ${peer.role}`);
  await connected(peer);
  const server = new McpServer({ name: "mcp-teams", version: "1.0.0" });
  registerTools(server, peer, { port: PORT, token: TOKEN });
  const client = new Client({ name: "measure-memory", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const tool = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const scenarios = {
    async transcript({ chunk }) {
      let lines = 0;
      let pages = 0;
      for (let from; ; ) {
        const r = await tool("read_transcript", { meeting: MEETING, max_length: chunk, ...(from ? { from } : {}) });
        pages++;
        lines += r.transcript ? r.transcript.split("\n").length : 0;
        if (!r.continueFrom) break;
        from = r.continueFrom;
      }
      return `${lines} lines in ${pages} pages`;
    },
    async history({ page }) {
      let count = 0;
      let pages = 0;
      let last = Infinity;
      for (let cursor; ; ) {
        const r = await tool("read_messages", { conversation: CHAT, limit: page, ...(cursor ? { cursor } : {}) });
        pages++;
        count += r.messages.length;
        // Each page is older than the one before, so the pages fit together.
        if (r.messages.length && Number(r.messages.at(-1).id) >= last) throw new Error("a page overlapped the one before");
        if (r.messages.length) last = Number(r.messages[0].id);
        if (!r.olderCursor) break;
        cursor = r.olderCursor;
      }
      return `${count} messages in ${pages} pages`;
    },
  };
  const report = sampler();
  process.on("message", async (msg) => {
    if (!msg?.run) return;
    const t0 = Date.now();
    let summary;
    let error;
    try {
      summary = await scenarios[msg.run.scenario](msg.run);
    } catch (err) {
      error = err.message;
    }
    process.send({ summary, error, ms: Date.now() - t0, ...report() });
    await client.close();
    await peer.close();
    process.exit(0);
  });
  process.send({ ready: true });
} else {
  // ---------------------------------------------------------------- driver
  const sizes = { lines: opt("lines", 20_000), messages: opt("messages", 5_000), page: opt("page", 50), chunk: opt("chunk", 40_000) };
  const self = fileURLToPath(import.meta.url);
  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
  /** The child's next message; fails if it exits first. */
  const next = (c, who) =>
    new Promise((resolve, reject) => {
      const onExit = (code) => reject(new Error(`the ${who} process exited (${code}) before answering`));
      c.once("exit", onExit);
      c.once("message", (m) => (c.off("exit", onExit), resolve(m)));
    });

  const rows = [];
  let failed = false;
  for (const scenario of ["transcript", "history"]) {
    const home = mkdtempSync(join(tmpdir(), "mcp-teams-measure-"));
    const env = { ...process.env, TEAMS_MCP_HOME: home, MEASURE_PORT: String(await freePort()), MEASURE_TOKEN: randomBytes(24).toString("base64url") };
    const children = [];
    const child = async (who, extra = []) => {
      const c = spawn(process.execPath, [self, `--${who}`, ...extra], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      children.push(c);
      await next(c, who); // ready
      return c;
    };
    try {
      const hub = await child("hub");
      const ext = await child("extension", ["--lines", String(sizes.lines), "--messages", String(sizes.messages)]);
      const peer = await child("peer");
      peer.send({ run: { scenario, ...sizes } });
      const p = await next(peer, "peer");
      ext.send("report");
      const e = await next(ext, "extension");
      hub.send("report");
      const h = await next(hub, "hub");
      if (p.error) failed = true;
      console.log(`${scenario}: ${p.error ? `FAILED: ${p.error}` : p.summary}, ${p.ms} ms`);
      for (const [who, r] of [["hub", h], ["peer", p], ["extension", e]]) rows.push({ scenario, who, ...r });
      await Promise.all(children.map((c) => (c.exitCode === null ? new Promise((r) => c.once("exit", r)) : null)));
    } catch (err) {
      failed = true;
      console.log(`${scenario}: FAILED: ${err.message}`);
      for (const c of children) c.kill();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  console.log(`\nlines ${sizes.lines}, chunk ${sizes.chunk}; messages ${sizes.messages}, page ${sizes.page}; node ${process.version}\n`);
  console.log("| scenario | process | peak RSS (MB) | peak heapUsed (MB) |");
  console.log("|---|---|---:|---:|");
  for (const r of rows) console.log(`| ${r.scenario} | ${r.who} | ${r.peakRssMB.toFixed(1)} | ${r.peakHeapUsedMB.toFixed(1)} |`);
  process.exit(failed ? 1 : 0);
}
