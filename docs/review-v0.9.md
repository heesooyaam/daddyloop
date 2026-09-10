# Review: daddyloop 0.9

Full self-review covers account quota reads, reset redemption, caller/account boundaries, UI behavior and lowercase product copy. No independent review agent was used. Sources: `docs/architecture.md`, the locally generated Codex 0.154.0 protocol, and [official app-server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

## Findings addressed

- **A quota window is not always five hours.** Labels use the backend's duration. The actual account returned a weekly primary window. Remaining percentages are never used to infer permission to resume agents.
- **Finite reset credits and uncertain delivery.** Preparation is read-only against Codex. Confirmation persists intent and a UUID before the consumption RPC. The backend receives that same UUID when recovering, so a lost reply does not request a second credit. A pending operation blocks another logical reset. The last-credit case remains recoverable even when the available count becomes zero.
- **Identity changes and expired confirmation.** Plans bind the caller and account fingerprint. Confirmation checks expiry, re-reads the account on the connection used for consumption, validates the selected credit when details exist, and fences executable changes. Account IDs are omitted from public quota views.
- **Refresh races.** A successful reset is recorded before refreshing quotas. A failed refresh produces stale/unavailable data while preserving the successful operation result. Generations prevent pre-reset reads from replacing the new snapshot. Quota requests run independently from the main conversation.
- **Unavailable data.** Missing reset-credit information is unknown rather than zero. Older/unsupported account modes and network failures cannot enable a reset from stale cached information. The shared quota and update timestamps are visible.
- **Compatibility and casing.** Product-owned strings, help, documentation and screenshots use lowercase branding. Internal IDs and user-authored content retain their identities. The configured bot's display name was set to `daddy-ops-8`; its existing username remains the same because the requested hyphenated text is not a valid Telegram username.

## Validation

`npm run check`: type checking, 193 tests and production build. Tests cover owner/account/expiry guards, preparation without consumption, durable pending-operation recovery, last-credit replay, post-success refresh failure and delayed pre-reset reads. API tests require authentication and explicit confirmation. Telegram tests reject another user's confirmation.

Twelve browser scenarios include mobile quota display, cancelling confirmation without a write, and consuming exactly one fixture credit. Screenshot/PTY capture uses offline usage fixtures and verifies terminal restoration and unchanged daemon PID after client exit. Real account probes only read usage; no live reset credit was spent.

## Limits

Quota is shared by the selected Codex account, not allocated separately per writer. Banked reset availability is determined by Codex. This release does not buy credits, clear model context, spend resets automatically or automatically resume work based on a reset timer. An unresolved reset initiated from Telegram must be resolved from the same owner/conversation; web and CLI use the same authenticated local API identity.
