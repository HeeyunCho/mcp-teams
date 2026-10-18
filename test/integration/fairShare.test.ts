// Sessions share the Teams tab fairly: the hub lets a limited number of calls run on each
// extension at once, and a freed turn goes round the sessions (the hub's own calls are one
// session, each peer another), so one session's long scans can't starve another's quick read.
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHarness, FAST, until, type BridgeHarness, type Request } from "../helpers/bridgeHarness.js";

let h: BridgeHarness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Teams tab that works on one request at a time, in the order they arrive: a scan takes
 * scanMs, anything else readMs. So what it is sent first finishes first.
 */
function oneAtATime(scanMs: number, readMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  return (req: Request) => {
    const work = chain.then(() => sleep(req.method === "searchTranscripts" ? scanMs : readMs).then(() => ({ ok: true, method: req.method })));
    chain = work;
    return work;
  };
}

describe("fair sharing", () => {
  it("2.4: one session's 10 slow scans don't starve another session's read: it finishes before the 3rd scan", async () => {
    h = await bridgeHarness({ ...FAST, maxConcurrentCalls: 2 });
    const a = await h.session(); // the hub: its own calls are one session
    const ext = await h.extension({ handle: oneAtATime(150, 10) });
    const b = await h.session(); // a peer: another session
    await until(() => a.connected && b.connected, 3_000, "both sessions see the extension");

    const scansDone: number[] = [];
    const scans = Array.from({ length: 10 }, (_, i) =>
      a.call("searchTranscripts", { query: `contoso ${i}` }, 30_000).then(() => (scansDone[i] = Date.now())),
    );
    await until(() => ext.requests().length >= 1, 3_000, "the first scan reaches the extension");
    let readDone = 0;
    const read = b.call("listChats", {}, 30_000).then(() => (readDone = Date.now()));

    await Promise.all([...scans, read]);
    expect(readDone, "B's read finished before A's 3rd scan").toBeLessThan(scansDone[2]);
  }, 15_000);
});
