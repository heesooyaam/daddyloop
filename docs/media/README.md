# README media

All product screenshots come from the actual Reviewloop UI and CLI connected to a fresh, isolated demo server. The demo label stays visible. Agent responses and PR operations in this workspace are fixtures; these images do not demonstrate a live provider write or a real model response.

The CLI images replay the real ANSI screen updates from a PTY through xterm.js. Panels, colours and menus are rendered by the actual terminal app. `cli-chat.png` shows a reviewer response; `cli.png` shows the initial workspace. Separate captures show command suggestions, task selection, author drafts, light theme, compact layout, role models and Telegram preferences. Model catalogues and version status in media captures are illustrative offline fixtures. Russian screenshots show language switching, the model catalogue provenance and the CLI update panel. The green README header is a separate SVG illustration, not an application screen.

## Watch

[Open the MP4 recording](reviewloop-demo.mp4?raw=1) · [Animated GIF preview](reviewloop-demo.gif)

The video is silent, about 20 seconds long, and shows the real demo workflow:

1. Open a task with a draft finding.
2. Ask the reviewer whether the race can occur on a single event loop.
3. Publish the review and read the author's response.
4. Review the next revision and publish the completed review.
5. Inspect the recorded verification decision and activity history.

The GIF uses fewer frames and colours for a smaller inline preview. The MP4 preserves the full 1440 × 1080 recording. Screenshots provide a static alternative to the animation. The mobile captures use a 390 × 844 browser viewport; they demonstrate layout, not an authenticated external phone connection. The Telegram preferences screenshot shows the actual phone-sized settings UI; no live Telegram chat is shown because no bot was paired for this capture.

## Reproduce

With Node 24, the workspace's dependencies, Playwright Chromium, Python 3 and ffmpeg installed, run from the repository root:

```bash
npm run build
npx playwright install chromium
node scripts/capture-media.mjs
node scripts/capture-media.mjs --terminal-only
```

On the original development host, use the browser-library environment described in [operations](../operations.md#development-host-browser-tests).

The script starts its own loopback server on an ephemeral port, uses fresh state under `.reviewloop/media-build/`, captures the UI and a real CLI PTY, and encodes MP4 and GIF with two ffmpeg threads. It verifies multiline delivery, literal paste, role navigation, resizing, restored terminal modes and an unchanged server PID. It stops its server and removes the generated state, temporary credentials and raw video in `finally`. Capture metadata and demo-only terminal recordings remain in that ignored directory. The normal installed service is not used for the recording.

Generated files:

| File                  | Content                                      |
| --------------------- | -------------------------------------------- |
| `cli-chat.png`        | Reviewer conversation in the full-screen TUI |
| `cli.png`             | Initial terminal workspace                   |
| `cli-menu.png`        | Slash-command suggestions                    |
| `cli-compose.png`     | Multiline composer before submission         |
| `cli-author.png`      | Separate unsent author draft                 |
| `cli-tasks.png`       | Keyboard task selector                       |
| `cli-light.png`       | Light theme                                  |
| `cli-compact.png`     | Responsive 80 × 24 layout                    |
| `workspace.png`       | Complete desktop workspace                   |
| `reviewer.png`        | Reviewer chat with a draft finding           |
| `author.png`          | Author response after publication            |
| `decisions.png`       | Verified finding and its revision            |
| `activity.png`        | Workflow event history                       |
| `mobile.png`          | Task on a mobile viewport                    |
| `connections.png`     | Browser sessions and connection settings     |
| `reviewloop-demo.gif` | Inline animated preview                      |
| `reviewloop-demo.mp4` | Full-resolution video                        |

Media is committed with the README so relative image links also work in a private repository and in source checkouts. No user tokens, pairing links, corporate code or actual PR content are packaged.

## daddyloop 0.7

Run `node scripts/capture-daddy.mjs` after a production build. It captures the actual browser UI and the actual CLI in a PTY against an isolated fixture server. `daddy-desktop.png`, `daddy-models.png`, `daddy-phone-*.png` and `daddy-cli*.png` contain illustrative data, not a transcript of a production task. The capture verifies terminal mode restoration and that closing the CLI does not change the server PID.
