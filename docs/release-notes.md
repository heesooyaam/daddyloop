# Reviewloop 0.3.0

The default CLI is now a full-screen terminal workspace with a task sidebar, separate author/reviewer conversations, a multiline composer and command suggestions.

- Dark and light themes, Markdown/code formatting, working indicators, resource status and responsive layouts.
- Tab switches roles; Ctrl+T searches tasks; PgUp/PgDn scroll; Ctrl+J inserts a newline.
- Drafts stay with each task/role while navigating. Bracketed paste remains literal text and never runs a slash command automatically.
- `/findings`, `/logs`, `/context` and a guided `/attach` expose the workflow from the terminal.
- The client reconnects after read failures, fences late selection responses and restores unconfirmed messages at their original recipient.
- `reviewctl --plain` retains the original line-oriented console. Existing script commands keep their output.
- Closing the TUI restores the terminal and leaves the managed service and agents running.

The self-contained Linux x64/ARM64 release includes the terminal UI dependencies. Existing data and accounts are preserved. This remains a prerelease; earlier provider-write and external-account validation limits still apply.
