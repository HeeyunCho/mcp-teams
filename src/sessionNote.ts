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

const SINCE_START = "the browser (or the extension) started";

/** A signed-in Teams page calls its services every few seconds; a tab silent for longer than this may be asleep. */
export const IDLE_MS = 5 * 60_000;

/** The note for get_version, or null when there is nothing to explain (or an older extension doesn't say). */
export function sessionNote(status: TeamsStatus | null | undefined, now: number): string | null {
  if (!status || !((status.teamsTabs ?? 0) > 0) || status.sessions?.some((s) => s.sessionCaptured)) return null;
  if (!("lastTeamsCall" in status)) return null; // an extension from before #103
  const last = status.lastTeamsCall ?? null;
  const signedIn = status.lastSignedInCall ?? null;
  // Stuck at sign-in: no signed-in call, or none for a while although the tab keeps calling (a
  // signed-in page makes unsigned calls too, between signed-in ones every few seconds).
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
  // sessionCaptured is chatsvc's session: a signed-in call after its capture (or with none) should have given one.
  const chatAt = status.services?.chatsvc ? Date.parse(status.services.chatsvc) : null;
  if (signedIn && (chatAt === null || Date.parse(signedIn.at) > chatAt)) {
    return (
      `The Teams tab made a signed-in call at ${signedIn.at} (${signedIn.host}), but no chat session was captured. ` +
      "Refresh the Teams tab or reload the extension; if that doesn't help, this looks like a capture problem: " +
      "please report it with api_traffic output (call it with record: true, use Teams for a minute, then call it again)."
    );
  }
  return null;
}
