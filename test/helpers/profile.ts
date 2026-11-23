// #253: the profile value a copy of the extension names (extension/background.js profileOf),
// worked out here with Node's own HMAC rather than the extension's code.
import { createHmac } from "node:crypto";

/** HMAC-SHA-256 of "profile:<oid>" keyed with the pairing token, base64url without padding (43 characters). */
export const keyedProfile = (token: string, oid: string) => createHmac("sha256", token).update(`profile:${oid}`).digest("base64url");
