# Reviewloop 0.5.0

English and Russian are now selectable across the website, terminal workspace and Telegram. Interface preferences persist without changing task content, agent profiles or drafts.

- Visible model provenance: the selected Codex CLI provides model/list, with a five-minute cache, retrieval/version metadata and explicit refresh controls.
- Author and reviewer model/effort choices remain independent; model names and supported effort values come from the CLI rather than a maintained name list.
- CLI version checks run every six hours and can be requested immediately. Telegram update alerts are deduplicated, with a separate notification preference.
- Diagnostics distinguish the bundled Codex from external CLI installations. Explicit local runtime selection validates the app-server catalogue, requires an idle queue and preserves updater-compatible launcher paths.
- Claude installation/version diagnostics are available; the Claude agent runtime is still not implemented.

Existing tasks, accounts, pairing, policies and model defaults are preserved. The updater does not install new binaries or restart running agents automatically.
