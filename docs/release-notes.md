# daddyloop 0.11.0

This release removes the previous product interfaces and compatibility paths.

- One `daddy` executable, current web/terminal UI and Telegram session router.
- Workspaces use `/api/workspaces`, `workspaceId` and saved `workspace` snapshots. Per-request folder selection uses `repository`.
- Model settings use `writer` and `daddy`; CLI flags are `--writer-model`, `--writer-effort`, `--daddy-model`, `--daddy-effort`.
- No project aliases, standalone task mutation/chat APIs, adoption path or author/reviewer console.
- Canonical `daddyloop` config, data, services, archive names and environment variables. Stored formats are config 2 / SQLite 6.
- Voice, forum topics, asynchronous writer pools, native reviews, quotas and confirmed Codex updates continue through the current session interface.

Breaking release: back up earlier installations before replacing them. Their configuration and database must be explicitly converted before use, or initialize a fresh data directory and register workspaces. The installer does not search for or rewrite old installations. Browser sessions require signing in again because the cookie name changed. Stored tokens and device pairings can be preserved during conversion.
