# daddyloop 0.10.0

- Named source repositories are now Workspaces in web, Telegram and CLI. Compatibility aliases preserve existing project IDs, commands and settings.
- Telegram voice notes are recognized locally by bundled Whisper Small, then sent to daddy as text. English/Russian language selection, bounded downloads/decoding, a durable ordered inbox and resource-limited recognition keep the bot responsive.
- `/new` works in linked group topics and creates a new topic with a return link. Plain-language new-session requests use a scoped, idempotent daddy tool. Notifications and language controls also work in topics; group connection and CLI upgrades use the private chat.
- Coordination tool upgrades preserve saved conversations and native review threads. SQLite schema 5 stores voice jobs; keep the pre-upgrade backup for rollback to older releases.

# daddyloop 0.9.0

- Lowercase `daddy` and `daddyloop` throughout product copy, CLI help, bot cards and documentation. Existing internal identities and user-authored task text remain compatible.
- Codex quota windows, remaining percentages, reset timestamps and earned reset credits in web, Telegram and CLI. Readings come from the selected app-server, are cached briefly and marked stale when unavailable.
- Explicit one-credit reset confirmation with durable account-bound operations and backend idempotency. Uncertain results can be recovered after restart without spending a second credit, including when the last credit was used. Successful writes remain successful if the following quota refresh fails.
- Quota reads load independently of the conversation. Existing task scheduling, workspace snapshots, model selection and bot pairing are preserved.

# daddyloop 0.8.0

- Server-local project defaults, immutable session snapshots, and repository / scope / base overrides for one request. Web forms, CLI flags and Telegram folder buttons let the owner choose a different source without changing project defaults or existing work.
- Durable asynchronous writer-pool resizing. Occupied slots stay assigned through the entire task, including review fixes, checks and pauses. Shrinking retires completed tasks; growth applies on the next scheduler tick. Interfaces distinguish requested and applied capacity.
- Request workspaces and pending resizes survive restart. Telegram choices are owner/conversation scoped, expire explicitly, and reset after one message. Existing author tasks are adopted conservatively during upgrade.

SQLite remains schema 4 with additive JSON fields. Existing projects, sessions, author workspaces, model selections and bot pairing are preserved.

# daddyloop 0.7.0

Reviewloop becomes daddyloop: one conversation for project planning, writer assignment and code review.

- Named server projects, directory selection and optional starting subdirectories. Git uses managed worktrees; Arcadia uses leased shared-store mounts with capacity waiting and a reserved control/review slot.
- Persistent daddy conversations, a durable coordination queue, task dependencies and a writer pool of 1–8 simultaneous writers. New tickets join the existing session. Direct public writer chat is disabled; reports remain readable.
- Telegram forum workspaces: owner-selected groups, automatic per-session topics, natural-language task messages, pool controls and model selection. Lost topic-creation responses are not blindly retried.
- New browser and full-screen CLI experiences, with English/Russian copy and independent session drafts. Primary commands are `daddy` and `daddyloop`; `reviewctl` remains an alias.
- One completion notification for a managed Codex update, with external CLI-version changes reported separately.
- GitLab submission and recovery for locally described tasks; GitHub issues, Tracker tickets and existing native PR/MR review remain supported.

Existing state, models, tokens, Codex selection and native review identifiers are preserved. SQLite advances to schema 4; use the pre-upgrade database backup when restoring an older server release. Archive names and selected internal paths/markers retain the Reviewloop spelling for compatibility.
