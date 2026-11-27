[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Tasks and the worker pool

Start a session in the CLI with `/new`, use **New session** on the website, or send `/new` to the bot. On the website, describe the goal first, then choose a workspace; its saved folder usually needs no changes. In the CLI and Telegram, follow the `/new` steps. You can paste a GitHub issue, a Tracker ticket, or an existing GitHub/GitLab/Arcadia PR.

```bash
daddy new --workspace App "https://github.com/acme/app/issues/42"
daddy sessions
daddy talk SESSION_ID "Also take https://github.com/acme/app/issues/43"
```

New messages in an existing session go to the same daddy. He imports requirements, creates work items, assigns workers and checks the result. To make an independent session, use `/new` or ask him explicitly to create a new session. In a connected Telegram forum it gets a separate topic.

An answer to a blocked author fix resumes that worker. The task retains the clarification for subsequent author turns and independent reviews.

When a worker disputes a published finding, the task shows **Waiting for daddy’s decision**. daddy checks the worker’s evidence against the requirements. If the owner needs to choose, the task shows the specific question and Telegram mentions the owner. An unanswered question is repeated after 30 minutes.

## Regression tests and independent review

For a pull request that requires CI, the service checks the pushed commit before opening a review round and again before starting a queued reviewer. The same check applies when the target branch moves during a pause and a draft needs to continue on the new base. Pending or missing checks put the task in **Waiting for CI before review**. A failed check goes to the assigned worker with its name and link. A new commit goes through CI again. An explicit waiver applies only to the pinned revision. Automatic merge still requires passing CI.

A task may have its own review round limit. A limit of 15 allows round 15 and pauses that task before round 16. Existing drafts can continue within their round. Other tasks keep running. Change or clear the limit and resume the task to continue.

The worker adds or extends a repository test for each behavior-changing issue and each behavioral finding fixed in review. For example, if a setting can be cleared in the web panel, its Telegram equivalent must clear the same stored value. The worker reports the test path, case, command, and the observed results before and after the fix. One parameterized test can protect several related cases.

On the first review, the reviewer checks all promised outcomes and affected entry points and reports confirmed blockers together. On later reviews, the reviewer independently runs the relevant tests on the pinned revision and checks that they detect the pre-fix behavior. A missing or ineffective regression test is a blocking review finding for the worker. Plans, research reports and documentation use their own acceptance checks.

## Lessons from verified fixes

When a solved failure teaches something its test alone cannot explain, the reviewer can write a short cause and regression check in the final summary and annotate that paragraph with a daddyloop marker naming the criterion, source file and test file. The service validates the reviewer's confirmed write and the pinned checkout. A lesson becomes available after publication of the matching clean review, the required checks and completion of the source task.

For example, the public review displays the paragraph, and the marker on the next line identifies its code and test.

```markdown
After a pause, a late architect reply can target an older run. Match the run, revision and published review before handing a plan to the worker.
<!-- daddyloop:lesson {"key":"architect-plan-at-reviewed-revision","component":"src/core/engine.ts","test":"tests/review-recovery.test.ts"} -->
```

For new tasks in the same workspace, repository and source scope, the service searches SQLite by paths, criteria and symptoms. The architect, worker and reviewer receive up to three matches with the revision, test path and published review link. The entries use at most 2400 bytes of the space remaining after the task and its decision history. The agent verifies applicability on its current revision.

## When a fix keeps missing the same criterion

After two different worker commits still leave the same published criterion broken, the task architect gets a read-only turn on the current PR revision. The architect receives the original plan, the two commit pairs, the worker’s reported checks and the published counterexamples. The task card shows the architecture step in the web panel and Telegram. The architect supplies a revised plan to the assigned worker, who adds the regression test and sends the next revision through independent review. A choice about ownership or order across tasks goes to daddy.

When a dependent task already has a PR, its corrective architect and worker wait for the named prerequisites to finish. The queue shows their task IDs. The scheduler then resumes the saved work with the same slot. If the order would leave a prerequisite without an eligible slot, daddy gets the reason and can change ownership or order.

Rechecking the same commit, a new unrelated finding, and an unconfirmed local change do not count as failed corrections. The task keeps its worker slot during planning. A pause or restart preserves the pending step. The configured task architect applies to these turns even when initial planning was skipped.

## Architecture before implementation

**Queue task** and Telegram `/task DESCRIPTION` start with a read-only planning turn. Send an issue URL to include its description and comments. The planner inspects the repository, validates an existing design or writes a concise one, identifies the acceptance checks, and hands the saved plan to implementation. A material open question waits for an answer. The implementation and independent reviewer receive the same plan.

To skip this step for one task, clear **Check architecture and plan before implementation** in the queue form or send `/task --no-plan -- DESCRIPTION`. Through a conversation with daddy, discuss the design and steps first. In GitHub workspaces daddy creates an issue or adds the agreed brief to the existing issue before dispatch. This path uses the brief directly by default. Ask daddy to validate the plan separately to enable the additional turn.

The architect inherits the session reviewer’s engine, model and reasoning effort. In **Session settings → Architect**, clear **Use the shared reviewer profile** to choose a session default. In **Queue task → Choose a model → Architect**, or on the task card, choose an override for that task. Select the inheritance checkbox to reset it. Telegram offers the same choices under `/models → Architect` and the task card’s **Architect** button. For example, `/task --architect-model MODEL --architect-effort high -- Fix search` overrides planning for this task. The developer uses its worker profile. Changes apply to queued and future planning turns; a running turn finishes on its selected profile.

The plan and implementation use one conversation per task when both profiles use the same engine. Each turn has its own model and permissions. Different engines pass the saved Markdown plan between their conversations. The independent reviewer keeps its own session thread.

## Queue a task and choose a worker

Click **Queue a task** in the web task panel or send `/task DESCRIPTION` in Telegram. The task appears under the same ID in both places. Click it on the website or send `/task DADDY-ID` for its stage, assigned worker and PR. Telegram’s `/queue` lists open tasks.

A worker can file issues or investigate a failure and return a report. daddy checks the report before the task completes. You can read the reviewed report on the website or through `/task DADDY-ID`. Saved code changes go through the usual PR review.

When queuing, you can select a numbered worker, a model and a reasoning level. Without a worker number, the service chooses a free worker. If you ask for a model, it tries a matching free worker first. If none match, the first free worker gets that profile.

Open **Workers** on the website or use `/workers` in Telegram to see the numbered workers and their tasks. Use the worker’s settings to select a model for its next task. **Apply to current task** restarts an active author step in the same working copy. In Telegram, use `/worker NUMBER MODEL EFFORT` and add `--force` to apply it to the current task. [Telegram commands](../telegram/en.md#tasks-and-workers)

If a task needs attention after its PR was merged, open its card on the website or with `/task DADDY-ID` in Telegram and choose **Verify merge**. The service checks the head with the provider and queues a read-only review of the delivered result. Successful verification and required checks complete the task and release its worker slot.

## Pool size

```bash
daddy pool SESSION_ID 3
```

The default is one worker, with a maximum of eight. This requests a target size. The scheduler applies it asynchronously. When reducing `3 → 1`, busy workers finish the **entire task**, including review, fixes and CI, before extra slots disappear. Paused work and work awaiting your input keep their slots. A new size request replaces the previous target.

Host memory/process limits can allow fewer concurrent turns than the pool size. Dependencies control order, not branch merging. daddy decides whether parallel work is useful; a larger limit does not force more workers to run.

## Review and control

The service opens GitHub pull requests and GitLab merge requests ready for review. It publishes completed native reviews and sends saved fixes automatically. On GitHub it also publishes recorded findings when a review stops early, after checking the commit, owner and native comments. Workers receive the published snapshot. An incomplete review cannot authorize completion or a merge. Tasks with a PR still require passing CI and human plan approval if configured. GitHub auto-merge is off by default.

For an existing GitHub issue, use its URL as the task source. A standalone issue URL or a line such as “GitHub issue: https://github.com/owner/repo/issues/42” imports the issue in the selected repository. Other links in the requirements are references. A PR for an imported issue includes its closing reference, so merging into the default branch closes that issue.

With GitHub auto-merge enabled, a reviewed task waits for merge confirmation and keeps its assigned worker. A conflict goes back to that worker with the task’s working copy and conversation. Turning auto-merge off restores completion after review and required checks.

Use the main daddy chat for instructions. Task reports show progress and offer plan approval when required. Plan approval checks the exact revision and generation again.

`/pause` pauses the session; `/resume` resumes it. Closing the CLI/browser only disconnects the client. Stopping the service is different: interrupted work is recorded and must be resumed after inspection. See [operations](../operations/en.md).

## Auto-merge on GitHub

On the web or in Telegram, open the session settings to enable **Auto-merge GitHub PRs**. This includes existing reviewed open PRs and future tasks in that session. In a task card choose **Session default**, **On** or **Off**. An explicit task choice takes precedence.

When GitHub confirms a conflict with the target branch, daddy assigns the repair to a worker. The service merges the pinned branches in the managed working copy. The worker resolves the conflict and tests the result. The service pushes the merge commit to the same PR using a normal push. daddy reviews the new revision and waits for passing CI. If the worker needs a decision about the intended behavior, the task card shows its question.

For an open PR, the service reads the current target branch commit directly from GitHub. If the target advances during a conflict repair, the service preserves the fix on the PR branch with a normal push and reviews it against the updated target. The web task list and Telegram /queue show why auto-merge is waiting, including draft PRs.

When GitHub throttles requests, the service persists the host deadline, then resumes polling and reconciles the PR. A saved fix uses a normal push after verifying both branches. If the target advanced, GitHub must confirm its ancestry, and the new revision goes through independent review. A timed-out review can be retried automatically once.

The service waits for a completed independent review, a published review with no outstanding findings, and passing CI on the current revision. GitHub checks the supplied head SHA and repository rules. The service prefers squash, then a merge commit, then rebase according to the repository’s allowed methods. The task card shows the outcome or why the merge is waiting.
