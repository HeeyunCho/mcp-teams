// Chrome's native-messaging framing (#123, ADR 0001): a 4-byte little-endian length, then UTF-8
// JSON; host → extension messages over Chrome's 1 MB limit travel as chunks. And where servers
// reach the native host: the hub socket, or on Windows a named pipe per user (decision 10).
// Ported from mcp-newoutlook test/unit/native.test.ts (commit 7ef8ac9).
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_DATA_BYTES,
  encodeFrame,
  FrameDecoder,
  hubSocketPath,
  MAX_TO_EXTENSION_BYTES,
  msFromEnv,
  socketNeedsProof,
  toExtensionFrames,
} from "../../src/native.js";

/** Reads frames the way Chrome does, independently of the code under test. */
function readFrames(buf: Buffer): any[] {
  const out: any[] = [];
  for (let at = 0; at < buf.length; ) {
    const len = buf.readUInt32LE(at);
    out.push(JSON.parse(buf.subarray(at + 4, at + 4 + len).toString("utf8")));
    at += 4 + len;
  }
  return out;
}

/** Joins chunk messages the way the extension will: by id, in seq order, until last. */
function joinChunks(chunks: any[]): string {
  const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
  expect(new Set(sorted.map((c) => c.id)).size).toBe(1);
  expect(sorted.map((c) => c.seq)).toEqual(sorted.map((_, i) => i));
  expect(sorted.map((c) => c.last)).toEqual(sorted.map((_, i) => i === sorted.length - 1));
  return sorted.map((c) => c.data).join("");
}

