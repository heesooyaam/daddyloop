[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Operate the service

```bash
daddy service status
daddy service logs --follow
daddy up
daddy down
daddy restart
```

The Linux systemd service runs as your user. On unified cgroups it uses the lingering user manager; on other supported hosts it uses a system unit with an explicit user/group. A separate Tailscale service provides permanent private networking. The app does not depend on tmux, a laptop browser or an SSH session.

Graceful stop interrupts agent turns and records recoverable incomplete work. Crash recovery also fences interrupted generations. Inspect the task report and resume through daddy; neither restart nor resume silently treats unfinished review as complete. A lost native write is reconciled before it is repeated.

## Files and accounts

- Config: `~/.config/daddyloop/config.json`; override with `DADDYLOOP_CONFIG`.
- Data: configured `dataDir`, default `~/.local/share/daddyloop/data`.
- Database: `daddyloop.sqlite`, WAL enabled. Current schema: **7**; config format: **3**.
- Releases: `~/.local/share/daddyloop/releases/`; `current` selects an immutable installation variant.
- Provider tokens: `~/.tokens/github`, `~/.tokens/gitlab`, `~/.tokens/tracker`, or the corresponding provider environment settings. Token contents never belong in Git.
- Agent executable overrides: `executables.<module-id>` in config. The Codex module also accepts `DADDYLOOP_CODEX_BIN`.

Root browser access uses the local `access-token`. HTTPS pairing creates separately revocable browser credentials. `daddy devices` lists them; `daddy revoke-device ID` revokes one. `daddy phone` creates a fresh one-use link. See [web access](../web/en.md).

## Resources and cleanup

Defaults reserve 2 GiB of RAM and 10 GiB of disk, stop starting work at 90% disk usage, and cap the combined service/children at 8 GiB. Hosts can use stricter values. Memory checks include cgroup limits rather than host RAM alone.

```bash
daddy cache status
daddy cache prune          # dry run
daddy cache prune --apply  # remove verified eligible entries
daddy cache auto on
```

Cleanup only considers owned temporary downloads and old, clean managed reviewer copies. Active, dirty, unpushed, unknown and worker-owned work stays protected. Automatic cleanup is off by default and runs under disk pressure. Restart the service after changing its policy. It does not delete a large cache just because it is large.

Before disk-heavy work inspect `df -h /home` and available RAM. Arcadia stores/mounts require ownership checks; never truncate a store as a routine cleanup step. `daddy cache arcadia-gc` is an explicit ordinary GC operation, not a blanket removal of user work.

## Updates and removal

Finish or pause active work and back up the config/database before replacing an application release. Run the pinned installer with the required module selection. Earlier config/database formats need an explicit conversion; runtime code does not guess or migrate them. Backups are separate from executable compatibility.

`daddy service uninstall` removes the app service while preserving data and credentials. The separately installed network service remains separate. Service changes may require sudo in system mode. Codex-only updates can preserve active turns; see [agents](../agents/en.md).
