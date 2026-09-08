# README media

All product screenshots come from the actual Reviewloop UI and CLI connected to a fresh, isolated demo server. The demo label stays visible. Agent responses and PR operations in this workspace are fixtures; these images do not demonstrate a live provider write or a real model response.

The CLI images render the exact text captured from a real PTY with a readable terminal frame. `cli-chat.png` includes a reviewer response and switching to the author role; `cli.png` shows the built-in help. The green header is a separate SVG illustration, not an application screen.

## Watch

[Open the MP4 recording](reviewloop-demo.mp4?raw=1) · [Animated GIF preview](reviewloop-demo.gif)

The video is silent, about 20 seconds long, and shows the real demo workflow:

1. Open a task with a draft finding.
2. Ask the reviewer whether the race can occur on a single event loop.
3. Publish the review and read the author's response.
4. Review the next revision and publish the completed review.
5. Inspect the recorded verification decision and activity history.

The GIF uses fewer frames and colours for a smaller inline preview. The MP4 preserves the full 1440 × 1080 recording. Screenshots provide a static alternative to the animation. The mobile captures use a 390 × 844 browser viewport; they demonstrate layout, not an authenticated external phone connection. No live Telegram screenshot is included because no bot was paired for this capture.

## Reproduce

With Node 24, the project's dependencies, Playwright Chromium, Python 3 and ffmpeg installed, run from the repository root:

```bash
npm run build
npx playwright install chromium
node scripts/capture-media.mjs
```

On the original development host, use the browser-library environment described in [operations](../operations.md#development-host-browser-tests).

The script starts its own loopback server on an ephemeral port, uses fresh state under `.reviewloop/media-build/`, captures the UI and a real CLI PTY, and encodes MP4 and GIF with two ffmpeg threads. It stops its server and removes the generated state, temporary credentials and raw video in `finally`. Capture metadata and a demo-only CLI transcript remain in that ignored directory. The normal installed service is not used for the recording.

Generated files:

| File                  | Content                                         |
| --------------------- | ----------------------------------------------- |
| `cli-chat.png`        | Reviewer conversation and author role selection |
| `cli.png`             | Interactive console and command help            |
| `workspace.png`       | Complete desktop workspace                      |
| `reviewer.png`        | Reviewer chat with a draft finding              |
| `author.png`          | Author response after publication               |
| `decisions.png`       | Verified finding and its revision               |
| `activity.png`        | Workflow event history                          |
| `mobile.png`          | Task on a mobile viewport                       |
| `connections.png`     | Browser sessions and connection settings        |
| `reviewloop-demo.gif` | Inline animated preview                         |
| `reviewloop-demo.mp4` | Full-resolution video                           |

Media is committed with the README so relative image links also work in a private repository and in source checkouts. No user tokens, pairing links, corporate code or actual PR content are packaged.
