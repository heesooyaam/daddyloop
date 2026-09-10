# Daddyloop 0.8.0

- Server-local project defaults, immutable session snapshots, and repository / scope / base overrides for one request. Web forms, CLI flags and Telegram folder buttons let the owner choose a different source without changing project defaults or existing work.
- Durable asynchronous writer-pool resizing. Occupied slots stay assigned through the entire task, including review fixes, checks and pauses. Shrinking retires completed tasks; growth applies on the next scheduler tick. Interfaces distinguish requested and applied capacity.
- Request workspaces and pending resizes survive restart. Telegram choices are owner/conversation scoped, expire explicitly, and reset after one message. Existing author tasks are adopted conservatively during upgrade.

SQLite remains schema 4 with additive JSON fields. Existing projects, sessions, author workspaces, model selections and bot pairing are preserved.

# Daddyloop 0.7.0

Reviewloop becomes Daddyloop: one conversation for project planning, writer assignment and code review.

- Named server projects, directory selection and optional starting subdirectories. Git uses managed worktrees; Arcadia uses leased shared-store mounts with capacity waiting and a reserved control/review slot.
- Persistent Daddy conversations, a durable coordination queue, task dependencies and a writer pool of 1–8 simultaneous writers. New tickets join the existing session. Direct public writer chat is disabled; reports remain readable.
- Telegram forum workspaces: owner-selected groups, automatic per-session topics, natural-language task messages, pool controls and model selection. Lost topic-creation responses are not blindly retried.
- New browser and full-screen CLI experiences, with English/Russian copy and independent session drafts. Primary commands are `daddy` and `daddyloop`; `reviewctl` remains an alias.
- One completion notification for a managed Codex update, with external CLI-version changes reported separately.
- GitLab submission and recovery for locally described tasks; GitHub issues, Tracker tickets and existing native PR/MR review remain supported.

Existing state, models, tokens, Codex selection and native review identifiers are preserved. SQLite advances to schema 4; use the pre-upgrade database backup when restoring an older server release. Archive names and selected internal paths/markers retain the Reviewloop spelling for compatibility.
