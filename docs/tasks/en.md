[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Tasks and the worker pool

Start a session in the CLI with `/new`, use **New session** on the website, or send `/new` to the bot. Pick a workspace and describe the goal. You can paste a GitHub issue, a Tracker ticket, or an existing GitHub/GitLab/Arcadia PR.

```bash
daddy new --workspace App "https://github.com/acme/app/issues/42"
daddy sessions
daddy talk SESSION_ID "Also take https://github.com/acme/app/issues/43"
```

New messages in an existing session go to the same daddy. He imports requirements, creates work items, assigns workers and checks the result. To make an independent session, use `/new` or ask him explicitly to create a new session. In a connected Telegram forum it gets a separate topic.

## Pool size

```bash
daddy pool SESSION_ID 3
```

The default is one worker, with a maximum of eight. This requests a target size. The scheduler applies it asynchronously. When reducing `3 → 1`, busy workers finish the **entire task**, including review, fixes and CI, before extra slots disappear. Paused work and work awaiting your input keep their slots. A new size request replaces the previous target.

Host memory/process limits can allow fewer concurrent turns than the pool size. Dependencies control order, not branch merging. daddy decides whether parallel work is useful; a larger limit does not force more workers to run.

## Review and control

Completed native reviews publish automatically by default. Workers receive the published snapshot. Incomplete reviews, disputes and stale revisions cannot become successful handoffs. Required CI and human plan approval still gate completion. There is no automatic merge.

Use the main daddy chat for instructions. Task reports are read-only and can expose explicit actions such as publishing a manual review, submitting a saved implementation or approving a plan. These actions check the exact revision and generation again before proceeding.

`/pause` pauses the session; `/resume` resumes it. Closing the CLI/browser only disconnects the client. Stopping the service is different: interrupted work is recorded and must be resumed after inspection. See [operations](../operations/en.md).
