// #193: the extension's size check on what it sends the hub (extension/sizes.js), as the WebSocket
// connection uses it: an answer over the limit the hub's welcome declares goes as a short error for
// that call; without a declared limit everything goes as it is. The whole path, through a real hub,
// is in test/integration/oversizedAnswer.test.ts.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the extension
import { withinLimit } from "../../extension/sizes.js";

const VIA = "WebSocket connection";
/** An answer whose JSON is exactly `bytes` long (ASCII, so characters and bytes agree). */
function answerOf(bytes: number) {
  const empty = JSON.stringify({ type: "response", id: "r1", ok: true, result: "" });
  const msg = { type: "response", id: "r1", ok: true, result: "x".repeat(bytes - empty.length) };
  const text = JSON.stringify(msg);
  expect(text.length).toBe(bytes);
  return { msg, text };
}

describe("withinLimit (#193)", () => {
  it("an answer under the limit goes as it is", () => {
    const { msg, text } = answerOf(1_000);
    expect(withinLimit(text, msg, 1_024, VIA)).toBe(msg);
  });

  it("an answer exactly at the limit goes as it is", () => {
    const { msg, text } = answerOf(1_024);
    expect(withinLimit(text, msg, 1_024, VIA)).toBe(msg);
  });

  it("an answer one byte over the limit goes as a short error for that call, which fits", () => {
    const { msg, text } = answerOf(1_025);
    const fit = withinLimit(text, msg, 1_024, VIA);
    expect(fit).toEqual({
      type: "response",
      id: "r1",
      ok: false,
      error:
        "The answer was too large to pass on over the WebSocket connection (2 KB; the limit is 1 KB). Nothing else was affected. Ask for less at once (fewer messages, a shorter range), or open it in Teams.",
    });
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(1_024);
  });

  it("counts UTF-8 bytes, not characters: 400 'ä' (800 bytes) are over a 600-byte limit", () => {
    const msg = { type: "response", id: "r1", ok: true, result: "ä".repeat(400) };
    const text = JSON.stringify(msg);
    expect(text.length).toBeLessThan(600);
    expect(withinLimit(text, msg, 600, VIA)).toMatchObject({ id: "r1", ok: false, error: expect.stringMatching(/^The answer was too large/) });
  });

  it("with a limit too small for the explanation, the error is a bare 'too large'", () => {
    const { msg, text } = answerOf(1_000);
    expect(withinLimit(text, msg, 100, VIA)).toEqual({ type: "response", id: "r1", ok: false, error: "too large" });
  });

  it("without a declared limit (a hub from before #115), even a large answer goes as it is", () => {
    const { msg, text } = answerOf(100_000);
    expect(withinLimit(text, msg, null, VIA)).toBe(msg);
  });

  it("a message over the limit that isn't an answer doesn't go at all", () => {
    const msg = { type: "gate-wait", id: "r1", pad: "x".repeat(2_000) };
    expect(withinLimit(JSON.stringify(msg), msg, 1_024, VIA)).toBeNull();
  });
});
