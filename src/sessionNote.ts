/**
 * Why a browser with a Teams tab open has no chat session (#103), from the extension's status: when
 * the tab last made a call, and when it last made a signed-in one. The three cases each need another
 * fix from the user, and only the last is ours.
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

const SINCE_START = "the browser (or the extension) started";

/** A signed-in Teams page calls its services every few seconds; a tab silent for longer than this may be asleep. */
export const IDLE_MS = 5 * 60_000;
/** A capture's time and the call's are taken a moment apart (two listeners of the same request). */
const CAPTURE_SLACK_MS = 1_000;

/** The note for get_version, or null when there is nothing to explain (or an older extension doesn't say). */
export function sessionNote(status: TeamsStatus | null | undefined, now: number): string | null {
  if (!status || !((status.teamsTabs ?? 0) > 0) || status.sessions?.some((s) => s.sessionCaptured)) return null;
  if (!("lastTeamsCall" in status)) return null; // an extension from before #103
  const last = status.lastTeamsCall ?? null;
  const signedIn = status.lastSignedInCall ?? null;
  const captures = Object.values(status.services ?? {}).filter((at): at is string => !!at).map(Date.parse);
  const lastCapture = captures.length ? Math.max(...captures) : null;
  if (signedIn && (lastCapture === null || Date.parse(signedIn.at) > lastCapture + CAPTURE_SLACK_MS)) {
    return (
      `The Teams tab made a signed-in call at ${signedIn.at} (${signedIn.host}), ` +
      `after the last session captured (${lastCapture === null ? "none yet" : new Date(lastCapture).toISOString()}), but no chat session was captured. ` +
      "Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: " +
      "please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again)."
    );
  }
  // Unsigned calls only (a signed-in page makes unsigned ones too, between signed-in ones every few seconds).
  if (last && (!signedIn || Date.parse(last.at) - Date.parse(signedIn.at) > IDLE_MS)) {
    return (
      `The Teams tab hasn't made a signed-in call since ${signedIn ? signedIn.at : SINCE_START}; ` +
      `its last call (${last.at}, ${last.host}) wasn't signed in. ` +
      "It looks stuck at sign-in: open the Teams tab and finish signing in (an account picker, a sign-in page or a prompt may be waiting there)."
    );
  }
  if (!last || now - Date.parse(last.at) > IDLE_MS) {
    return (
      `The Teams tab has made no calls since ${last ? last.at : SINCE_START}; it may be asleep. ` +
      `Click into the Teams tab, or add teams.cloud.microsoft to Chrome's "Always keep these sites active" (Settings > Performance).`
    );
  }
  // Its last call was signed in and captured (for another service) a moment ago: Teams is still starting.
  return null;
}
