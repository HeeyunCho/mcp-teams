# Extension ids

The server, the native host and setup treat a connection as **our extension** only when its origin is one of the ids in `EXTENSION_IDS` (`src/extension.ts`, #216):

| Entry | Where the id comes from | Status |
|---|---|---|
| `unpacked` | Chrome derives it from the manifest's `key` (sideloaded with *Load unpacked*). `test/integration/extension.test.ts` checks they agree. | `iolllncadcdlmihknnomfhcadbnnignl` |
| `chromeWebStore` | The Chrome Web Store Developer Dashboard, after the first draft upload. Edge users who install from the Chrome Web Store get this id too. | not known yet (TODO) |
| `edgeAddons` | Partner Center (Edge Add-ons), after the first draft upload. | not known yet (TODO) |

Where the list is used:

- **Native host manifest** (`hostManifest` in `src/nativehost.ts`): `allowed_origins` lists `chrome-extension://<id>/` for every id, so Chrome and Edge start the host for each.
- **The native host's caller check** (`src/hub.ts`): `dist/hub.js` exits unless the origin Chrome passes is in the list.
- **The bridge** (`src/bridge.ts`): "ours" is any id in the list. Another id is turned away (4409) while ours is connected, and replaced when ours connects. The native host passes the origin it checked to `attachExtension`, and a relaying host names it in the hello it relays, so the hub records which id connected.
- **Setup** (`src/setup.ts`): waits for any id in the list.

Every check is an exact match against the list (`isTrustedOrigin`): no prefix, substring, case-insensitive or wildcard match, and no environment variable or config file can add an id.

## Adding a web store id

1. Upload a first draft to the web store; it shows the id. Never guess one.
2. Add one line to `EXTENSION_IDS` in `src/extension.ts`, e.g. `chromeWebStore: "<the id>",`.
3. Release, then run setup again on each computer (`npx mcp-teams setup`): it rewrites the native host manifest's `allowed_origins`. Until then Chrome or Edge refuses to start the native host for the new id.

## Two copies in one browser

A web store copy and a sideloaded copy have different ids and different instances, so both stay connected and are served as two browsers. When both are connected in the same browser profile, `get_version` (`twoCopies`) and setup suggest removing the sideloaded one.

The hello names the profile (#253). `instance` can't: each copy keeps its own in its own `chrome.storage.local`, so two copies in one profile differ in it as two profiles do. The optional `profile` field is HMAC-SHA-256 of `profile:<oid>` with the pairing token, where `oid` is the Teams user the copy has seen in that profile (both copies see the same Teams requests). The user's id never leaves in clear, and the value isn't logged or shown by any tool. The hub keeps it only as a short token (`[\w-]{1,64}`).

- Both copies name a profile: counted only when it is the same.
- One or both name none (an extension from before #253, or one that hasn't seen a Teams request since the browser started, since `oid` is in `chrome.storage.session`): counted per browser, as before, so two profiles of one browser that each hold one copy get the note too.
- Two profiles signed into the same Teams account look like one profile.
- A hello keeps the value it was sent with: after an account switch, the copies agree again from their next connect.

## The web store zip

`npm run package-extension` (`scripts/package-extension.mjs`) writes `artifacts/mcp-teams-extension-<version>.zip` from `extension/`:

- only the files in its `ALLOWED` list; a file in neither `ALLOWED` nor `SOURCE_ONLY` stops it;
- never `pairing.json` (the pairing token): its presence stops it;
- `manifest.json` without `key`. The `key` stays in the repo, since it fixes the sideloaded copy's id; replacing it with a web store's public key would change every sideloaded copy's id and drop its `chrome.storage.local`.

`test/unit/packageExtension.test.ts` checks the zip.
