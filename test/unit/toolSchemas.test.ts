// MCP SDK v2 marks registerTool's raw-shape overload (`inputSchema: { a: z.string() }`) @deprecated:
// every tool's inputSchema is a zod object instead. tsc doesn't fail on a deprecated overload, so
// this reads the source: each `inputSchema:` in src/tools.ts must be `z.object(...)`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/tools.ts", import.meta.url), "utf8");

describe("src/tools.ts input schemas", () => {
  const schemas = [...source.matchAll(/\binputSchema\s*:\s*([^\n]*)/g)].map((m) => m[1].trim());

  it("registers tools with an inputSchema", () => {
    expect(schemas.length).toBeGreaterThanOrEqual(13);
  });

  it("gives every inputSchema as z.object(...), not a raw shape", () => {
    expect(schemas.filter((s) => !s.startsWith("z.object("))).toEqual([]);
  });
});
