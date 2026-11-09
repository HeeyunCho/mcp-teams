// #103: a call that fails because a Teams session is missing says why, as get_version's note does
// (stuck at sign-in, asleep, or a call the capture missed), instead of only "Reload the Teams tab".
// isMissingSession and failedCallNote on their own; that they get the worker's own wording, and how
// the tools read status for them, is in test/integration/failedCallNote.test.ts.
import { describe, expect, it } from "vitest";
import { failedCallNote, isMissingSession, type TeamsStatus } from "../../src/sessionNote.js";

// The worker's errors for a missing session (SERVICE_HELP in extension/background.js).
const CHAT = "Teams' chat session is not available. Reload the Teams tab and try again.";
const TEAM_LIST = "Teams' team list session is not available. Reload the Teams tab and try again.";
const PEOPLE = "Teams' people session is not available. Reload the Teams tab and try again.";
const SEARCH =
  "Teams' search session is not available yet. Click into the search box at the top of Teams once (that makes Teams sign in to search), then try again.";

const noServices: Record<string, string | null> = { chatsvc: null, csa: null, mt: null, substrate: null };
/** A status with a Teams tab open and no chat session, as the extension reports it. */
const uncaptured = (calls: Pick<TeamsStatus, "lastTeamsCall" | "lastSignedInCall">, services = noServices): TeamsStatus & Record<string, unknown> => ({
  extensionVersion: "0.3.47",
  teamsTabs: 1,
  sessions: [{ sessionCaptured: false }],
  services,
  region: null,
  signedInAs: null,
  ...calls,
});
const neverSignedIn = uncaptured({ lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "teams.cloud.microsoft" }, lastSignedInCall: null });
const at = (iso: string) => Date.parse(iso);

describe("#103: isMissingSession", () => {
  it("is true for the worker's error for a missing chat, team list or people session", () => {
    expect([CHAT, TEAM_LIST, PEOPLE].map(isMissingSession)).toEqual([true, true, true]);
  });

  it("is false for search's (it has a remedy of its own) and for other errors", () => {
    expect(isMissingSession(SEARCH)).toBe(false);
    expect(isMissingSession("Teams HTTP 500 (chatsvc)")).toBe(false);
    expect(isMissingSession(`${CHAT} (after 3 tries)`)).toBe(false);
    expect(isMissingSession(`Error: ${CHAT}`)).toBe(false);
  });
});

describe("#103: failedCallNote says why the session is missing", () => {
  // The worker fails the call only after its own recovery (a background Teams tab) failed for it, so
  // the note doesn't send the user to wait for that recovery.
  it("the chat session missing, the tab never signed in: it looks stuck at sign-in, and the recovery was tried", () => {
    expect(failedCallNote(CHAT, neverSignedIn, at("2026-10-01T11:30:00Z"))).toBe(
      "Teams' chat session is not available. The Teams tab hasn't made a signed-in call since the extension started watching; its last call (2026-10-01T10:26:37.000Z, teams.cloud.microsoft) wasn't signed in. It looks stuck at sign-in. Waiting for the Teams tab, or the extension's own recovery, didn't bring the session back for this call: open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).",
    );
  });

  it("the chat session missing, unsigned calls since the last signed-in one: it looks stuck at sign-in", () => {
    const status = uncaptured(
      {
        lastTeamsCall: { at: "2026-10-01T10:26:37.000Z", host: "go.trouter.teams.microsoft.com" },
        lastSignedInCall: { at: "2026-10-01T09:00:00.000Z", host: "teams.cloud.microsoft" },
      },
      { ...noServices, csa: "2026-10-01T09:00:00.000Z" },
    );
    expect(failedCallNote(CHAT, status, at("2026-10-01T10:27:00Z"))).toBe(
      "Teams' chat session is not available. The Teams tab hasn't made a signed-in call since 2026-10-01T09:00:00.000Z; its last call (2026-10-01T10:26:37.000Z, go.trouter.teams.microsoft.com) wasn't signed in. It looks stuck at sign-in: open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).",
    );
  });

  it("the team list session missing, the tab silent: it may be asleep", () => {
    expect(failedCallNote(TEAM_LIST, uncaptured({ lastTeamsCall: null, lastSignedInCall: null }), at("2026-10-01T10:30:00Z"))).toBe(
      "Teams' team list session is not available. The Teams tab has made no calls since the extension started watching; it may be asleep. Click into the Teams tab, or add teams.cloud.microsoft to Chrome's \"Always keep these sites active\" (Settings > Performance).",
    );
  });

  it("the people session missing after a recent signed-in call: it looks like a capture problem", () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    expect(failedCallNote(PEOPLE, uncaptured({ lastTeamsCall: call, lastSignedInCall: call }), at("2026-10-01T10:00:10Z"))).toBe(
      "Teams' people session is not available. The Teams tab made a signed-in call at 2026-10-01T10:00:08.000Z (teams.cloud.microsoft), but no chat session was captured. Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again).",
    );
  });
});

describe("#103: failedCallNote is null when there is nothing to explain (the error stays)", () => {
  it("the chat session captured but the team list's missing", () => {
    const call = { at: "2026-10-01T10:00:08.000Z", host: "teams.cloud.microsoft" };
    const captured = {
      ...uncaptured({ lastTeamsCall: call, lastSignedInCall: call }, { ...noServices, chatsvc: call.at }),
      sessions: [{ sessionCaptured: true }],
    };
    expect(failedCallNote(TEAM_LIST, captured, at("2026-10-01T10:00:10Z"))).toBeNull();
  });

  it("an extension that doesn't report its last calls", () => {
    const old = { extensionVersion: "0.3.43", teamsTabs: 1, sessions: [{ sessionCaptured: false }], services: noServices };
    expect(failedCallNote(CHAT, old, at("2026-10-01T11:30:00Z"))).toBeNull();
  });

  it("no status", () => {
    expect(failedCallNote(CHAT, null, at("2026-10-01T11:30:00Z"))).toBeNull();
    expect(failedCallNote(CHAT, undefined, at("2026-10-01T11:30:00Z"))).toBeNull();
  });

  it("search's session missing, or another error", () => {
    expect(failedCallNote(SEARCH, neverSignedIn, at("2026-10-01T11:30:00Z"))).toBeNull();
    expect(failedCallNote("Teams HTTP 500 (chatsvc)", neverSignedIn, at("2026-10-01T11:30:00Z"))).toBeNull();
  });
});
