// The worker's transcript cache (3.4, #19): bounded by bytes, not by entry count.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the extension
import * as teams from "../../extension/teams.js";

const MB = 1024 * 1024;

/** A fictional transcript.json of about `size` characters, as OneDrive sends it. */
function bigTranscript(n: number, size: number) {
  const line = `The plan for Contoso review ${n} is still being worked out by the team this week. `;
  const entries = [];
  for (let length = 0, i = 0; length < size; i++) {
    const entry = { speakerDisplayName: i % 2 ? "Sam Roe" : "Alex Doe", startOffset: "00:00:01.0", endOffset: "00:00:09.0", text: line.repeat(20) };
    length += JSON.stringify(entry).length + 1;
    entries.push(entry);
  }
  const text = JSON.stringify({ entries });
  return { json: JSON.parse(text), bytes: text.length };
}

describe("3.4: a cache bounded by bytes", () => {
  it("3.4: after 100 large transcripts, the cache holds at most its cap in bytes", () => {
    const cap = 8 * MB;
    const cache = new teams.ByteCache(cap);
    for (let n = 1; n <= 100; n++) {
      const { json, bytes } = bigTranscript(n, 1 * MB);
      cache.set(`t${n}`, json, bytes);
      expect(cache.bytes).toBeLessThanOrEqual(cap);
    }
    expect(cache.bytes).toBeLessThanOrEqual(cap);
    // It still caches: the newest transcripts that fit are kept, the oldest are gone.
    expect(cache.size).toBeGreaterThanOrEqual(6);
    expect(cache.get("t100")).toBeDefined();
    expect(cache.get("t99")).toBeDefined();
    expect(cache.get("t1")).toBeUndefined();
  });

  it("3.4: eviction is least recently used: reading an entry keeps it", () => {
    const cache = new teams.ByteCache(3_000);
    cache.set("a", { n: "a" }, 1_000);
    cache.set("b", { n: "b" }, 1_000);
    cache.set("c", { n: "c" }, 1_000);
    expect(cache.get("a")).toEqual({ n: "a" }); // a is now the most recent
    cache.set("d", { n: "d" }, 1_000); // evicts b, the least recently used
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual({ n: "a" });
    expect(cache.get("c")).toEqual({ n: "c" });
    expect(cache.get("d")).toEqual({ n: "d" });
    expect(cache.bytes).toBe(3_000);
  });

  it("3.4: an entry bigger than the cap is not cached, and evicts nothing", () => {
    const cache = new teams.ByteCache(3_000);
    cache.set("a", { n: "a" }, 1_000);
    cache.set("huge", { n: "huge" }, 3_001);
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("a")).toEqual({ n: "a" });
    expect(cache.bytes).toBe(1_000);
  });

  it("3.4: setting a key again replaces it, counted once", () => {
    const cache = new teams.ByteCache(3_000);
    cache.set("a", { v: 1 }, 1_000);
    cache.set("a", { v: 2 }, 2_000);
    expect(cache.get("a")).toEqual({ v: 2 });
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(2_000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
