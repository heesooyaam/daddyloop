# Operations

## Installation and lifecycle

Reviewloop is a single-user service on one Linux host. The API, SQLite, scheduler and both agent sessions belong to that host. CLI and browser clients can disconnect without stopping jobs. No tmux or laptop relay is required.

The installer places immutable versions in `~/.local/share/reviewloop/releases/<version>` and points `~/.local/bin/reviewctl` through `current`. Node, Codex CLI, GitHub CLI and UI assets are bundled. Git is supplied by the host or installed through apt. Reinstalling the same archive is idempotent; a different archive with the same version is rejected. Failed checksum verification does not switch the installed version. Installation changes files under the chosen prefix; setup additionally configures the OS service.

Configuration defaults to `~/.config/reviewloop/config.json` (`REVIEWLOOP_CONFIG` overrides it). New installations store data in `~/.local/share/reviewloop/data`; an existing project's `.reviewloop/reviewloop.sqlite` is adopted on first setup. An explicit configured data directory takes precedence. Upgrades retain that path.

On unified-cgroup Linux, setup enables the user systemd manager and lingering. On older hybrid/v1 hosts it installs `reviewloop-<uid>.service` as a system unit with explicit `User` and `Group`. Agents still run as the ordinary user. The system service has its own memory cgroup. `reviewctl service status` reports the actual mode, PID, memory limit and logout persistence.

```bash
reviewctl init
reviewctl up
reviewctl down
reviewctl restart
reviewctl service status
reviewctl service logs --follow
reviewctl service uninstall
```

`down` and `uninstall` preserve database history, credentials and working copies. They do not remove the separately installed private-network service. A system-mode installation needs sudo for unit changes; normal control API operations do not. The installer can acquire sudo interactively. For direct service installation without passwordless sudo, run `sudo -v` first.

Graceful stop cancels active runs and records a recoverable `needs_input` state. Crash recovery marks interrupted runs incomplete. Neither path silently replays an uncertain provider write or declares an unfinished review successful. After inspection use `retry` for the reviewer or `resume` for the author.

## Permanent website access

The HTTP backend always listens on loopback. Configure one HTTPS origin and a server-side proxy. A phone must reach that proxy directly, without an SSH tunnel on the laptop.

`reviewctl web tailscale` installs pinned, checksum-verified Tailscale binaries in the data directory, starts a separate systemd network service, asks for account login and configures Tailscale Serve in background mode. Userspace networking does not replace the host's DNS, routes or system Tailscale installation. The daemon has a 512 MiB memory limit. Install Tailscale on the phone and join the same network. This is private tailnet access, not public Funnel.

An alternative is an existing HTTPS reverse proxy. For example, Caddy on the service host:

```caddyfile
review.example.com {
    reverse_proxy 127.0.0.1:4317 {
        flush_interval -1
    }
}
```

Point the domain at the host and configure the proxy's certificate and network access, then:

```bash
reviewctl web origin https://review.example.com
reviewctl restart
reviewctl phone
```

Preserve the incoming Host header, keep SSE responses unbuffered and permit long connections. The API accepts only the configured origin or matching local origins. Pairing links expire after five minutes and can be consumed once. Their secret is in a URL fragment, removed by the UI on consumption. Each browser receives its own HttpOnly session cookie, Secure for HTTPS, with a 90-day expiry. Revoke a device using the UI or `reviewctl revoke-device <id>`.

The root token in the data directory remains a local administrative credential. Rotating it does not revoke separately paired devices; revoke those explicitly if needed. `reviewctl connect <https-url>` configures a separate CLI client with a hidden token prompt and validates the connection before replacing its previous credential. The prebuilt managed installer is Linux-only; a macOS CLI client requires a source build with Node, while its browser works directly.

The server must remain powered on. Network outages can temporarily interrupt clients and provider calls. A server restart preserves history but requires explicit resumption of an interrupted agent turn. Logout persistence is not a claim of uninterrupted work through a reboot.

## Accounts and Telegram

GitHub credentials: `GITHUB_TOKEN` / `GH_TOKEN`, `REVIEWLOOP_GITHUB_TOKEN_FILE`, or `~/.tokens/github`. GitLab equivalents: `GITLAB_TOKEN` / `GLAB_TOKEN`, `REVIEWLOOP_GITLAB_TOKEN_FILE`, `~/.tokens/gitlab`. Host-specific token files use `github-<host>` / `gitlab-<host>`. Configure a custom provider host with `REVIEWLOOP_GITHUB_HOST` or `REVIEWLOOP_GITLAB_HOST` when using a generic credential. A token is not sent to an arbitrary host from an attached URL.

`reviewctl auth github` uses gh's browser/device flow and saves a private credential file for the service. SSH authentication for Git is separate from API authentication. GitHub API permissions must allow reading code/checks and writing pull requests; automatic author push also requires repository write permission. GitLab needs a user API token with project access. Branch protection still applies.

Arc credentials are read from the existing Arc token environment or `~/.tokens/arcadia`. Public packages contain no corporate tools or credentials. `reviewctl arcadia setup` verifies the local helper, shared store and native identity. Author and reviewer each need a separate free clean configured mount. Leases are journaled before checkout, so an interrupted checkout is preserved and fails closed on recovery. Never remove that mount to clear an error without inspecting its changes.

Telegram setup needs a dedicated bot without an existing webhook. Save its token in `~/.tokens/reviewloop-telegram` or use the hidden setup prompt. `reviewctl telegram setup` activates polling and prints a one-use ten-minute private-chat pairing link. The binding checks both chat and user IDs; groups and unknown chats receive no task data. A newly paired chat replaces the old binding.

