---
status: accepted
date: 2026-11-17
---

# The extension has its own version line, and the server checks its features, not its version

Until 0.3.79 every release bumped `extension/manifest.json` together with the package, and the server assumed the extension was the version it shipped. From #219 the extension has its own **extension version line**, starting at 1.0.0. The server decides what it may ask of an extension from the **extension features** it declares in hello (`capabilities.features`), never from "same version as me". The maintainer chose 1.0.0 as the start.

## Why

- **Web store copies lag the server.** Chrome Web Store and Edge Add-ons review takes hours to days, and Chrome's update cycle adds more, while `npx -y mcp-teams@latest` updates the server at once. A web store copy routinely runs behind a newer server. A sideloaded copy only matched because the server copies its own `extension/` into the folder Chrome loads.
- **Most releases don't touch the extension.** A web store submission per server release would be noise, and an extension version that moves without a change tells the user nothing.
- **The server already had the mechanism.** The extension sends `capabilities` in hello (#115), and the server's own features (`checksSend`) already work this way between hubs and peers.

## Decision

1. **Two version lines.** The package (package.json, package-lock.json, tags `vX.Y.Z`) moves on every release. The extension (manifest.json `version` and `version_name`, tags `ext-vX.Y.Z`) moves only when files under `extension/` changed since its last tag, other than the manifest's version fields, by the same commit-message rules applied to the commits that changed it. A current extension version without its tag yet is released as it is: that is how 1.0.0 is first released. The release commit names both (`chore(release): v0.3.80 (extension 1.0.1)`), and both tags are pushed atomically with it.
2. **Start at 1.0.0.** The line must stay above 0.3.79, the last version bumped with the package. The folder sync never downgrades (`src/index.ts`), and the extension reloads itself only when its folder holds a newer version (`reloadIfUpdatedOnDisk`), so a lower number would leave every sideloaded copy on 0.3.79. Both now compare extension versions with extension versions, which is what they always meant.
3. **Features, with a version fallback.** `EXTENSION_FEATURES` (`src/bridge.ts`) lists each feature the server checks, with the first version that had it: `cancelSend` (0.2.13, closes a send's confirmation window on cancel, #22) and `sizeCheck` (0.3.78, a short error for a reply too large for its connection, #193). The extension declares them in `extension/features.js`; a unit test keeps the two lists in step. An extension that declares no features at all (every one up to 0.3.79) is taken to have the features its version had, so existing copies keep working.
4. **The send gate checks `cancelSend`.** A send never goes to an extension that can't close its confirmation window: one that declares features but not `cancelSend` is refused, whatever its version.
5. **One version floor.** `MIN_EXTENSION` (0.1.0, the first release) is the oldest extension the hub serves. One below it is accepted, so `get_version` can say what to do, but gets no calls except status and reload. Raise it only to drop an extension the server can no longer work with at all.
6. **`get_version` reports support, not a match.** `versionsMatch` is gone (it would always be false). `get_version` and `reload_extension` show `extensionSupported` and the `missingFeatures` the extension lacks, and still show both versions.
7. **Messages fit both install types.** Texts that told the user to reload the extension now also say that a web store copy updates from the web store. Detecting which kind is installed is left to the setup follow-up.

## The rule for new extension behaviour

Every new request method, and every changed request or response shape, gets a feature string in the same change: in `EXTENSION_FEATURES` (with the first extension version that has it) and in `extension/features.js`. The server checks the feature before calling, and answers with a clear "the browser extension is too old for X; it updates from the store" error instead of an unknown-method failure.

**Release order.** Ship the extension change first. A server change that needs it checks the feature, and only becomes the default path once the web store update is live.

## Considered options

- **Keep one version line.** Rejected: every server release would need a web store submission, and only one can be pending at a time.
- **Start the extension line at 0.4.0 or 0.3.80.** Rejected: the two lines would hold the same numbers for different code, so a report naming "0.4.0" would be ambiguous.
- **Check a minimum extension version per feature only, with no declared features.** Rejected: a web store copy's version says nothing about a server that came later, and features already travel in hello.

## Consequences

- No server code compares the extension's version with the server's own.
- A release that touches only `src/` doesn't change `extension/manifest.json`.
- The bump script reads git (its tags, and the diff and log of `extension/` since the extension's tag); the workflow's checkout already fetches every tag.
- Out of scope here: uploading to the web stores, setup's web store and unpacked install modes, detecting the install type, the trusted-ID list (#216), pairing (#217) and permissions (#218).
