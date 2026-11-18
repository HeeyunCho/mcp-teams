// #219: the server decides what it may ask of the extension from the features the extension
// declares in hello, so the extension must declare every feature the server checks.
import { describe, expect, it } from "vitest";
import { EXTENSION_FEATURES, featuresOfExtension, missingFeatures } from "../../src/bridge.js";
// @ts-expect-error plain JS module of the extension, without types
import { CAPABILITIES } from "../../extension/features.js";

describe("#219: the extension's declared features", () => {
  it("the extension declares every feature the server checks", () => {
    expect([...CAPABILITIES.features].sort()).toEqual(Object.keys(EXTENSION_FEATURES).sort());
  });

  it("starts with cancelSend and sizeCheck", () => {
    expect(CAPABILITIES.features).toEqual(expect.arrayContaining(["cancelSend", "sizeCheck"]));
  });

  it("an extension that declares none is taken to have the features its version had", () => {
    const none = { features: [], maxMessageBytes: null };
    expect(featuresOfExtension({ version: "0.2.12", capabilities: none })).toEqual([]);
    expect(featuresOfExtension({ version: "0.2.13", capabilities: none })).toEqual(["cancelSend"]);
    expect(featuresOfExtension({ version: "0.3.78" })).toEqual(["cancelSend", "sizeCheck"]);
    expect(featuresOfExtension({ version: "dev" })).toEqual([]);
  });

  it("an extension that declares features is taken at its word, whatever its version", () => {
    expect(featuresOfExtension({ version: "0.3.79", capabilities: { features: ["sizeCheck"], maxMessageBytes: null } })).toEqual(["sizeCheck"]);
    expect(missingFeatures({ version: "0.0.1", capabilities: { features: ["cancelSend", "sizeCheck"], maxMessageBytes: null } })).toEqual([]);
  });
});
