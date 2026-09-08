# Review of managed installation and integrations

Scope: the v0.2 single-host service, CLI, installer, device access, Telegram, cache/resource controls and Arcadia adapter. Review used AGENTS.md, architecture.md, the managed-installation ADR and the code-review checklist. This report is a self-review, not independent reviewer approval.

## Defects found and fixed

- **Important — invalid service working directory:** quoted WorkingDirectory was rejected by systemd 245. Emit the raw absolute path with systemd specifier escaping, validate paths, and test using the actual systemd parser. Installation can also repair its own inactive failed unit.
- **Important — graceful cancellation stranded tasks:** cancelled jobs could leave a task permanently marked as working. Shutdown and resource interruption now persist needs_input and invalidate the generation; legacy cancelled jobs recover explicitly. Regression tests cover shutdown and memory pressure.
- **Important — public HTTP origin accepted:** an HTTPS public hostname could accept its HTTP origin. Require the exact configured origin. Browser tests exercise Secure cookies, one-use pairing and rejected foreign origins.
- **Important — Arc checkout recovery:** a journal can survive an interrupted checkout while the mount remains on its original branch. Recheck author branch and ancestry before starting an agent. Keep the lease and fail closed if checkout did not finish. Preserve the author's named branch when its pushed head becomes the next reviewed revision.
- **Important — Arc output and identity:** trimming native status removed leading status columns; generic handling could also lose negative draft IDs or target a different diff. Preserve leading columns, keep signed IDs and bind native effects to the pinned diff. Publish only explicitly tracked drafts.
- **Important — failed CLI connection replaced credentials:** validate the proposed server/token in memory before updating the saved client credential.
- **Important — Telegram startup dependency:** a failed bot initialization must not keep the HTTP server unready. Startup and shutdown now use an independent abortable integration lifecycle.
- **Important — installer command collision:** check for an unrelated existing reviewctl before switching the current release. Preserve differing same-version installations and reject checksum failures.
- **Important — cache paths through directory aliases:** Git reports canonical worktree paths, which can differ from a configured path under a symlinked temporary/data directory. Compare canonical paths before removal. A real Git worktree test verifies cleanup while retaining dirty, current, busy and author copies.
- **Important — Telegram account replacement:** a new bot cannot reuse the old bot's polling offset, chat binding or publication buttons. Reset these when its native bot ID changes, and allow explicit private-chat re-pairing/revocation.

## Evidence

- 74 unit/contract tests cover publication identity, stale generation fencing, provider fixtures, Telegram pairing/replays/changed-draft confirmation, device sessions, cleanup ownership and service interruption. Type checking, formatting and production builds pass.
- Browser workflows exercise the full demo loop, plan approval and mobile layout. A separate HTTPS phone context stays usable after the laptop context closes; unapproved origins are rejected.
- A real temporary loopback SSH login was terminated while a demo task was queued. The managed service PID stayed unchanged and the task reached awaiting_publication after disconnect. The temporary SSH daemon and keys were removed; no global SSH configuration changed.
- The actual host system service runs as the ordinary user in its own cgroup with an 8 GiB memory limit. The actual Tailscale userspace daemon starts under its separate managed unit with a 512 MiB limit and reaches the account-login step.
- The built Linux x64 archive passes the real installer through a loopback mirror: fresh installation, paths containing spaces, bundled CLI execution, idempotent reinstall, preserved state, bad-checksum rejection and unrelated-command preservation. Tagged release builds repeat this test on both architectures.
- A real Arcanum PR was read using the configured shared-store lease helper: full head/base hashes, active diff identity and 203 checks were returned. Read leases were released. The user's source checkout and its edits were preserved.

## Remaining external validation

Live Telegram delivery needs a bot token and private-chat pairing. External phone reachability needs Tailscale account login or an existing configured HTTPS proxy. Provider mutations and Arc workspace transitions are covered by fixtures; a live native draft → publish → author commit/push loop is still required on an explicitly chosen test PR. The host was not rebooted: boot persistence is configured in systemd, while actual logout persistence was tested through SSH.
