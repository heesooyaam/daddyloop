# Review: Daddyloop 0.8

Full self-review of project snapshots, request routing, persistent writer slots, Telegram controls and web/CLI behavior. No independent review agent was used. Sources: `docs/architecture.md`, the project instructions and the existing workspace, queue and publication implementations.

## Findings addressed

- **Task lifetime versus model turn.** Counting running author processes lets a retiring slot accept new work while its previous task still owes review fixes. Occupied task IDs now persist independently of processes; claiming a job and assigning its slot share a transaction. Only complete, idle tasks release slots. Shrinking blocks new assignments while allowing existing tasks to continue.
- **Repository selection across asynchronous work.** A mutable session folder or a message-only path can silently redirect queued work. Session defaults and request snapshots are persisted. Different selections receive stable distinct IDs so later coordination turns can find a task's approved repository. Worker wake-ups and interrupted coordinator recovery preserve the selected project. Read-only coordinator checkouts have distinct identities for different selections.
- **Defaults and source protection.** Updating a project's defaults pins older sessions first. One-request selections use the existing repository/root/scope checks without changing the registry. Arc allocation excludes source paths from saved sessions, requests and tasks as well as current project defaults.
- **Transport and draft races.** Telegram selections are scoped to the paired owner and destination/session, expire explicitly, and are consumed for one message. Duplicate updates do not send that message again with the defaults. Client retry IDs cover both text and workspace; a workspace edited during an in-flight send preserves the new draft.
- **Repeatable browser fixtures.** Previous fixture sessions caused an ambiguous selector on a repeated test run. Startup now resets only the explicitly owned offline browser fixture database.

## Validation

`npm run check` covers type checking, 186 tests and the production build. Regressions cover whole-task draining through fixes/CI/pauses, asynchronous growth and superseding requests, recovery of old occupied writers, SQLite reopen, multiple repositories queued for one Daddy, later creation in a previously selected repository, unchanged project defaults, Arc-before-Git detection, owner-bound Telegram selection and message/draft retries.

Eleven browser scenarios cover pool requests, one-request folder selection at phone width, composer reset, session drafts, both languages, models, directory browsing and existing native review controls. The phone HTTPS scenario also verifies that closing the laptop browser leaves the phone connected. Ordinary tests use offline agent/provider fixtures and do not submit real PRs.

## Limits

A project registry belongs to one server; names and paths are not synchronized between installations. Resizing changes logical task slots, not a persistent OS process count. A paused task retains its slot until work is resumed and completed. Resource limits still gate execution independently of the requested pool size.

An actual PTY run verified `new --repo`, `talk --repo`, pool requests, terminal restoration and the test daemon's unchanged PID after CLI exit. The CLI smoke service used the same offline provider/model fixture as the browser tests and was stopped afterwards.
