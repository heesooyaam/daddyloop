# Reviewloop 0.2.0

Installable single-host service with an interactive CLI, persistent website access, phone pairing, Telegram controls, resource limits, safe cache cleanup and optional Arcadia support.

- Self-contained Linux x64/arm64 archives include Node, Codex CLI, GitHub CLI and the web UI.
- systemd owns the backend and agent processes. No terminal or tmux session is required.
- Tailscale Serve or an existing HTTPS proxy connects phones directly to the host. Browser sessions are individually revocable.
- A paired private Telegram bot supports role conversations, notifications and revision-bound publication confirmation.
- Cache pruning preserves author work, active snapshots, history and credentials. Resource pressure interrupts work with recoverable state.
- Arcadia uses existing corporate tools, full revisions, pinned diff IDs and leased mounts.

This is a prerelease. Native GitHub/GitLab/Arcanum publication and author push are covered by fixtures, not a live end-to-end provider cycle. A live Codex transport smoke, native Arc read, managed-service SSH-disconnect smoke and HTTPS browser workflow were verified. External phone connectivity and real Telegram delivery need account setup.
