# Reviewloop 0.4.0

Start a task from a GitHub issue or Yandex Tracker ticket, discuss the requirements with its author, then start implementation. The service saves the isolated changes, creates a native PR and runs the review/fix loop.

- Independent Codex model and reasoning-effort profiles for author and reviewer, selected from the account's model catalogue. Available in the terminal, CLI commands and web UI.
- Parent/child ticket groups: each child gets its own author and working copy; the group shares one persistent reviewer session and a serialized review queue. Configurable total concurrency, defaulting to one active agent.
- Finished reviews publish automatically for new tasks. Existing saved policies are retained, and manual publication remains available.
- Telegram notification settings in the TUI, website, CLI and paired bot. Quiet completion/attention updates by default; all intermediate replies are optional.
- Durable PR creation and recovery after uncertain responses, exact submitted-head checks, scoped credentials and preserved source checkouts.
- README guides and actual terminal/browser screenshots for ticket setup, models and notifications.

Linux x64/ARM64 bundles preserve existing accounts and task data. Database schema 3 adds review groups; take a backup before upgrading because older releases reject newer schemas. This remains a prerelease. Native Arc writes are fixture-tested, while real Tracker reads and both requested Codex model profiles were verified on the development host. Telegram delivery requires the owner's bot token and private-chat pairing.
