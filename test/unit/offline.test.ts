// When a test that needs npm (test/system/oldHubHandover.test.ts, #123 decision 8) skips as offline,
// and when it fails instead: in CI it never skips.
import { describe, expect, it } from "vitest";
import { npmVerdict } from "../helpers/offline.js";

const failed = (stderr: string, extra: object = {}) => ({ status: 1, signal: null, stderr, ...extra });

describe("#123: npm offline verdict", () => {
  it("runs on when npm installed it", () => {
    expect(npmVerdict({ status: 0, signal: null, stderr: "" }, { ci: false, resolves: true })).toEqual({ verdict: "run" });
  });

  it("skips when the registry doesn't resolve at all, outside CI", () => {
    expect(npmVerdict(failed("npm error code ENOTFOUND\nnpm error getaddrinfo ENOTFOUND registry.npmjs.org"), { ci: false, resolves: false })).toMatchObject({ verdict: "skip" });
    expect(npmVerdict(failed("npm error code EAI_AGAIN"), { ci: false, resolves: false })).toMatchObject({ verdict: "skip" });
    expect(npmVerdict(failed("npm error code ECONNREFUSED"), { ci: false, resolves: true })).toMatchObject({ verdict: "skip" });
  });

  it("fails on a reset or timeout while the registry still resolves (online, npm itself went wrong); skips it once the registry is gone too", () => {
    expect(npmVerdict(failed("npm error code ECONNRESET"), { ci: false, resolves: true })).toMatchObject({ verdict: "fail" });
    expect(npmVerdict(failed("npm error code ETIMEDOUT"), { ci: false, resolves: true })).toMatchObject({ verdict: "fail" });
    expect(npmVerdict(failed("npm error code ECONNRESET"), { ci: false, resolves: false })).toMatchObject({ verdict: "skip" });
  });

  it("fails on any other npm error, even one that says network somewhere", () => {
    expect(npmVerdict(failed("npm error 404 Not Found - mcp-teams@0.3.52 (see the network tab)"), { ci: false, resolves: true })).toMatchObject({ verdict: "fail" });
    expect(npmVerdict(failed("npm error code E500"), { ci: false, resolves: true })).toMatchObject({ verdict: "fail" });
  });

  it("fails when npm ran past its time limit", () => {
    expect(npmVerdict({ status: null, signal: "SIGTERM", stderr: "" }, { ci: false, resolves: true })).toMatchObject({ verdict: "fail" });
  });

  it("never skips in CI: being offline there is a failure", () => {
    expect(npmVerdict(failed("npm error code ENOTFOUND"), { ci: true, resolves: false })).toMatchObject({ verdict: "fail" });
    expect(npmVerdict(undefined, { ci: true, resolves: false })).toMatchObject({ verdict: "fail" });
    expect(npmVerdict(undefined, { ci: false, resolves: false })).toMatchObject({ verdict: "skip" });
  });
});
