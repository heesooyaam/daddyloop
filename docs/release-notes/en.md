[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# daddyloop 0.14.1

The sidebar logo is plain branding instead of a link that does nothing. The sidebar tagline and home-page prompt use simpler English/Russian copy, with refreshed screenshots including the empty home page. Addresses items 8–10 in [issue #19](https://github.com/heesooyaam/daddyloop/issues/19).

Configuration 3 and SQLite 7 are unchanged. Reload open web pages after upgrading.

## 0.14.0

- The dashboard separates task intake from clearly labelled, clickable provider quotas. Credit balances have their own explanation; zero extra credits no longer clutter percentage windows.
- Workspace cards separate names, VCS labels and source paths. One folder browser distinguishes navigation from selection and protects pending requests.
- New sessions start with the goal. Repository overrides are optional, validated before application, and explicitly scoped to a session or the next message. Adding a workspace preserves the task draft.
- English/Russian guides and screenshots follow the new flow. Fixes [issue #19](https://github.com/heesooyaam/daddyloop/issues/19).

Configuration 3 and SQLite 7 are unchanged. Reload open web pages after upgrading.

## 0.13.1

Refines the Russian idle-chat prompt to natural wording.

## 0.13.0

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
