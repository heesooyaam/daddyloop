# Running and recovering Reviewloop

## Local files

`.reviewloop/` is ignored by Git. It contains the SQLite database and WAL files, the web access token, the server PID lock, managed Git objects/worktrees, and optional live transport reports. Use owner-only directory permissions. Provider tokens live in environment variables or separate token files; they are not copied into this directory by the application.

The web server binds only `127.0.0.1`. The API requires a bearer token or an HttpOnly, SameSite=Strict session cookie. Cookie-authenticated mutations also require the application request header. Origin and Host validation protect the local control API; remote access uses an SSH tunnel. This release is not a multi-user public server.

## Resource controls

`--min-disk-gib`, `--max-disk-percent` and `--min-memory-gib` gate new agent executions. Defaults are 10 GiB, 95%, and 2 GiB. On the original development host use 100 GiB and 80% for disk. Linux memory monitoring uses **MemAvailable**, which accounts for reclaimable page cache, rather than interpreting low `MemFree` as an emergency.

Only one agent is active by default. Codex runs have a 20-minute limit, RPC requests have timeouts, and child process groups are terminated at the end of each run. Git subprocesses have a two-minute limit and bounded output. The service does not remove user workspaces, caches or unrelated processes automatically.

When space is low: inspect exact ownership, stop task-owned services before cleaning generated runtime files, and preserve uncommitted/unpushed author work. This application never runs `git reset --hard`, `git clean`, force-push or Arcadia garbage collection.

## What to do after a failure

| Situation                                                | Behavior and next step                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service restarted during an agent turn                   | The run is marked interrupted and the task waits for input. Inspect Activity and the native review. Use `retry` to continue an unfinished reviewer, or `resume` to continue interrupted author fixes. |
| Provider accepted a write but the response was lost      | The operation remains pending in the outbox. A matching native result can confirm it; otherwise the application refuses a blind retry. Inspect native objects and the operation ID in Activity.       |
| GitHub already has another pending review by the user    | Creation fails without adopting or deleting that review. Publish/discard it explicitly before retrying.                                                                                               |
| Head/base changed while a draft was open                 | The old generation is invalidated. Inspect/discard the stale native draft before retrying the new revision.                                                                                           |
| GitLab notes were partly published                       | Task waits for input. Finish or discard the affected review explicitly in GitLab, preserving markers, then reconcile.                                                                                 |
| GitLab has additional untracked notes or removed markers | Task waits for input. The initial release cannot safely infer group membership. Keep native notes intact, inspect the batch and reconnect a clean review cycle.                                       |
| Author workspace contains unpushed commits               | They are preserved. If they belong to the same base revision, an interrupted author can continue; unrelated divergence needs manual reconciliation.                                                   |
| CI is missing or red                                     | Task stays in Waiting for checks. Fix CI or record a human waiver with a reason for the exact revision.                                                                                               |
| Author and reviewer disagree                             | The author returns disputed IDs and the task waits for a decision. Discuss it with the reviewer and preserve the decision before continuing.                                                          |

Use `reviewctl logs <task-id> --follow` for JSONL events. The UI Activity tab shows confirmed effects and IDs. Database snapshots include source and comment content; keep the state directory private even though known credential patterns are redacted from logs.

The API intentionally exposes no “pretend everything succeeded” recovery switch. Some ambiguous native edits require resolving the underlying platform state before retrying. There is no remote API administrative endpoint for changing SQLite rows.

## Backups

Stop the service before copying its state directory, or use SQLite's backup mechanism. Copying the database file while ignoring its live WAL can lose recent state. Keep task worktrees if they contain unpushed changes. The local access token can be rotated by stopping the service, replacing `.reviewloop/access-token`, and restarting; existing browser sessions will require the new token.

## Current scope and limits

- GitHub/GitLab adapters implement real HTTP requests but have only fixture-based HTTP validation until user tokens are supplied. A live native draft/edit/publish/push test remains outstanding.
- A live Codex smoke test verifies dynamic tools, valid structured completion and resuming the same persisted thread. It does not constitute a live PR integration test.
- Existing PRs/MRs are attached; creating a plan PR or implementation PR from a bare idea is outside this initial product flow. Repository creation for this project's own remotes is a separate CLI command.
- Runner and backend modules share one process; a distributed runner protocol, webhook ingestion, automatic CI repair, configurable command-approval UI and Telegram transport are not implemented. Polling is the durable reconciliation mechanism; browser notifications are available.
- Codex configuration and authentication are local. The integration disables apps via thread configuration, removes provider-token environment variables, and requests a read-only reviewer sandbox / workspace-write author sandbox with network disabled. These are runtime policies, not an OS identity boundary. Installed extensions and readable home files should be considered when using a trusted local account. Use a dedicated OS account or an externally managed sandbox for untrusted repositories.
- Reviewer local commands that require filesystem writes cannot run in its read-only sandbox. The reviewer must report that limitation and use actual CI evidence where sufficient; inability to verify is not treated as success.
- The service refuses permission-expansion requests instead of silently granting them, records them in Activity, and relies on an explicit incomplete/needs-input result. There is no interactive approval relay in this version.
- GitLab currently uses one anchor line for inline comments; multi-line context remains in the full Markdown body. GitHub supports start/end line ranges.
- Very large plans (over 300 KB of changed Markdown) and provider lists over 10,000 entries fail explicitly rather than silently truncating the task material.

## Development host browser tests

The original host has Ubuntu 20.04, which current Playwright no longer supports officially. For local UI verification a Chromium fallback for `ubuntu22.04-x64` was installed and the Ubuntu 20.04 `libnspr4`/`libnss3` packages were extracted into `.tools/browser-libs`, without installing system packages.

```bash
PATH="$PWD/.tools/node/bin:$PATH" \
LD_LIBRARY_PATH="$PWD/.tools/browser-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
npm run test:e2e
```

For a new supported Linux machine use the ordinary Playwright installation command in the README. The local fallback is a test-host accommodation, not a runtime dependency of Reviewloop.
