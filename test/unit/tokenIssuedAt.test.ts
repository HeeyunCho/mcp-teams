// teams.tokenIssuedAt: when a captured request's token was issued (#77), from the same token whose
// user tokenOid names, so a capture's age and its user always come from one token.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the extension
import * as teams from "../../extension/teams.js";

const OID = "00000000-0000-4000-8000-0000000000a1";
const IAT = 1_790_000_000;
const b64url = (s: string) => Buffer.from(s).toString("base64url");
/** An unsigned JWT whose payload is `payload` as is (JSON text or anything else). */
const jwt = (payload: string) => `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(payload)}.`;
const claims = (c: object) => jwt(JSON.stringify(c));

describe("#77: tokenIssuedAt", () => {
  it("reads iat from an AAD bearer token, and from a skype token as authentication or x-skypetoken", () => {
    expect(teams.tokenIssuedAt({ authorization: `Bearer ${claims({ oid: OID, iat: IAT })}` })).toBe(IAT);
    expect(teams.tokenIssuedAt({ authentication: `skypetoken=${claims({ skypeid: `orgid:${OID}`, iat: IAT })}` })).toBe(IAT);
    expect(teams.tokenIssuedAt({ "x-skypetoken": claims({ skypeid: `orgid:${OID}`, iat: IAT }) })).toBe(IAT);
  });

  it("is null for a token without iat, or with one that isn't a number", () => {
    for (const iat of [undefined, "1790000000", null, true]) {
      expect(teams.tokenIssuedAt({ authorization: `Bearer ${claims({ oid: OID, iat })}` })).toBeNull();
    }
    expect(teams.tokenIssuedAt(undefined)).toBeNull();
    expect(teams.tokenIssuedAt({})).toBeNull();
    expect(teams.tokenIssuedAt({ authorization: "Bearer fake" })).toBeNull();
    expect(teams.tokenIssuedAt({ authorization: `Bearer ${jwt("not json")}` })).toBeNull();
  });

  it("with several token headers, reads the one whose oid tokenOid picks (the first that holds one)", () => {
    const headers = {
      authorization: `Bearer ${claims({ oid: OID, iat: IAT })}`,
      authentication: `skypetoken=${claims({ skypeid: `orgid:${OID}`, iat: IAT + 600 })}`,
    };
    expect(teams.tokenOid(headers)).toBe(OID);
    expect(teams.tokenIssuedAt(headers)).toBe(IAT);
  });

  it("skips a token that has an iat but no oid, as tokenOid does: the iat is the oid's token's", () => {
    const headers = {
      authorization: `Bearer ${claims({ aud: "https://example.invalid", iat: IAT - 600 })}`,
      authentication: `skypetoken=${claims({ skypeid: `orgid:${OID}`, iat: IAT })}`,
    };
    expect(teams.tokenOid(headers)).toBe(OID);
    expect(teams.tokenIssuedAt(headers)).toBe(IAT);
  });

  it("is null when the token tokenOid picks has no iat, even if another header's token has one", () => {
    const headers = {
      authorization: `Bearer ${claims({ oid: OID })}`,
      "x-skypetoken": claims({ skypeid: `orgid:${OID}`, iat: IAT }),
    };
    expect(teams.tokenOid(headers)).toBe(OID);
    expect(teams.tokenIssuedAt(headers)).toBeNull();
  });

  it("is null when no token names a user (tokenOid is null)", () => {
    expect(teams.tokenIssuedAt({ authorization: `Bearer ${claims({ oid: "alex", iat: IAT })}` })).toBeNull();
  });
});
