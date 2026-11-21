// The process lookups the watchdog of #234 uses (found as mcp-newoutlook #288), against real
// processes: `ps` for a parent's PID, and signal 0 for whether a PID still runs.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parentOfProcess, processExists } from "../../src/lifecycle.js";

describe("#234: parentOfProcess", () => {
  it.skipIf(process.platform === "win32")("reads a process's parent PID", async () => {
    expect(await parentOfProcess(process.pid)).toBe(process.ppid);
    expect(await parentOfProcess(2 ** 22 + 12345)).toBeNull(); // no such process
  });
});

describe("#234: processExists", () => {
  it("is true for a running process and false for one that has exited", async () => {
    expect(processExists(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.once("exit", r));
    expect(processExists(child.pid!)).toBe(false);
  });
});
