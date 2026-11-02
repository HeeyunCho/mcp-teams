// An account that is in no teams gets an empty list from Teams. list_teams then says whose list
// it is (the signed-in account's name and tenant), so an empty list isn't taken for a bug when
// the teams the user expected are under another account. The real worker runs under a fake
// chrome; Teams' own request carries the session the worker captures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASES, createFakeChrome, loadWorker, openedSockets, TEAMS_ORIGIN } from "../helpers/fakeChrome.js";

afterEach(() => {
  vi.unstubAllGlobals();
  openedSockets.length = 0;
});

const TID = "00000000-0000-4000-8000-0000000000a0";
const OID = "00000000-0000-4000-8000-0000000000a1";
/** An unsigned JWT with these claims (the worker only reads from it). */
const fakeJwt = (claims: object) => `${[{ alg: "none", typ: "JWT" }, claims].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".")}.`;
const BEARER = `Bearer ${fakeJwt({ tid: TID, oid: OID, name: "Alex Doe", upn: "alex@contoso.example" })}`;

/** A worker whose Teams tab made a csa request as Alex Doe, and whose csa lists these teams. */
async function signedInWorker(teamsList: object[], bearer = BEARER) {
  const fake = createFakeChrome({ captured: [], services: { csa: () => ({ teams: teamsList, chats: [] }) } });
  const worker = await loadWorker(fake);
  worker.registerListeners();
  await fake.fire("beforeSendHeaders", {
    url: `${BASES.csa}/api/v1/teams/users/me?isPrefetch=false`,
    initiator: TEAMS_ORIGIN,
    requestHeaders: [{ name: "Authorization", value: bearer }],
  });
  return worker;
}

describe("list_teams for an account in no teams", () => {
  it("says the signed-in account (name, address, tenant) is in no teams", async () => {
    const worker = await signedInWorker([]);
    const r = await worker.handlers.listTeams({});
    expect(r.teams).toEqual([]);
    expect(r.note).toContain("no teams");
    expect(r.note).toContain("Alex Doe");
    expect(r.note).toContain("alex@contoso.example");
    expect(r.note).toContain(TID);
    expect(r.note).toMatch(/another account or tenant/);
  });

  it("shows a non-ASCII name as written (the token's payload is UTF-8)", async () => {
    const bearer = `Bearer ${fakeJwt({ tid: TID, oid: OID, name: "김예시 (Müller)", upn: "kim@contoso.example" })}`;
    const worker = await signedInWorker([], bearer);
    const { note } = await worker.handlers.listTeams({});
    expect(note).toContain("김예시 (Müller)");
  });

  it("never puts the token, or any part of it, in the note", async () => {
    const worker = await signedInWorker([]);
    const { note } = await worker.handlers.listTeams({});
    for (const part of BEARER.slice("Bearer ".length).split(".").filter(Boolean)) expect(note).not.toContain(part);
  });

  it("has no note when the account is in teams", async () => {
    const worker = await signedInWorker([{ id: "19:contoso@thread.tacv2", displayName: "Contoso", channels: [] }]);
    const r = await worker.handlers.listTeams({});
    expect(r).toEqual({ teams: [{ id: "19:contoso@thread.tacv2", name: "Contoso", channels: [] }] });
  });
});
