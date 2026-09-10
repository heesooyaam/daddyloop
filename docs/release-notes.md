# Reviewloop 0.6.0

Update Codex directly from the paired Telegram bot: `/updates` → **Update Codex** → **Confirm**. The server downloads and validates the selected version, reports the result, and offers rollback. Closing Telegram or disconnecting the laptop does not stop the update.

- Separate immutable Codex installations, verified against the official npm package's SHA-512 checksum. System CLI installations and Reviewloop release files remain intact.
- Candidate version, app-server initialization, model catalogue and saved profiles are checked before activation. Each running agent finishes its current turn; subsequent turns use the selected CLI.
- One-use expiring confirmations, durable recovery after service interruption, validated rollback and deduplicated completion messages.
- Download size, time, disk and memory limits; temporary archives are removed after the operation.
- Remote CLI controls: `reviewctl runtime update --yes`, `runtime update-status`, and `runtime rollback --yes`.
- English and Russian Telegram cards and a distinct label for Codex versions installed by Reviewloop.

Existing tasks, model defaults, conversations, accounts and Telegram pairing are preserved. Updates require confirmation. Claude remains diagnostic only.
