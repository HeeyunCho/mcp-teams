// Joins the slices of a message the native host split (#123, src/native.ts toExtensionFrames):
// Chrome passes at most 1 MB per message from a host, so the host sends a larger one as
// {type:"chunk", id, seq, last, data}, `data` being a slice of the message's JSON text and `seq`
// counting from 0. A set that is incomplete after CHUNK_TTL_MS, arrives out of order or grows
// past CHUNK_MAX_CHARS is dropped.
//
// Ported from mcp-newoutlook extension/chunks.js (Reassembler; commit df54b52). The limit is the
// largest message this extension takes (its hello's maxMessageBytes).

/** Chrome's limit for one message from the extension to its native host (64 MiB). */
export const NATIVE_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** The largest message joined (the JSON text's length). */
export const CHUNK_MAX_CHARS = 256 * 1024 * 1024;
/** How long a set may take to arrive completely. */
export const CHUNK_TTL_MS = 60_000;

export class Reassembler {
  /** id -> { parts, next, size, timer, dropped } */
  #sets = new Map();
  #maxChars;
  #ttlMs;

  constructor({ maxChars = CHUNK_MAX_CHARS, ttlMs = CHUNK_TTL_MS } = {}) {
    this.#maxChars = maxChars;
    this.#ttlMs = ttlMs;
  }

  /** Adds one chunk; returns the whole message's text when this slice completes it, else null. */
  add(chunk) {
    const { id, seq, last, data } = chunk ?? {};
    if ((typeof id !== "string" && typeof id !== "number") || !Number.isInteger(seq) || seq < 0 || typeof data !== "string") return null;
    let set = this.#sets.get(id);
    if (!set) {
      if (seq !== 0) return null; // the start of this set is missing (or it was dropped and forgotten)
      set = { parts: [], next: 0, size: 0, dropped: false, timer: setTimeout(() => this.#forget(id, set), this.#ttlMs) };
      this.#sets.set(id, set);
    }
    if (set.dropped) {
      // The rest of a dropped set is ignored, until its last slice frees the id.
      if (last) this.#forget(id, set);
      return null;
    }
    if (seq !== set.next || set.size + data.length > this.#maxChars) {
      set.parts = [];
      set.dropped = true;
      if (last) this.#forget(id, set);
      return null;
    }
    set.parts.push(data);
    set.next++;
    set.size += data.length;
    if (!last) return null;
    this.#forget(id, set);
    return set.parts.join("");
  }

  /** Drops every set (the connection closed). */
  clear() {
    for (const s of this.#sets.values()) clearTimeout(s.timer);
    this.#sets.clear();
  }

  #forget(id, set) {
    clearTimeout(set.timer);
    if (this.#sets.get(id) === set) this.#sets.delete(id);
  }
}
