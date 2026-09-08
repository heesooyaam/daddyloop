# Terminal UI review

Scope: the Ink terminal client, input editor, client request lifecycle, CLI entry points, release packaging and real-PTY capture helpers. This is a self-review using the project AGENTS.md, architecture and code-review checklist.

## Findings addressed

- **Pasted commands:** bracketed paste is handled separately and marked literal. Pasted `/publish`, including text restored after an unconfirmed send, cannot become a command. No automatic write retries are added.
- **Recipient identity:** outgoing messages capture the task and role before awaiting the network. A failed message is restored to that same draft even if the user has changed tasks or roles.
- **Late reads:** selection generations prevent a response from the previous task replacing the current conversation.
- **Terminal control injection:** external text is stripped of ANSI/OSC and control sequences before rendering; Unicode grapheme editing preserves Cyrillic and compound emoji.
- **Terminal lifecycle:** exits abort client requests, remove listeners and restore the alternate screen, cursor and paste/input modes. They do not send pause/stop actions to the service.
- **Rendering:** real VT replay exposed stale lines with incremental rendering. The client uses complete synchronized redraws and bounded visible content. Compact-window layout reserves enough room for the conversation.
- **Attach recovery:** validation errors retain the wizard's fields. Commands accepting no task argument reject extra arguments instead of acting on a different task than the user named.

## Validation

88 tests cover the existing workflow and the new editor, role/task drafts, late replies, failed sends, paste behaviour and keyboard navigation. Type checking and production builds pass. Real-PTY capture verifies exact multiline delivery, literal `/publish` paste, dark/light layouts, 120 × 40 → 80 × 24 resizing, terminal-mode restoration after Ctrl+Q and SIGHUP, and an unchanged server PID. Captures use an isolated demo server and no live model or provider writes.

The release installer checks the bundled TUI in a real PTY as well as version, repeat-install and checksum behaviour. README captures are actual screen updates replayed through xterm.js. Existing native-provider publication/push and external-phone/Telegram account validation limits remain as documented for 0.2.
