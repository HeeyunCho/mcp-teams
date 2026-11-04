// #103: with a Teams tab open but no chat session captured, get_version says which case it looks like
// (stuck at sign-in, asleep, or a call the capture missed), from the extension's last calls. The tools
// against a scripted bridge whose extension answers status with the given object.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools.js";
import { TOKEN } from "../helpers/bridgeHarness.js";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.useRealTimers();
});

/** get_version's output, at `now`, with an extension whose status is `status`. */
async function getVersion(status: object, now: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const bridge = {
    connected: true,
    extension: { version: "0.3.44", browser: "Chrome" },
    extensions: [{ version: "0.3.44", browser: "Chrome" }],
    listenError: null,
    role: "hub",
    port: 0,
    hubVersion: null,
    call: async (method: string) => (method === "status" ? status : Promise.reject(new Error(`unexpected ${method}`))),
  } as unknown as Parameters<typeof registerTools>[1];
  const server = new McpServer({ name: "mcp-teams", version: "0.0.0" });
  registerTools(server, bridge, { port: 0, token: TOKEN });
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return JSON.parse(((await client.callTool({ name: "get_version", arguments: {} })) as { content: { text: string }[] }).content[0].text);
}

const noServices = { chatsvc: null, csa: null, mt: null, substrate: null };
/** A status with a Teams tab open and no chat session, as the extension reports it. */
const uncaptured = (calls: object, services: object = noServices) => ({
  extensionVersion: "0.3.44",
  teamsTabs: 1,
  sessions: [{ sessionCaptured: false }],
  services,
  region: null,
  signedInAs: null,
  ...calls,
});

describe("#103: get_version names why there is no session", () => {
  it("a tab whose calls were never signed in looks stuck at sign-in", async () => {
    const v = await getVersion(
      uncaptured({ lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "teams.cloud.microsoft" }, lastSignedInCall: null }),
      "2026-10-01T11:30:00Z",
    );
    expect(v.teams).toMatchObject({ lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "teams.cloud.microsoft" }, lastSignedInCall: null });
    expect(v.note).toBe(
      "The Teams tab hasn't made a signed-in call since the browser (or the extension) started; its last call (2026-10-01T10:26:37.000Z, teams.cloud.microsoft) wasn't signed in. It looks stuck at sign-in: open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).",
    );
  });

  it("unsigned calls after the last signed-in one look stuck at sign-in too", async () => {
    const v = await getVersion(
      uncaptured(
        {
          lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "go.trouter.teams.microsoft.com" },
          lastSignedInCall: { at: "2026-10-01T09:00:00.000Z", host: "teams.cloud.microsoft" },
        },
        { chatsvc: null, csa: "2026-10-01T09:00:00.000Z", mt: null, substrate: null },
      ),
      "2026-10-01T10:27:00Z",
    );
    expect(v.note).toBe(
      "The Teams tab hasn't made a signed-in call since 2026-10-01T09:00:00.000Z; its last call (2026-10-01T10:26:37.000Z, go.trouter.teams.microsoft.com) wasn't signed in. It looks stuck at sign-in: open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).",
    );
  });

  it("a tab that made no calls at all may be asleep", async () => {
    const v = await getVersion(uncaptured({ lastTeamsCall: null, lastSignedInCall: null }), "2026-10-01T10:30:00Z");
    expect(v.note).toBe(
      "The Teams tab has made no calls since the browser (or the extension) started; it may be asleep. Click into the Teams tab, or add teams.cloud.microsoft to Chrome's \"Always keep these sites active\" (Settings > Performance).",
    );
  });

  it("a tab whose last (signed-in, captured) call is more than 5 minutes old may be asleep", async () => {
    const call = { at: "2026-10-01T10:00:00.000Z", host: "teams.cloud.microsoft" };
    const v = await getVersion(
      uncaptured({ lastTeamsCall: call, lastSignedInCall: call }, { chatsvc: null, csa: "2026-10-01T10:00:00.000Z", mt: null, substrate: null }),
      "2026-10-01T10:05:01Z",
    );
    expect(v.note).toBe(
      "The Teams tab has made no calls since 2026-10-01T10:00:00.000Z; it may be asleep. Click into the Teams tab, or add teams.cloud.microsoft to Chrome's \"Always keep these sites active\" (Settings > Performance).",
    );
  });

  it("a signed-in call after the last capture looks like a capture problem", async () => {
    const v = await getVersion(
      uncaptured(
        {
          lastTeamsCall: { at: "2026-10-01T10:00:09.000Z", host: "go.trouter.teams.microsoft.com" },
          lastSignedInCall: { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" },
        },
        { chatsvc: null, csa: "2026-10-01T09:00:00.000Z", mt: null, substrate: null },
      ),
      "2026-10-01T10:00:10Z",
    );
    expect(v.note).toBe(
      "The Teams tab made a signed-in call at 2026-10-01T10:00:08.000Z (teams.cloud.microsoft), after the last session captured (2026-10-01T09:00:00.000Z), but no chat session was captured. Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again).",
    );
  });

  it("a signed-in call with nothing captured at all looks like a capture problem", async () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    const v = await getVersion(uncaptured({ lastTeamsCall: call, lastSignedInCall: call }), "2026-10-01T10:00:10Z");
    expect(v.note).toBe(
      "The Teams tab made a signed-in call at 2026-10-01T10:00:08.000Z (teams.cloud.microsoft), after the last session captured (none yet), but no chat session was captured. Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again).",
    );
  });

  it("no note once the chat session is captured, without a Teams tab, or from an extension that doesn't report its last calls", async () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    const captured = {
      ...uncaptured({ lastTeamsCall: call, lastSignedInCall: call }, { chatsvc: "2026-10-01T10:00:08.000Z", csa: null, mt: null, substrate: null }),
      sessions: [{ sessionCaptured: true }],
    };
    expect(await getVersion(captured, "2026-10-01T10:00:10Z")).not.toHaveProperty("note");
    await client?.close();
    const noTab = { ...uncaptured({ lastTeamsCall: null, lastSignedInCall: null }), teamsTabs: 0 };
    expect(await getVersion(noTab, "2026-10-01T10:00:10Z")).not.toHaveProperty("note");
    await client?.close();
    expect(await getVersion({ extensionVersion: "0.3.43", teamsTabs: 1, sessions: [{ sessionCaptured: false }], services: noServices }, "2026-10-01T10:00:10Z")).not.toHaveProperty(
      "note",
    );
  });

  // A signed-in Teams page makes unsigned calls (connection checks, config) between its signed-in ones,
  // and the capture's time and the call's are taken a moment apart.
  it("no note while Teams is starting: a signed-in call captured a moment ago, then unsigned calls", async () => {
    const v = await getVersion(
      uncaptured(
        {
          lastTeamsCall: { at: "2026-10-01T10:00:09.000Z", host: "go.trouter.teams.microsoft.com" },
          lastSignedInCall: { at: "2026-10-01T10:00:08.001Z", host: "teams.cloud.microsoft" },
        },
        { chatsvc: null, csa: "2026-10-01T10:00:08.000Z", mt: null, substrate: null },
      ),
      "2026-10-01T10:00:10Z",
    );
    expect(v).not.toHaveProperty("note");
  });
});
