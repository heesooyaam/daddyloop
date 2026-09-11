[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Bring Claude into the crew

Select `claude` in the installer. It installs a separate Claude Code CLI component; the core includes the official Agent SDK transport. Linux command execution requires Bubblewrap and socat, which the installer installs on supported apt-based hosts. There is no fallback to unrestricted shell execution when the sandbox is unavailable.

## Connect the account

On the service host:

```bash
daddy auth agent claude
# Or read a key you have already saved privately:
daddy auth agent claude --token-file /private/anthropic-key
daddy models --refresh
```

The hidden prompt saves an Anthropic API key to `~/.tokens/anthropic` with private permissions. `ANTHROPIC_API_KEY` in the service environment takes precedence; `DADDYLOOP_CLAUDE_API_KEY_FILE` can select a different private file. The key stays on the host and is excluded from command environments inside the agent sandbox.

This integration uses the [official Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Its documented application authentication is API-based. A Claude Pro/Max subscription is not an API balance; daddyloop does not offer a subscription-login shortcut.

## Choose the role and model

Open **Session settings → Models** on the website, or `/models` in the CLI or Telegram. Choose **Claude** for daddy, workers, or both. You can mix engines, for example Codex for daddy and Claude for workers.

The catalogue comes from the installed CLI through `supportedModels()`. Model IDs, including aliases such as `sonnet[1m]` when returned, and supported effort levels are passed through. Successful results are cached for five minutes; Refresh reads them again. Model examples are not a promise of account entitlement: the provider checks access when a turn runs.

Changing worker defaults affects new tasks. Changing daddy's engine requires an idle session and starts a new native context. Existing daddyloop conversations and task records remain available.

## Execution and limits

Claude receives a managed working directory, role policy and scoped daddyloop tools through an in-process MCP server. It returns the same structured result as Codex. Session IDs are saved and resumed by the Claude adapter. Cancellation closes the query; a missing, failed or malformed result does not advance the workflow.

Workers can edit their own working copy. Review and coordination turns are read-only. Native subagents and arbitrary MCP connections are excluded; daddy assigns work through the shared worker interface. Native review publication still passes through daddyloop's revision and ownership checks.

Usage comes from CLI `rate_limit_event` observations, when provided. The adapter preserves the provider's bucket names, reset timestamps and utilization. No event or missing percentage means **unknown**, not 100% remaining. Observations become stale after two minutes; Refresh cannot force Claude to provide an unsupported account-quota endpoint. Per-turn model usage and estimated API cost are retained in runtime events. The usage panel also shows input/output tokens and the estimated cost of the last reported agent turn; this is not the account balance. Claude does not expose a quota-reset action through this adapter.

## Versions and troubleshooting

The release pairs SDK `0.3.268` with Claude CLI `2.1.268`. The selected executable is captured per turn. `daddy updates --check` reports CLI version changes and available releases. Managed update/rollback buttons currently update Codex; update bundled Claude by installing a newer daddyloop release, or select a tested host executable through `executables.claude` in the configuration and restart while idle.

- **Authentication failed:** check the API key on the service host and API account billing.
- **No models:** run `daddy models --refresh`; inspect CLI errors without posting keys or token files.
- **Sandbox unavailable:** install Bubblewrap and socat, and ensure the host permits user namespaces. Do not enable a permissions bypass.
- **Invalid result / turn limit:** the task stays unfinished; inspect its saved events and resume after correcting the cause.

See [agent profiles](../agents/en.md), [module development](../module-development/en.md) and [portable backups](../backups/en.md).

For an explicit live check from a source checkout, run `DADDYLOOP_LIVE_CLAUDE_TEST=1 npx tsx scripts/smoke-claude.ts` after authentication and sandbox setup. It makes two paid API calls in a temporary folder, checks file creation, native resume and MCP dispatch, and sets an SDK budget of $0.25 per call. Ordinary tests do not run it.
