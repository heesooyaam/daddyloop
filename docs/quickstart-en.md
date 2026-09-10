# Daddyloop

Give Daddy a goal or a ticket. He plans the work, assigns writers, reads their reports and reviews the result. You use one conversation in the CLI, browser or Telegram topic.

## Install

Linux x64 and ARM64:

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.7.0/install.sh | bash
daddy auth codex
daddy auth github
daddy projects add ~/projects/my-app --name MyApp
daddy
```

The download command requires public release access. For a private repository, download the release using an authenticated GitHub CLI.

The release bundles Node, Codex and GitHub CLI. A systemd service keeps running after the terminal or laptop disconnects. `reviewctl` remains a compatible executable alias; existing configuration, credentials and data paths are preserved during upgrades.

## Projects, sessions and writers

A project is a registered source repository on the server. It has a name, VCS, base branch and optional starting subdirectory. A Daddy session has its own conversation and task queue. Each task has a separate writer history and managed working copy.

Use `/new` in the terminal to choose a project, or:

```bash
daddy new --project MyApp "https://github.com/acme/my-app/issues/42"
daddy talk SESSION_ID "Also handle https://github.com/acme/my-app/issues/43"
daddy pool SESSION_ID 3
```

One writer is allowed by default. The pool limits simultaneous writers, not the number of queued tickets. Daddy decides which tasks are independent. Dependencies order execution; they do not merge branches. Keep tightly coupled edits together or plan integration explicitly.

The website's Projects screen provides a server directory browser. Telegram `/projects` offers detected repositories. For Arcadia, register an existing shared-store mount; workers use separate leased mounts. The source checkout remains intact, and one workspace stays available for Daddy/review.

## Telegram topics

Run `daddy telegram setup` once. In the private bot chat, send `/workspace`, then select a group with Topics enabled and grant the bot administrator rights to manage topics. Telegram's Bot API does not create the group on behalf of the user.

A topic is created for each Daddy session. Send natural-language messages or ticket links inside that topic. `/pool` changes the writer limit; `/models` selects Daddy and writer models. Only the paired user can control sessions. Writers' raw messages are not forwarded; Daddy reports the results.

## Models and updates

Daddy and writers can use different Codex models and reasoning efforts. Model choices come from the selected CLI's `model/list`; refresh is available in the interfaces. Claude's agent runtime is not implemented yet.

Use Telegram `/updates` to confirm a Codex update or rollback without SSH. Updates run on the server, validate the downloaded package and protocol, preserve running turns, and use one operation result notification.

```bash
daddy runtime update --yes
daddy runtime update-status
daddy runtime rollback --yes
```

## Access and safeguards

For phone browser access, configure persistent HTTPS with `daddy web tailscale` or `daddy web origin https://…`, then pair with `daddy phone`. Telegram uses the server's outgoing connection independently of the laptop.

Check storage with `daddy cache status`; preview cleanup with `daddy cache prune`. Adding `--apply` removes only verified eligible artifacts. Author changes, credentials and workflow history are preserved. Native review Markdown and revision fences remain authoritative. Automatic publication follows task policy; PRs are not automatically merged.

## Project defaults and per-task repositories

Projects are local to the server. `Work` can point to `~/arcadia2` on one machine and `~/arcadia` on another. A new Daddy session pins that server's project defaults. Changing defaults with `daddy projects set Work ~/arcadia` affects future sessions only.

Use `daddy new --project Work --repo ~/arcadia2 "Goal"` to override an entire new session, or `daddy talk SESSION_ID "Next ticket" --repo ~/arcadia2 --scope alice` for a single request. The web composer has the same folder, scope and base controls. In Telegram use **Repository for next task** or `/repo <path>`, confirm the folder, then send your task. The next message returns to the session defaults. Existing tasks retain their own workspaces; uncommitted source changes are not copied into managed checkouts.

Pool changes are asynchronous: `daddy pool SESSION_ID 1` requests one slot. Busy writers finish the whole task, including review fixes and required checks, before excess slots retire. Paused or failed work still owns its slot. The requested/applied sizes and task ownership survive service restarts.