describe("#123: native framing", () => {
  it("encodes a 4-byte little-endian length, then the UTF-8 JSON", () => {
    const frame = encodeFrame('{"type":"welcome","note":"Grüße"}');
    // 35 bytes: ü and ß are two bytes each in UTF-8.
    expect([...frame.subarray(0, 4)]).toEqual([35, 0, 0, 0]);
    expect(frame.subarray(4).toString("utf8")).toBe('{"type":"welcome","note":"Grüße"}');
  });

  it("decodes frames split at any byte and several frames in one chunk", () => {
    const msgs = [{ type: "hello", version: "1.0.0" }, { type: "response", id: "a", ok: true, result: { s: "가".repeat(300) } }, { type: "ping" }];
    const all = Buffer.concat(msgs.map((m) => encodeFrame(JSON.stringify(m))));
    for (const step of [1, 3, 7, all.length]) {
      const got: any[] = [];
      const d = new FrameDecoder((f) => got.push(JSON.parse(f.toString("utf8"))));
      for (let i = 0; i < all.length; i += step) d.push(all.subarray(i, i + step));
      expect(got).toEqual(msgs);
    }
  });

  it("skips a frame over the limit without buffering it, and reports it", () => {
    const got: any[] = [];
    const over: number[] = [];
    const d = new FrameDecoder((f) => got.push(JSON.parse(f.toString())), 100, (n) => over.push(n));
    const big = encodeFrame(JSON.stringify({ type: "response", data: "x".repeat(500) }));
    d.push(big.subarray(0, 200));
    d.push(Buffer.concat([big.subarray(200), encodeFrame('{"type":"ping"}')]));
    expect(over).toEqual([big.length - 4]);
    expect(got).toEqual([{ type: "ping" }]);
  });

  it("decodes a length header split after 1, 2 or 3 bytes", () => {
    for (const cut of [1, 2, 3]) {
      const got: string[] = [];
      const d = new FrameDecoder((f) => got.push(f.toString("utf8")));
      const frame = encodeFrame('{"type":"ping"}');
      d.push(frame.subarray(0, cut));
      expect(got).toEqual([]);
      d.push(frame.subarray(cut));
      expect(got).toEqual(['{"type":"ping"}']);
    }
  });

  it("decodes a frame that ends mid-chunk, with the next frame's start in the same chunk", () => {
    const got: string[] = [];
    const d = new FrameDecoder((f) => got.push(f.toString("utf8")));
    const all = Buffer.concat([encodeFrame('{"a":1}'), encodeFrame('{"b":"two"}'), encodeFrame('{"c":3}')]);
    // Chunk 1 holds part of frame 1; chunk 2 ends inside frame 2's payload; chunk 3 ends inside frame 3's header.
    const cuts = [5, 4 + 7 + 4 + 3, 4 + 7 + 4 + 11 + 2, all.length];
    let at = 0;
    for (const cut of cuts) d.push(all.subarray(at, (at = cut)));
    expect(got).toEqual(['{"a":1}', '{"b":"two"}', '{"c":3}']);
  });

  it("decodes a zero-length frame", () => {
    const got: Buffer[] = [];
    const d = new FrameDecoder((f) => got.push(f));
    d.push(Buffer.concat([encodeFrame(""), encodeFrame("x"), encodeFrame("")]));
    expect(got.map((f) => f.toString("utf8"))).toEqual(["", "x", ""]);
  });

  it("skips oversize frames whose headers and bodies arrive in pieces, and decodes the frames between and after them", () => {
    const got: string[] = [];
    const over: number[] = [];
    const d = new FrameDecoder((f) => got.push(f.toString("utf8")), 10, (n) => over.push(n));
    const all = Buffer.concat([encodeFrame("a".repeat(50)), encodeFrame("ok"), encodeFrame("b".repeat(11)), encodeFrame("fine")]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    expect(over).toEqual([50, 11]);
    expect(got).toEqual(["ok", "fine"]);
  });

  it("keeps its place in the stream when onFrame throws: the rest of the chunk waits for the next push", () => {
    const got: string[] = [];
    const d = new FrameDecoder((f) => {
      const s = f.toString("utf8");
      if (s === "boom") throw new Error("listener failed");
      got.push(s);
    });
    const all = Buffer.concat([encodeFrame("boom"), encodeFrame("after"), encodeFrame("third")]);
    // One chunk holds "boom", "after" and the start of "third"; the next chunk the rest.
    const cut = all.length - 3;
    expect(() => d.push(all.subarray(0, cut))).toThrow("listener failed");
    d.push(all.subarray(cut));
    expect(got).toEqual(["after", "third"]);
  });

  it("keeps byte order when onFrame pushes again: the outer chunk's rest comes before the new bytes", () => {
    const got: string[] = [];
    const later = Buffer.concat([encodeFrame("third")]);
    let pushed = false;
    const d: FrameDecoder = new FrameDecoder((f) => {
      got.push(f.toString("utf8"));
      if (!pushed) {
        pushed = true;
        d.push(later);
      }
    });
    d.push(Buffer.concat([encodeFrame("first"), encodeFrame("second")]));
    expect(got).toEqual(["first", "second", "third"]);
  });

  describe("a 20 MB frame arriving in 64 KB chunks (stdin's read size)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is decoded intact, copying its bytes a bounded number of times rather than once per chunk", () => {
      const size = 20 * 1024 * 1024;
      const payload = Buffer.alloc(size);
      for (let i = 0; i < size; i += 4096) payload[i] = (i / 4096) & 0xff;
      const all = Buffer.concat([encodeFrame(payload), encodeFrame("next")]);
      const got: Buffer[] = [];
      const d = new FrameDecoder((f) => got.push(f));

      // Count the bytes copied through Buffer's copying APIs.
      let copied = 0;
      const concat = Buffer.concat;
      vi.spyOn(Buffer, "concat").mockImplementation((list: readonly Uint8Array[], total?: number) => {
        const out = concat(list, total);
        copied += out.length;
        return out;
      });
      const copy = Buffer.prototype.copy;
      vi.spyOn(Buffer.prototype as { copy(...args: unknown[]): number }, "copy").mockImplementation(function (this: Buffer, ...args: unknown[]) {
        const n = copy.apply(this, args as Parameters<Buffer["copy"]>);
        copied += n;
        return n;
      });
      const set = Uint8Array.prototype.set;
      vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (this: Uint8Array, src: ArrayLike<number>, offset?: number) {
        copied += src.length;
        return set.call(this, src, offset);
      });
      const from = Buffer.from;
      vi.spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
        const out = (from as (...a: unknown[]) => Buffer)(...args);
        if (args[0] instanceof Uint8Array) copied += out.length;
        return out;
      }) as typeof Buffer.from);

      const CHUNK = 64 * 1024;
      for (let i = 0; i < all.length; i += CHUNK) d.push(all.subarray(i, i + CHUNK));
      vi.restoreAllMocks();

      expect(got).toHaveLength(2);
      expect(got[0].equals(payload)).toBe(true);
      expect(got[1].toString("utf8")).toBe("next");
      // Each payload byte is copied once (#168); only the 4-byte headers may be copied besides.
      expect(copied).toBeLessThanOrEqual(all.length);
    });
  });

  it("sends a message up to 1 MB as one frame", () => {
    const text = JSON.stringify({ type: "request", id: "r1", params: { s: "x".repeat(1000) } });
    const frames = toExtensionFrames(text);
    expect(frames).toHaveLength(1);
    expect(readFrames(frames[0])).toEqual([JSON.parse(text)]);
  });

  it("splits a 2.5 MB message into chunks of at most 512 KB, each frame under 1 MB, that join back to it", () => {
    // Multi-byte characters, a surrogate pair and characters JSON escapes, so byte and character counts differ.
    const params = { chatId: "19:alex-doe@contoso.example", text: ('ab"c\\d€😀\n안녕' + "x".repeat(990)).repeat(2_600) };
    const text = JSON.stringify({ type: "request", id: "r2", method: "requestSend", params });
    expect(Buffer.byteLength(text)).toBeGreaterThan(2.5 * 1024 * 1024);
    const frames = toExtensionFrames(text);
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const f of frames) expect(f.length - 4).toBeLessThanOrEqual(MAX_TO_EXTENSION_BYTES);
    const chunks = frames.flatMap(readFrames);
    for (const c of chunks) {
      expect(c.type).toBe("chunk");
      expect(Buffer.byteLength(c.data)).toBeLessThanOrEqual(CHUNK_DATA_BYTES);
    }
    expect(joinChunks(chunks)).toBe(text);
    expect(JSON.parse(joinChunks(chunks)).params).toEqual(params);
  });

  it("gives every split message its own chunk id", () => {
    const text = JSON.stringify({ data: "y".repeat(1.5 * 1024 * 1024) });
    const a = toExtensionFrames(text).flatMap(readFrames);
    const b = toExtensionFrames(text).flatMap(readFrames);
    expect(a[0].id).not.toBe(b[0].id);
  });

  it("is 1 MB and 512 KB, Chrome's limit and the slice size", () => {
    expect(MAX_TO_EXTENSION_BYTES).toBe(1_048_576);
    expect(CHUNK_DATA_BYTES).toBe(524_288);
  });
});

