# README images

What builds the images in [`docs/images/`](../../docs/images) that the main README shows. Run it from the repo root:

```sh
npm run readme-images                    # rewrites docs/images/*
npm run readme-images -- --out <dir>     # writes the five files to <dir> instead
```

| File | What it is |
| --- | --- |
| `build.mjs` | The entry point. Runs `capture.mjs`, renders the composition in `send-flow/` with the new `confirm-send.png` copied into a temporary copy of it, converts the video to `send-flow.gif` with ffmpeg, then copies all five files to the output folder. Everything is made in a temporary folder, which is removed afterwards, so a failed run leaves the output folder as it was. |
| `capture.mjs` | Opens the extension's own `extension/popup.html` and `extension/confirm.html`, unchanged, in Chrome with `chrome.runtime.sendMessage` and `chrome.storage.local` stubbed, and screenshots them at 2x: `popup-connected.png`, `popup-waiting.png`, `confirm-send.png`. Also screenshots `terminal.html` as `setup-terminal.png`, with a transparent background outside the window's rounded corners. Can run alone: `node scripts/readme-images/capture.mjs [outDir]`. |
| `terminal.html` | A static terminal-styled page with `npx mcp-teams setup`'s first-run output, typed in from the messages in `src/setup.ts`. Update it by hand when those messages change. |
| `send-flow/index.html` | A [HyperFrames](https://www.npmjs.com/package/hyperframes) composition (1200x680, 12.5 s, GSAP): ask, the confirm window (`confirm-send.png`), the click on Send. |

All the data is made up: the channel, the people, the message, the versions (0.3.98, extension 1.2.0) and the paths (`C:\Users\you\...`). Nothing here talks to Teams or to an installed extension.

## What it needs

- **Google Chrome** installed. Playwright (a devDependency, pinned) drives it with `channel: "chrome"`; Playwright's own browsers aren't downloaded or used.
- **ffmpeg** on `PATH`.
- **Network**: `npx` fetches the pinned HyperFrames version (`HYPERFRAMES` in `build.mjs`), and the composition loads GSAP from cdn.jsdelivr.net. HyperFrames runs with `HYPERFRAMES_NO_TELEMETRY=1`.

The script stops with a message saying which is missing. The new files won't be byte-identical to the committed ones even when nothing changed; commit them only when the pictures did.
