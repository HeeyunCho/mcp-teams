/**
 * What hello declares to the hub (#115), as mcp-newoutlook's extension does (EXTENSION_FEATURES in
 * its extension/background.js).
 *
 * features (#219): one string per protocol behaviour the server may depend on. The extension has
 * its own version line, so the server decides what it may ask for from this list, never from the
 * version. Every feature the server checks (EXTENSION_FEATURES in src/bridge.ts) is listed here;
 * test/unit/extensionFeatures.test.ts keeps the two in step. A new request method, or a changed
 * request or response shape, gets a feature in the same change.
 * - "cancelSend": closes a send's confirmation window on {type:"cancel"} (#22).
 * - "sizeCheck": answers a reply too large for its connection with a short error instead (#193).
 * ("native" is only for a native host's port, declared by the host.)
 *
 * maxMessageBytes: the largest message it takes, the server's own MAX_MESSAGE_BYTES (Chrome's
 * WebSocket sets no lower limit of its own). It is what the extension receives, on native messaging
 * too (the host's chunks are joined up to it); what it sends there is capped at Chrome's 64 MB
 * (NATIVE_MAX_MESSAGE_BYTES).
 */
export const CAPABILITIES = Object.freeze({ features: Object.freeze(["cancelSend", "sizeCheck"]), maxMessageBytes: 256 * 1024 * 1024 });
