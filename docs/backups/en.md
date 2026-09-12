[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Keep a copy of daddy's work

A portable backup is a `.tar.gz` archive with a versioned manifest and SHA-256 hashes. Creation and restoration stream files to disk, with a size limit and the configured free-space reserve. It is a private archive of your code and conversations; store it somewhere you trust.

## Create and check a backup

On the original host, let important work finish or pause the relevant sessions, then:

```bash
daddy down
daddy backup create ~/daddy-2026-09-11.tar.gz
daddy up
daddy backup inspect ~/daddy-2026-09-11.tar.gz
```

`create` requires the service to be stopped and holds the same host lock as `serve`. It does not interrupt agents for you. Stop other processes editing the source folders too; if a file or Git/Arc state changes during capture, creation fails so you can retry. The existing destination is never overwritten. The command prints the archive's checksum, file count, size and any recovery warnings.

The default uncompressed limit is **20 GiB**. Use `--max-gib 40` on create, inspect and restore for a larger snapshot after checking disk space. Temporary staging and the final archive both need room. Creation observes `resources.minDiskGiB`; cleanup of temporary files is limited to its own staging directories.

## What travels

| Included                                                                                        | How it is restored                                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Sessions, tasks, messages, requirements, decisions, reviews, event history and recorded results | SQLite snapshot; incomplete tasks and sessions start paused                                  |
| Worker/daddy profiles, language and resource/cache preferences                                  | `restored-config.json` and saved preferences                                                 |
| Managed Git object stores and working copies                                                    | Files copied; linked-worktree paths rewritten                                                |
| Local commits and branches in registered Git sources and task-specific source overrides         | Git bundles, captured once per source                                                        |
| Tracked, staged and non-ignored untracked files in those Git sources                            | Separate restored source folders; original index preserved                                   |
| Application artifacts and saved voice files                                                     | Copied with the task data                                                                    |
| Leased Arcadia task changes                                                                     | Base/head metadata, committed/index/working patches and changed files in `recovery/arcadia/` |

Git source files ignored by Git, such as dependency directories, are not captured. Managed worker copies are preserved in full, so run a safe cache cleanup before the backup if needed. Missing source repositories are reported in the manifest. Non-portable symlinks, unsupported special files, oversized snapshots and ambiguous Arc rename paths cause an explicit error instead of silent omission.

Not transferred: API/OAuth credentials held by daddyloop, browser tokens, Telegram authorization, bot polling state, Tailscale identity, machine-specific executable paths, installed CLIs/models, live processes or Arc mount leases. Reinstall the modules on the destination. Code, comments or conversation text can themselves contain private information; the archive is not a general secret scanner.

## Move to another machine

Install the **same daddyloop version** and the required modules on the new host. Copy the archive using your normal secure file transfer. Stop its empty service before selecting the restored configuration:

```bash
daddy down
daddy backup inspect ~/daddy-2026-09-11.tar.gz
daddy backup restore ~/daddy-2026-09-11.tar.gz --to ~/daddy-restored
export DADDYLOOP_CONFIG=~/daddy-restored/restored-config.json
daddy up
```

`--to` must name a directory that does not exist. Restore verifies hashes and database integrity before publishing the result. It never merges into a live data directory or overwrites an existing checkout.

By default, Git sources are rebuilt under `~/daddy-restored/restored-sources/` and workspace/task paths point there. You can inspect their commits and uncommitted files normally. To use an existing repository on the new host, pass a mapping:

```bash
daddy backup restore ~/daddy-2026-09-11.tar.gz \
  --to ~/daddy-restored \
  --map Work=/home/me/arcadia \
  --map App=/home/me/projects/app
```

A mapping changes the source reference; it does not write into that existing repository. Captured Git source files remain in `restored-sources` for inspection. A one-task override can be mapped by its original absolute path: `--map /old/host/repo=/new/host/repo`. Unmapped Arcadia sources require a new mount before work can continue.

The service unit created by `daddy up` retains the selected configuration path. Keep `DADDYLOOP_CONFIG` set for subsequent CLI commands, or add that export to your shell configuration. Authenticate providers, reconnect Telegram and set up [web access](../web/en.md) on the new machine. For the same Telegram bot, stop its old installation before pairing the new one. Browser devices must sign in again.

## Context and unfinished work

The conversation with daddy, task requirements, worker reports, published reviews and decisions survive. Native Codex/Claude session handles are deliberately cleared: copying an ID does not copy the CLI's internal history. The next turn creates a new native context using daddyloop's saved material. Unrecorded intermediate thoughts and native CLI history outside daddyloop are not restored.

Open each paused session, inspect the board and saved files, then use **Resume** or `/resume`. The service reconciles recorded native writes against the provider instead of treating an interrupted request as a confirmed success. Completed tasks stay complete; a restored snapshot does not merge PRs or automatically rerun the crew.

For **Arcadia**, inspect `recovery/arcadia/<task>/<role>/state.json`, acquire a new mount through the normal lease helper and restore the base revision. Apply the committed, index and working patches in that order, inspect the saved changed files (including untracked files), and verify the diff. Then reconnect the task to the restored work. The first backup format preserves this material but does not automatically recreate Arc branches or apply patches to a live mount.

The first format has no built-in remote storage scheduler or encryption. Use your normal encrypted storage and scheduling after verifying a restore. Creating an archive is not a substitute for testing that you can recover it.

Session instruction sets and queued-turn snapshots include the actual skill text and checksums. Restored work needs no old skill folder or GitHub download; source locations remain attribution. See [instructions](../instructions/en.md).

The preset library is included in full, along with each session’s frozen preset copies and individual component choices. A library revision can differ from a session’s selected revision; restoring preserves both.
