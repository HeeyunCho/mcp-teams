// teams.tokenOid: whose session a captured request is (3.3), from its token's payload only.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the extension
import * as teams from "../../extension/teams.js";

const OID = "00000000-0000-4000-8000-0000000000a1";
const b64url = (s: string) => Buffer.from(s).toString("base64url");
/** An unsigned JWT whose payload is `payload` as is (JSON text or anything else). */
const jwt = (payload: string) => `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(payload)}.`;

describe("3.3: tokenOid", () => {
  it("reads oid from an AAD bearer token", () => {
    expect(teams.tokenOid({ authorization: `Bearer ${jwt(JSON.stringify({ tid: "00000000-0000-4000-8000-0000000000a0", oid: OID }))}` })).toBe(OID);
  });

  it("decodes a payload whose base64url has no padding (its length isn't a multiple of 4)", () => {
    const payload = JSON.stringify({ oid: OID, x: "ab" });
    expect(b64url(payload).length % 4).not.toBe(0);
    expect(teams.tokenOid({ authorization: `Bearer ${jwt(payload)}` })).toBe(OID);
  });

  it("reads a skype token's skypeid (orgid:<oid>), as authentication or x-skypetoken", () => {
    const skype = jwt(JSON.stringify({ skypeid: `orgid:${OID}`, rgn: "emea" }));
    expect(teams.tokenOid({ authentication: `skypetoken=${skype}` })).toBe(OID);
    expect(teams.tokenOid({ "x-skypetoken": skype })).toBe(OID);
  });

  it("gives the oid in lowercase", () => {
    expect(teams.tokenOid({ authorization: `Bearer ${jwt(JSON.stringify({ oid: OID.toUpperCase() }))}` })).toBe(OID);
  });

  it("is null for what isn't a token with a GUID oid", () => {
    for (const headers of [
      undefined,
      {},
      { authorization: "Bearer fake" },
      { authorization: "Bearer not.a!token" },
      { authorization: `Bearer ${jwt("not json")}` },
      { authorization: `Bearer ${jwt("42")}` },
      { authorization: `Bearer ${jwt("null")}` },
      { authorization: `Bearer ${jwt('"a string"')}` },
      { authorization: `Bearer ${jwt("[1,2]")}` },
      { authorization: `Bearer ${jwt(JSON.stringify({ oid: "alex" }))}` },
      { authorization: `Bearer ${jwt(JSON.stringify({ oid: 7 }))}` },
      { authentication: `skypetoken=${jwt(JSON.stringify({ skypeid: "live:alex" }))}` },
    ]) {
      expect(teams.tokenOid(headers)).toBeNull();
    }
  });

  it("reads only the last three parts of a token with more (an encrypted one has five): null when those aren't a payload", () => {
    expect(teams.tokenOid({ authorization: "Bearer aaaa.bbbb.cccc.dddd.eeee" })).toBeNull();
  });

  it("goes on to the next header when one doesn't hold an oid", () => {
    expect(teams.tokenOid({ authorization: "Bearer fake", authentication: `skypetoken=${jwt(JSON.stringify({ skypeid: `orgid:${OID}` }))}` })).toBe(OID);
  });
});
