[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Agents, models and limits

Choose Codex or Claude independently for daddy and workers. An **engine** is the installed agent module; its **model** and reasoning **effort** control a turn. Select the modules during [installation](../start/en.md#modules).

## Connect an account

Run authentication commands on the service host.

### Codex

```bash
daddy auth agent codex
```

Complete the device login, then run `daddy models --refresh` to see the account's catalogue.

### Claude

```bash
daddy auth agent claude
# Or use an existing private API-key file:
daddy auth agent claude --token-file /private/anthropic-key
```

The hidden prompt saves the key to `~/.tokens/anthropic`. `ANTHROPIC_API_KEY` in the service environment takes precedence; `DADDYLOOP_CLAUDE_API_KEY_FILE` selects another private file. API access is billed separately from a Claude Pro/Max subscription. This integration uses the [official Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

Claude command execution requires Bubblewrap and socat, installed on supported apt-based hosts when you select the module. The host must allow user namespaces. Workers can edit their working copies; coordination and review are read-only. If the sandbox is unavailable, execution stops with an error.

## Choose models

On the website open **Session settings**; in the CLI or Telegram use `/models`. Choose an engine, model and effort separately for daddy and workers. CLI defaults can also be set explicitly:

```bash
daddy models --refresh
daddy agents defaults \
  --worker-engine codex --worker-model gpt-5.6-sol --worker-effort max \
  --daddy-engine codex --daddy-model gpt-6-astra --daddy-effort max
```

The model names above are examples. Use IDs returned by your CLI. Codex reads `model/list`; Claude reads `supportedModels()`, including returned aliases and effort levels. Results are cached for five minutes; Refresh queries again. The provider checks model access when a turn runs.

Worker defaults affect future tasks. Changing daddy requires an idle session. Switching engines starts a fresh native context while preserving the daddyloop conversation. Queued turns keep their saved profiles. See [tasks and pools](../tasks/en.md) and the [adapter contract](../module-development/en.md).

## Update a CLI

Open **CLI updates** on the website or `/updates` in Telegram. Each installed engine has its own update and rollback controls:

```bash
daddy updates --check
daddy runtime update --engine claude --yes
daddy runtime update --engine codex --yes
daddy runtime rollback --engine claude --yes
daddy runtime update-status
```

Confirm the displayed versions. daddy verifies the official package checksum, CLI/catalogue compatibility and saved profiles, including queued turns, before switching. Failed validation preserves the selected CLI. Running agents finish on their captured version; subsequent turns use the new one. The bot sends one completion notice per operation.

Managed updates support Linux x64/ARM64; Claude requires glibc. An environment override disables switching and names the setting to change. Modules without an installer link to release instructions. Updating a CLI does not update daddyloop's adapter or SDK.

To choose another installed executable on the service host, use `daddy runtime use /absolute/path/to/claude --engine claude`, or `daddy runtime use bundled --engine codex`. This validates the CLI and restarts the service when jobs and updates are idle. [Service updates](../operations/en.md) are separate.

## Limits

The strip above the conversation shows each agent's quotas on desktop and phone. Click the provider or a period card for details and refresh. Unknown or stale readings are labelled. Additional credits are a separate payment balance; zero credits do not mean the included quota is exhausted. Zero balances stay in details unless credits are the only reported allowance.

- **Codex:** reads account quotas from the selected CLI, cached for one minute. Returned windows, reset times, plan and extra model buckets are preserved. A weekly-only plan shows only a week; Spark or other model quotas appear separately when reported. Agents using the same account share its quota.
- **Claude:** displays provider `rate_limit_event` observations, stale after two minutes. Refresh cannot fetch an unsupported account-quota endpoint. Last-turn tokens and estimated API cost are activity data, not an account balance. Missing quota data remains unknown. This adapter does not expose a quota reset.

```bash
daddy limits --refresh
daddy limits reset
daddy limits reset --request REQUEST_ID --yes
```

Preparing a reset does not spend it. Confirm the displayed request to consume one; retries reuse its ID. Conversations and files remain in place. daddy does not buy credits or consume resets automatically. The available reset count comes from the provider, not a subscription table.

## Troubleshooting

Run `daddy doctor` for enabled-adapter diagnostics without a model turn. For authentication failures, check the account/key on the host; for an empty catalogue, run `daddy models --refresh`. A CLI protocol or sandbox error leaves work unfinished. Inspect the error, fix the cause and resume; use rollback after an incompatible CLI update.
