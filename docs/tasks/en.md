[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Tasks and the worker pool

Start a session in the CLI with `/new`, use **New session** on the website, or send `/new` to the bot. On the website, describe the goal first, then choose a workspace; its saved folder usually needs no changes. In the CLI and Telegram, follow the `/new` steps. You can paste a GitHub issue, a Tracker ticket, or an existing GitHub/GitLab/Arcadia PR.

```bash
daddy new --workspace App "https://github.com/acme/app/issues/42"
daddy sessions
daddy talk SESSION_ID "Also take https://github.com/acme/app/issues/43"
```

New messages in an existing session go to the same daddy. He imports requirements, creates work items, assigns workers and checks the result. To make an independent session, use `/new` or ask him explicitly to create a new session. In a connected Telegram forum it gets a separate topic.

## Queue a task and choose a worker

Open **Queue task** on the website or send `/task DESCRIPTION` in Telegram. The task appears under the same ID in both places. Click it on the website or send `/task DADDY-ID` for its stage, assigned worker and PR. Telegram’s `/queue` lists open tasks.

A worker can file issues or investigate a failure and return a report. daddy checks the report before the task completes. You can read the reviewed report on the website or through `/task DADDY-ID`. Saved code changes go through the usual PR review.

When queuing, you can select a numbered worker, a model and a reasoning level. Without a worker number, the service chooses a free worker. If you ask for a model, it tries a matching free worker first. If none match, the first free worker gets that profile.

Open **Workers** on the website or use `/workers` in Telegram to see the numbered workers and their tasks. Use the worker’s settings to select a model for its next task. **Apply to current task** restarts an active author step in the same working copy. In Telegram, use `/worker NUMBER MODEL EFFORT` and add `--force` to apply it to the current task. [Telegram commands](../telegram/en.md#tasks-and-workers)

## Pool size

```bash
daddy pool SESSION_ID 3
```

The default is one worker, with a maximum of eight. This requests a target size. The scheduler applies it asynchronously. When reducing `3 → 1`, busy workers finish the **entire task**, including review, fixes and CI, before extra slots disappear. Paused work and work awaiting your input keep their slots. A new size request replaces the previous target.

Host memory/process limits can allow fewer concurrent turns than the pool size. Dependencies control order, not branch merging. daddy decides whether parallel work is useful; a larger limit does not force more workers to run.

## Review and control

The service opens GitHub pull requests and GitLab merge requests ready for review. It publishes completed native reviews and sends saved fixes automatically. Workers receive the published snapshot. Incomplete reviews, disputes and stale revisions cannot become successful handoffs. Tasks with a PR still require passing CI and human plan approval if configured. The user decides when to merge.

Use the main daddy chat for instructions. Task reports show progress and offer plan approval when required. Plan approval checks the exact revision and generation again.

`/pause` pauses the session; `/resume` resumes it. Closing the CLI/browser only disconnects the client. Stopping the service is different: interrupted work is recorded and must be resumed after inspection. See [operations](../operations/en.md).
