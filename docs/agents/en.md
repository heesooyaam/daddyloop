[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Agent modules and models

An **engine** is an installed agent module. A **model** and its reasoning effort belong to that engine. daddy and workers can use independent profiles. The scheduler dispatches work through `AgentRuntime` / `SessionRuntime`; it does not interpret model names or speak a CLI's protocol.

The working agent module currently shipped is **Codex**. A Claude adapter is not shipped. The shared [module contract](../modules/en.md) allows another engine to be added without implementing a second orchestration loop.

```bash
daddy models --refresh
daddy agents defaults \
  --worker-engine codex --worker-model gpt-5.6-sol --worker-effort max \
  --daddy-engine codex --daddy-model gpt-6-astra --daddy-effort max
```

Use model IDs that your `daddy models` response actually offers. The names above are examples, not a product-maintained list. The Codex module reads `model/list` from the selected CLI, follows pagination and caches successful results for five minutes. Refresh requests it again. Unsupported delegation mode is excluded.

On the website open **Session settings**. Choose the module, model and effort for daddy and future workers. In the CLI or bot use `/models`; each choice carries its engine. Changing worker defaults affects future tasks. Changing daddy requires an idle session. Switching engines records previous context handles and starts a new native context; a Codex session is never passed into a different runtime.

## CLI versions

```bash
daddy updates --check
daddy runtime update --yes
daddy runtime rollback --yes
```

In Telegram use `/updates`. A confirmed update pins a version and verifies its artifact, CLI protocol and saved Codex profiles. Existing agent processes keep their captured executable; the next turn uses the new selection. One completion notice is sent. A lost response is reconciled before another operation is allowed.

To select a host-installed Codex CLI use `daddy runtime use /absolute/path/to/codex`; this validates the CLI and restarts an idle service. `daddy runtime use bundled` selects the installed Codex module. These management commands are Codex-specific capabilities, separate from generic agent dispatch.

See [appearance and usage](../appearance/en.md) for account quotas and confirmed resets.
