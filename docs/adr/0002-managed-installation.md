# Managed installation, remote access and integrations

Status: implemented in 0.2.0; external account setup and live provider-write validation remain.

The next release makes Reviewloop usable as an installed service. Backend, author and reviewer run on one machine. A laptop is a control client, never a required part of the path between the phone, service and agents. Existing author/reviewer separation, human publication gates, pinned revisions and durable operation IDs remain in force. Multiple execution hosts are explicitly out of scope for this release.

## Delivery plan

1. Build a release archive with its UI and dependencies; provide one installation command, stable `reviewctl` entry point and a guided setup. Keep state and credentials outside the versioned installation directory.
2. Manage the backend with the operating system service manager. On unified-cgroup Linux enable the user's lingering service manager; on hybrid/v1 hosts use a system unit running as the ordinary user with its own memory cgroup. Add start/stop/restart/status and an interactive CLI. Recover jobs interrupted by both crashes and graceful shutdown.
3. Add an explicit HTTPS public origin, revocable browser sessions, expiring device pairing, a phone-friendly connection page and persistent Tailscale Serve or an existing HTTPS proxy. An SSH tunnel is only a temporary desktop development option.
4. Add a Telegram Bot API integration using long polling, explicit private-chat pairing, notifications, task lookup and author/reviewer conversations. Publishing requires a one-use confirmation tied to the reviewed revision.
5. Add inspected, task-owned cache cleanup. Preserve author changes, active jobs, database history and credentials. Never delete shared Arc stores or arbitrary caches based on size. Report cleanup candidates and reclaimed space; allow safe automatic cleanup under pressure.
6. Add Arcadia/Arcanum as an optional integration using locally installed company tools. Keep Git and Arc workspace handling separate. Use full revisions and leased mounts, and never switch the user's source checkout. Validate against read-only inspection of the supplied Arc workspace; use synthetic provider fixtures for mutations.
7. Validate a fresh install, terminal/session loss, service restart, phone-origin authentication, Telegram retries and controls, cache ownership boundaries, and Git/Arc regression behavior. Review the implementation and record remaining external setup steps honestly.

## Operating boundaries

- Installing software cannot pre-authorize an external account. Codex login, a network account and a Telegram bot remain one-time human setup steps in the wizard.
- Publishing the repository is controlled by its owner. Release preparation must not silently change repository visibility.
- Browser/API access keeps authentication and CSRF protection when HTTPS is added; it must not achieve connectivity by allowing arbitrary origins.
- Telegram access is bound to a paired private chat and user. Unknown chats receive no project data.
- Cleanup may remove only verified reproducible artifacts owned by Reviewloop. Shared caches use their native maintenance tools and explicit scope.
- A detached shell is not sufficient evidence of surviving logout on every host. The installer must expose the actual service mode, and validation must cover the service manager's lifecycle.
- The installed service owns both local agent sessions and manages their processes without tmux.
