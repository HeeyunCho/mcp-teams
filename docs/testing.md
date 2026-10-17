# Testing

Every change starts with a failing test. The fix makes it pass; a refactor keeps it passing.

## Layers

| Folder | What it checks | Runs against | Command |
|---|---|---|---|
| `test/unit/` | Pure functions: Teams parsers and request helpers (`extension/teams.js`), client registration (`src/clients.ts`) | Nothing external | `npm run test:unit` |
| `test/integration/` | The extension's service worker (`extension/background.js`), the bridge (`src/bridge.ts`), pairing and the extension folder | A fake `chrome` (`test/helpers/fakeChrome.ts`); real sockets with hubs, peers and a fake extension (`test/helpers/bridgeHarness.ts`) | `npm run test:integration` |
| `test/system/` | The built server (`dist/`) over stdio, as an MCP client sees it | A fake extension on the bridge | `npm run test:system` |

`npm test` runs the build, a typecheck of the tests (`tsconfig.test.json`) and all three layers. It's what CI and the release workflow run. Nothing here talks to Teams; `npm run probe` does, by hand.

## Writing a test

- **Pick the lowest layer that shows the problem.** A parser bug is a unit test. "Too many Teams requests" is a worker test that counts requests (`fake.count("chatsvc", /\/messages/)`). "Fails when a session closes" is a bridge test.
- **Worker:** `createFakeChrome({ services })` answers each service (`chatsvc`, `csa`, `mt`, `substrate`, `sharepoint`) per request (`{ service, method, path, url, body }`). Return a JSON body, `reply(status, body)` for errors, a promise for a slow answer, or `never()` for a Teams that never answers; a service left out answers 404. The worker's `pageFetch` runs from its source, as Chrome runs it in the page, so its own deadline counts. `fake.freezeTab(id)` makes a tab run no scripts (frozen or asleep) until `fake.wake(id)`. `worker.dispatch({ type: "request", id, method, params, timeoutMs })` runs a request as the bridge sends it, with its deadline; `{ type: "cancel", id }` withdraws it. `loadWorker(fake)` loads a fresh copy of the worker (empty caches) and returns its `handlers`, `dispatch` and `registerListeners`. Outside Chrome the worker neither listens nor connects; call `worker.registerListeners()` for tests of `fake.fire(...)` (webRequest), `fake.pageMessage(...)` (confirm and popup pages) or `fake.closeWindow(id)`. `captured: []` starts without Teams sessions; `teamsTab: false` without a Teams tab.
- **Bridge:** `bridgeHarness()` picks a free port. `h.session()` starts a server's bridge (the first is the hub, later ones peers), and `h.extension({ handle, latencyMs, silent, pong })` connects a scripted fake browser that pairs with a proof. Call `h.cleanup()` in `afterEach`. The `FAST` timings make retries, joins, step-downs and pings take milliseconds; use real timers, not fake ones. A test that moves big payloads keeps the real 20 s keep-alive, or a pong queued behind the data gets the connection dropped. A single bridge can take port 0 and report `bridge.port`.
- **Ports:** never fixed. Use `freePort()` or port 0, so test files and worktrees can run side by side.
- **Tool contract:** `test/system/__snapshots__/tools.json` holds every tool's description and input schema. When a change to what the AI sees is intended, update it with `npx vitest run test/system -u` and review the diff.
- **Fixtures:** only fictional people, companies and ids (Alex Doe, Sam Roe, contoso.example, `00000000-…` GUIDs). Never real names, tenants or tokens.
