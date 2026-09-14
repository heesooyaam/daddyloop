[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Agent modules and models

An **engine** is an installed agent module. A **model** and its reasoning effort belong to that engine. daddy and workers can use independent profiles. The scheduler dispatches work through `AgentRuntime` / `SessionRuntime`; it does not interpret model names or speak a CLI's protocol.

The shipped agent modules are **Codex and Claude**. Both use the shared [module contract](../modules/en.md); daddy can coordinate a worker running a different engine. [Set up Claude](../claude/en.md).

```bash
daddy models --refresh
daddy agents defaults \
  --worker-engine codex --worker-model gpt-5.6-sol --worker-effort max \
  --daddy-engine codex --daddy-model gpt-6-astra --daddy-effort max
```

Use model IDs that your `daddy models` response actually offers. The names above are examples, not a product-maintained list. The Codex module reads `model/list` from the selected CLI, follows pagination and caches successful results for five minutes. Refresh requests it again. Effort values are taken from that response; new values are not filtered by a local list.

On the website open **Session settings**. Choose the module, model and effort for daddy and future workers. In the CLI or bot use `/models`; each choice carries its engine. Changing worker defaults affects future tasks. Changing daddy requires an idle session. Switching engines records previous context handles and starts a new native context; a Codex session is never passed into a different runtime.

## CLI versions

```bash
daddy updates --check
daddy runtime update --engine claude --yes
daddy runtime update --engine codex --yes
daddy runtime rollback --engine claude --yes
daddy runtime update-status
```

Open **Updates** on the website or `/updates` in Telegram. Each installed adapter has its own version, update and rollback controls. The CLI requires `--engine` when more than one CLI is installed. A module without a managed installer can report new releases, but the interface links to installation instructions instead of promising an update button.

Confirm the displayed old and new versions. The server downloads an official, checksum-verified artifact into a private immutable directory, validates the CLI and its model catalogue, then checks saved profiles for that engine. A failed validation preserves the selected version. Existing agent processes finish on their captured executable; subsequent turns use the new selection. Each completed operation produces one result message, without a duplicate version-change notice.

Codex and Claude Code support managed updates on Linux x64/ARM64 (Claude requires glibc). A service environment override makes its updater unavailable and explains which setting must change. Updating a CLI does not update daddyloop's adapter or SDK; an incompatible CLI is rejected during validation.

To select another executable on the service host:

```bash
daddy runtime use /absolute/path/to/claude --engine claude
daddy runtime use bundled --engine codex
```

`use` validates through the selected adapter, verifies ownership of the connected service, and restarts only when no jobs or updates are pending. `daddy doctor` diagnoses enabled agent adapters without a model turn. See [module development](../module-development/en.md) for the common lifecycle contract and [appearance and usage](../appearance/en.md) for quotas.

## Actual account quotas

`daddy limits --refresh` and the always-visible web strip combine enabled adapters. The Codex module calls `account/rateLimits/read`: it uses `rateLimitsByLimitId` and retains an additional base bucket when needed. It renders only returned windows, their `windowDurationMins`, `usedPercent`, `resetsAt`, provider label, plan and credits. A weekly-only account stays weekly-only. Model-specific buckets, including Spark when returned, are independent. There is no subscription-to-window table.

The available reset count comes from `availableCount`; missing detail rows do not imply zero credits. Reset requests still require confirmation and reuse an idempotency key. Claude usage follows its documented event capability; unknown and stale observations remain clearly marked. See the [official Codex protocol](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt) and [Claude limits](../claude/en.md).

A breaking CLI protocol change can make usage unavailable. The adapter reports the error and marks cached data stale; it does not infer a fresh percentage or offer a reset against stale data. Protocol updates belong in the adapter.
