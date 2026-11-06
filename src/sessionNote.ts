/**
 * Why a browser with a Teams tab open has no chat session (#103), from the extension's status: when
 * the tab last made a call, and when it last made a signed-in one (to a service whose session is
 * captured). The three cases each need another fix from the user, and only the last is ours.
 */

/** A call as the extension reports it: when (ISO) and to which host. */
type Call = { at: string; host: string } | null;

export type TeamsStatus = {
  teamsTabs?: number;
  sessions?: { sessionCaptured?: boolean }[];
  services?: Record<string, string | null>;
  lastTeamsCall?: Call;
  lastSignedInCall?: Call;
};

const SINCE_START = "the extension started watching";

const FINISH_SIGN_IN = "open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there).";

/** A signed-in Teams page calls its services every few seconds; a tab silent for longer than this may be asleep. */
export const IDLE_MS = 5 * 60_000;

/**
 * Where the note goes: get_version's output, or the error of a call that found no session. The worker
 * fails such a call only after its own recovery (a background Teams tab) failed for it.
 */
export type NoteFor = "get_version" | "failed call";

/** The note, or null when there is nothing to explain (or an older extension doesn't say). */
export function sessionNote(status: TeamsStatus | null | undefined, now: number, noteFor: NoteFor = "get_version"): string | null {
  if (!status || !status.teamsTabs || status.sessions?.some((s) => s.sessionCaptured)) return null;
  if (!("lastTeamsCall" in status)) return null; // an extension from before #103
  const last = status.lastTeamsCall ?? null;
  const signedIn = status.lastSignedInCall ?? null;
  // Stuck at sign-in: no signed-in call, or none for a while although the tab keeps calling (a
  // signed-in page makes unsigned calls too, between signed-in ones every few seconds).
  if (last && (!signedIn || Date.parse(last.at) - Date.parse(signedIn.at) > IDLE_MS)) {
    const stuck = `The Teams tab hasn't made a signed-in call since ${signedIn ? signedIn.at : SINCE_START}; its last call (${last.at}, ${last.host}) wasn't signed in. `;
    // No signed-in call since the extension started: right after a browser start or an extension
    // load, a tab that signed in before the extension listened looks like this until the extension's
    // own recovery (a 15 s grace, then a background Teams tab for up to a minute) brings the session back.
    if (!signedIn && noteFor === "failed call") {
      return `${stuck}It looks stuck at sign-in. The extension already tried to bring the session back for this call: ${FINISH_SIGN_IN}`;
    }
    if (!signedIn) {
      return (
        stuck +
        "It looks stuck at sign-in. Within about a minute and a half of the browser or the extension starting, the extension tries to bring the session back by itself; " +
        `if get_version still says so after that, ${FINISH_SIGN_IN}`
      );
    }
    return `${stuck}It looks stuck at sign-in: ${FINISH_SIGN_IN}`;
  }
  if (!last || now - Date.parse(last.at) > IDLE_MS) {
    return (
      `The Teams tab has made no calls since ${last ? last.at : SINCE_START}; it may be asleep. ` +
      `Click into the Teams tab, or add teams.cloud.microsoft to Chrome's "Always keep these sites active" (Settings > Performance).`
    );
  }
  // Here the tab made a recent signed-in call (to a service whose session is captured), yet chatsvc's
  // session (sessionCaptured) is missing.
  if (signedIn) {
    return (
      `The Teams tab made a signed-in call at ${signedIn.at} (${signedIn.host}), but no chat session was captured. ` +
      "Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: " +
      "please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again)."
    );
  }
  return null;
}

/**
 * The worker's error for a call that found no chat, team list or people session (SERVICE_HELP in
 * extension/background.js), up to its generic remedy. Search's (substrate) has a remedy of its own.
 */
const MISSING_SESSION = /^(Teams' (?:chat|team list|people) session is not available\.) Reload the Teams tab and try again\.$/;

/** Whether a failed call's error is a missing session that sessionNote may explain. */
export const isMissingSession = (message: string) => MISSING_SESSION.test(message);

/**
 * A failed call's error with the generic remedy replaced by sessionNote's, or null to keep the error
 * as it is (not a missing session, or nothing to explain).
 */
export function failedCallNote(message: string, status: TeamsStatus | null | undefined, now: number): string | null {
  const missing = MISSING_SESSION.exec(message);
  const note = missing && sessionNote(status, now, "failed call");
  return note ? `${missing[1]} ${note}` : null;
}
