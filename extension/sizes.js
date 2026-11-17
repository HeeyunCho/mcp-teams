// The size check on what the extension sends the hub (native messaging and WebSocket alike, #193):
// an answer larger than the hub takes would get the whole connection dropped, and every call on
// it failed, so that one call is answered with a short error instead.

export const formatSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
/** `text`'s UTF-8 size, or its length when even 3 bytes a character stay within `max` (no need to count). */
export const utf8Bytes = (text, max) => (text.length * 3 <= max ? text.length : new TextEncoder().encode(text).length);

/**
 * The answer that goes instead of one too large for the connection (`via`: "native connection",
 * "WebSocket connection"): the hub would drop the whole connection on it (or Chrome refuse it),
 * and the call would wait for its time limit. Wording as mcp-newoutlook's dispatch (commit cf8cc72).
 */
export const tooLarge = (id, detail, via = "native connection") => ({
  type: "response",
  id,
  ok: false,
  error: `The answer was too large to pass on over the ${via} (${detail}). Nothing else was affected. Ask for less at once (fewer messages, a shorter range), or open it in Teams.`,
});

/**
 * The error answer for request `id` that fits within `max` bytes: the full explanation, else a
 * bare "too large" (a hub that declares a tiny limit); null when not even that fits.
 */
export function fitting(id, detail, max, via) {
  for (const reply of [tooLarge(id, detail, via), { type: "response", id, ok: false, error: "too large" }]) {
    if (utf8Bytes(JSON.stringify(reply), max) <= max) return reply;
  }
  return null;
}

/**
 * What goes to the hub for message `msg`, whose JSON is `text`, on a connection that takes at
 * most `max` bytes (null or 0: the hub declared no limit, so it goes as it is): the message, or
 * for an answer over the limit the short error (see fitting); null when nothing should go (a
 * message other than an answer over the limit, or not even the bare error fits).
 */
export function withinLimit(text, msg, max, via) {
  if (!(max > 0)) return msg;
  const bytes = utf8Bytes(text, max);
  if (bytes <= max) return msg;
  if (msg?.type !== "response") return null;
  return fitting(msg.id, `${formatSize(bytes)}; the limit is ${formatSize(max)}`, max, via);
}
