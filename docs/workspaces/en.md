[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Workspaces, sessions and working copies

| Name      | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| Workspace | A named source repository on this server: path, optional subdirectory and base branch. |
| Session   | One conversation with daddy, its tasks and worker pool.                                |
| Task      | One work item assigned to a worker.                                                    |

`Work` can mean `~/arcadia2` on one server and `~/arcadia` on another. These defaults belong to the host. Create as many sessions and tasks as needed within a workspace.

```bash
daddy workspaces add ~/work/app --name App
daddy workspaces add ~/arcadia2 --name Work --base trunk
daddy workspaces set Work ~/arcadia --base trunk
daddy workspaces discover
daddy workspaces browse
```

For a self-hosted Git service, select its module explicitly if necessary:

```bash
daddy workspaces add ~/work/app --name App --provider gitlab
```

The corresponding repository module must be enabled. Arcadia also needs [its host setup](../arcadia/en.md).

## Change the directory for one session or task

A session saves a snapshot of the workspace defaults. Editing the workspace later affects new sessions only.

```bash
# Override the whole new session, preserving Work's defaults.
daddy new --workspace Work --repo ~/arcadia2 --scope alice "Investigate the search issue"

# Override this next message only; existing tasks keep their own copies.
daddy talk SESSION_ID "Take the next ticket" --repo ~/arcadia --scope alice
```

On the website use the repository fields in the new-session form or beneath the composer. In Telegram and the interactive CLI, use `/repo /absolute/server/path`; `/repo default` cancels it. The Telegram selection expires after ten minutes. An expired selection is rejected rather than silently sending work to another directory.

## What happens to the source repository?

Git workers get managed working copies; Arcadia workers get leased mounts. The source branch and local changes remain in place. Uncommitted source edits are not copied into the worker's new checkout. A relative scope selects the starting directory inside the managed copy, not a second repository.

The source repository needs an appropriate remote and a committed base revision. A workspace name is not permission to use an unrelated directory. Repository roots and scope boundaries are checked on the server.
