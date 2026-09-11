[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# daddyloop 0.13.0

- Claude module: real CLI/SDK execution, dynamic models/efforts, scoped MCP tools, resume and cancellation, API-key setup and optional CLI packaging.
- Usage belongs to agent adapters. Independent model buckets, weekly-only accounts, credit-only plans, unknown/stale readings and confirmed resets share one interface.
- Portable backups include saved workflow evidence, Git sources and working copies, plus Arcadia task exports. Restore verifies checksums, changes paths and pauses unfinished work.
- README uses Mint, shows Telegram prominently and speaks with daddy's voice. New paired guides cover Claude, backups and module development; laptop/phone connection instructions include diagrams.

Configuration 3 and SQLite 7 remain current. The usage API now returns `{ agents: [...] }`; update clients with the application. A backup of this format should be restored with the same application version. Native model generation still requires your own provider authentication.

## Earlier: 0.12.0

- Workers replace the writer name in the API, CLI, settings, pools and UI. No old-name aliases are retained.
- Eight web themes, including four dark themes, with a browser-local system-following preference.
- Codex usage windows and remaining resets stay visible below the header on desktop and phone.
- Agent and repository registries route work through explicit contracts. Installer module choices control integrations and optional CLI downloads.
- Documentation is paired by topic: `docs/<topic>/en.md` and `ru.md`, including a computer/phone website guide. Both root READMEs link to the same structure.
- daddy's interface copy uses a consistent direct, informal voice.

Breaking data format: config 3 / SQLite 7. Existing installations require an explicit backed-up conversion, including profile/pool field names, executable settings and engine-bound session handles. Application update and module changes restart the service; inspect and resume interrupted work. Browser login credentials and Telegram pairing can be preserved during conversion.
