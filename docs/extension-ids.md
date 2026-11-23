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

Each copy names its profile (#253). `instance` can't: each copy keeps its own in its own `chrome.storage.local`, so two copies in one profile differ in it as two profiles do. The `profile` value is HMAC-SHA-256 of `profile:<oid>` with the pairing token (base64url, 43 characters), where `oid` is the Teams user the copy has seen in that profile (both copies see the same Teams requests). The user's id never leaves in clear, and the value isn't logged or shown by any tool. The hub keeps only a value of that shape. Only the oid goes in, not the tenant too: an object id is already one tenant's, and it is the one value the worker keeps for the signed-in user. `chrome.identity.getProfileUserInfo` would need the `identity` permission and gives an email, and the native host learns nothing from Chrome that names the profile.

- **When it is sent:** the hello carries it when the copy already knows the oid, as it carries `instance` (over TCP the hello goes before the server has proved itself, and a relaying host passes it on). An oid seen later goes as `{"type":"profile","profile":…}`, and only to a hub that has proved itself in its welcome. The oid is in `chrome.storage.session`, so it is missing only until Teams' first signed-in request after the browser started or the copy was reloaded or updated. A switch to another account sends the new value.
- **Native host:** a relaying host passes the message on unchanged, and sends it again behind the hello when it moves to another hub.
- **Older servers:** a server from before #253 ignores the message (it has no `id`).

How the note counts:

- Both copies name a profile: counted only when it is the same.
- One or both name none (an extension from before #253, or one that hasn't seen a signed-in Teams request yet): counted per browser, as before, so two profiles of one browser that each hold one copy get the note too.
- Two profiles signed into the same Teams account look like one profile.

## The web store zip

`npm run package-extension` (`scripts/package-extension.mjs`) writes `artifacts/mcp-teams-extension-<version>.zip` from `extension/`:

- only the files in its `ALLOWED` list; a file in neither `ALLOWED` nor `SOURCE_ONLY` stops it;
- never `pairing.json` (the pairing token): its presence stops it;
- `manifest.json` without `key`. The `key` stays in the repo, since it fixes the sideloaded copy's id; replacing it with a web store's public key would change every sideloaded copy's id and drop its `chrome.storage.local`.

`test/unit/packageExtension.test.ts` checks the zip.