Polling offsets and update receipts survive restarts and are reset when changing the bot identity. Duplicate callbacks cannot repeat a publication. A publish button expires after five minutes and binds the generation, head, review ID and exact draft snapshot. Editing the draft or advancing the revision invalidates it. `reviewctl telegram unpair` revokes the chat and outstanding buttons. Notifications are best effort: an ambiguous outgoing request is not blindly repeated, so a Telegram delivery failure can lose a notification. The database/UI remain authoritative. Telegram initialization errors do not prevent the website from starting.

## Resource controls and cleanup

Defaults: one active agent, 8 GiB combined service/child memory limit, 2 GiB RAM reserve, 10 GiB disk reserve, 90% maximum disk usage. On the original development host the configured disk thresholds are 100 GiB and 80%. Linux monitoring uses MemAvailable plus the process's cgroup budget, subtracting reclaimable inactive file pages from usage. UI status distinguishes the service budget from total host RAM.

New agent runs are gated on available resources. An active run is cancelled when the resource check detects pressure. A sudden allocation can still hit the kernel limit before the next check; systemd and interrupted-job recovery handle that case. Codex turns and subprocesses also have time/output limits.

```bash
reviewctl cache status
reviewctl cache prune
reviewctl cache prune --apply
reviewctl cache auto on
reviewctl restart
reviewctl cache arcadia-gc
reviewctl cache arcadia-gc --apply
```

Cleanup defaults to a dry run. Only old, clean, registered Git reviewer snapshots and explicitly marked temporary cache directories are eligible. Current snapshots, the newest retained copy, busy tasks, author work, unknown ownership and symlinks are preserved. Age defaults to seven days. The owner, cleanliness, path and active task state are rechecked under a task lock before removal. Automatic cleanup is off by default and only runs under disk pressure, at most once per five minutes.

Arc maintenance uses the native `arc gc --dry-run`, or ordinary `arc gc` with `--apply`, through a temporary lease. It never uses `--truncate`. Reviewloop does not erase shared object stores, `ya` caches, unrelated `/tmp` directories, author worktrees or database history. Disk inspection is still necessary when another project's artifacts are the cause of pressure.

## Recovery and backups

| Situation                                                                 | Next step                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Service stops during an agent turn                                        | Inspect saved work and native review; retry the reviewer or resume the author.      |
| Provider response is lost after a write                                   | Outbox reconciliation must confirm the native effect before any retry.              |
| PR revision changes during review                                         | Reconcile and inspect the stale draft before reviewing the new revision.            |
| Another pending GitHub review exists                                      | Publish/discard it explicitly; Reviewloop does not adopt or delete it.              |
| GitLab/Arcanum draft set is partly published or contains unrelated drafts | Inspect the native draft group; the handoff remains blocked until unambiguous.      |
| Author has unpushed/diverging work                                        | Work is preserved; reconcile it without force-push/reset.                           |
| CI is missing/red                                                         | Fix CI or record a reasoned waiver for this exact revision.                         |
| Arc lease is unavailable or its branch changed                            | Inspect the journal and mount ownership; no replacement agent starts on that mount. |

Stop the service before copying the entire data directory, or use SQLite's backup API for a consistent live database snapshot. Copying the database file while ignoring its WAL can lose recent state. Preserve worktrees with unpushed changes. Backups contain source and review content and should remain private.

## Validation boundaries

The v0.2 review report records fixture, browser, real SSH-disconnect and native Arc read validation. A live native draft/edit/publish/author-push cycle is still outstanding for the providers. A live Codex smoke verified scoped dynamic tools and persistent thread resume. Real private-chat Telegram delivery and a complete demo workflow have been verified. External phone reachability requires the owner's network setup.

Existing PRs are attached; creating a plan or implementation PR from a bare idea is outside this flow. Distributed runners, automatic merge, webhook ingestion, automatic CI repair and interactive command-approval relay are not implemented.

Codex runs with a read-only reviewer sandbox and workspace-write author sandbox, network disabled and provider-token environment variables removed. These are runtime policies, not a separate OS identity boundary. The service refuses permission-expansion requests and records them. A reviewer that cannot execute a write-requiring test must report the limitation and use real CI evidence; it cannot claim the test passed. Use a dedicated account or stronger sandbox for untrusted repositories.

## Development-host browser tests

The original Ubuntu 20.04 host uses a Chromium fallback plus extracted libnspr4/libnss3 under `.tools/browser-libs`, without installing system packages:

```bash
PATH="$PWD/.tools/node/bin:$PATH" \
LD_LIBRARY_PATH="$PWD/.tools/browser-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
npm run test:e2e
```

On a supported Linux host use the ordinary Playwright installation from the README. Test-generated TLS certificates and private probe data stay in ignored task state.

### Telegram connection failures

`reviewctl telegram setup --token-file /absolute/path/to/token` validates the account and saves the file path. Since 0.4.1, transient DNS, socket and server errors on read-only Bot API requests get bounded retries; the service also reconnects failed startup in the background with backoff. Credentials errors and unexpected redirects are reported explicitly. Requests retain HTTPS verification and do not forward bot tokens across redirects.

Use `reviewctl telegram status` to inspect the connection and `reviewctl telegram pair` to obtain a new private-chat link. A temporarily disconnected bot does not require re-entering its token. Outgoing messages and action responses are not automatically repeated after an ambiguous failure. Polling errors clear after reconnection; uncertain outgoing deliveries retain their own diagnostic.
