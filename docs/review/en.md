[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Review of 0.12

Review scope: worker naming, module dispatch and disabled-module boundaries, engine-bound contexts, native submission recovery, installer component selection/immutability, themed states, always-visible quota freshness, and bilingual documentation.

The review preserves exact-revision/generation checks, native Markdown, published-only worker input, asynchronous pool draining and confirmed idempotent quota resets. Module-specific writes remain inside the common durable outbox. Theme changes remain browser-local and do not mutate workflow state.

Validation targets are offline workflow/transport/module tests, browser flows for theme selection and usage, current screenshots, documentation link/pair checks, and packaged installer/speech checks on Linux x64 and ARM64. Final results are recorded with the release and CI runs.

Validated: 185 offline tests, 11 browser scenarios, paired documentation/link checks, real bilingual web/CLI captures, the actual checkbox picker, and local package installation with selective downloads and immutable variants. Review fixed module initialization order, theme controls overlapping language selection, and stale quota handling after disconnect. The host conversion rehearsal preserves saved work, both workspaces, separate profiles and Telegram binding.