describe("#123: the host's timings from its environment (TEAMS_MCP_HUB_*_MS)", () => {
  it("takes a whole number of milliseconds above 0", () => {
    expect(msFromEnv("600")).toBe(600);
    expect(msFromEnv("30000")).toBe(30_000);
    expect(msFromEnv(" 600 ")).toBe(600);
  });

  it("takes only plain digits: no exponent, hex, binary, sign or decimal point", () => {
    for (const v of ["1e3", "1E3", "0x10", "0b11", "0o7", "+600", "600.0", "6_00", "1e12"]) expect(msFromEnv(v), v).toBeUndefined();
  });

  it("leaves the default for anything else: missing, empty, 0, negative, not a number, a fraction", () => {
    for (const v of [undefined, "", " ", "0", "-5", "abc", "Infinity", "NaN", "1.5", "600.0001", "1e-3"]) expect(msFromEnv(v), String(v)).toBeUndefined();
  });

  it("clamps to Node's longest timer, 2^31-1 ms (about 24.8 days): longer ones would fire at once", () => {
    expect(msFromEnv("2147483647")).toBe(2_147_483_647);
    expect(msFromEnv("2147483648")).toBe(2_147_483_647);
    // 309 digits (about 1e308) and 400 digits (past what a double holds, so Number gives Infinity) alike.
    expect(msFromEnv("1" + "0".repeat(308))).toBe(2_147_483_647);
    expect(msFromEnv("9".repeat(400))).toBe(2_147_483_647);
  });
});

describe("#123: hub socket", () => {
  it("is ~/.mcp-teams/hub.sock on macOS and Linux", () => {
    expect(hubSocketPath({ platform: "darwin", configDir: "/Users/alex/.mcp-teams", user: "alex", env: {} })).toBe(join("/Users/alex/.mcp-teams", "hub.sock"));
    expect(hubSocketPath({ platform: "linux", configDir: "/home/alex/.mcp-teams", user: "alex", env: {} })).toBe(join("/home/alex/.mcp-teams", "hub.sock"));
  });

  it("is a named pipe on Windows: the username's ASCII characters, then the first 8 hex of its SHA-256", () => {
    // sha256("Alex Doe") = 3f3079ee…, worked out with sha256sum, not by the code under test.
    expect(hubSocketPath({ platform: "win32", configDir: "C:\\Users\\Alex Doe\\.mcp-teams", user: "Alex Doe", env: {} })).toBe(
      "\\\\.\\pipe\\mcp-teams-AlexDoe-3f3079ee",
    );
  });

  it("decision 10: two all-Korean usernames of the same length get different pipes", () => {
    const a = hubSocketPath({ platform: "win32", configDir: "x", user: "홍길동", env: {} });
    const b = hubSocketPath({ platform: "win32", configDir: "x", user: "김철수", env: {} });
    expect(a).toMatch(/^\\\\\.\\pipe\\mcp-teams--[0-9a-f]{8}$/);
    expect(b).toMatch(/^\\\\\.\\pipe\\mcp-teams--[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    // And the same user always gets the same pipe (a server and the host must meet there).
    expect(hubSocketPath({ platform: "win32", configDir: "y", user: "홍길동", env: {} })).toBe(a);
  });

  it("can be moved for tests (TEAMS_MCP_HUB_SOCKET)", () => {
    expect(hubSocketPath({ platform: "win32", configDir: "x", user: "alex", env: { TEAMS_MCP_HUB_SOCKET: "\\\\.\\pipe\\t1" } })).toBe("\\\\.\\pipe\\t1");
  });

  it("decision 10: peers prove the pairing token only on Windows, where a named pipe can't be made owner-only", () => {
    expect(socketNeedsProof("win32")).toBe(true);
    expect(socketNeedsProof("darwin")).toBe(false);
    expect(socketNeedsProof("linux")).toBe(false);
  });
});
