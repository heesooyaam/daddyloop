[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Contributing

Use Node 24 (see `.nvmrc`) and an isolated checkout. The repository's `AGENTS.md` defines workflow invariants and resource rules.

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npm run check
npm run format:check
npx playwright install chromium
npm run test:e2e
```

`check` type-checks, runs offline tests, builds from clean generated output, and checks documentation. Browser fixtures use their own server, database, repositories and account data. Do not turn an ordinary test into a paid model call or a real PR write. The opt-in `scripts/smoke-codex.ts` performs live model calls and must be run deliberately.

A PR should explain the user-visible change, relevant validation and limitations. For a module, test the common contract and its protocol adapter; see [modules](../module-development/en.md). Preserve exact native Markdown, revisions, generations and ambiguous-operation recovery.

## Documentation is paired

Write briefly, using familiar words. Start with the overall picture and one concrete example; put deeper details in optional sections. Explain a technical term before using it, and link to code instead of listing every internal field.

Every topic belongs at `docs/<topic>/en.md` and `docs/<topic>/ru.md`. Update both in the same PR. The docs check rejects missing language pairs, broken local links, guides missing from the index and unreferenced images. Update the corresponding index links and both root READMEs when navigation or onboarding changes.

Legal license originals are retained in `docs/licenses/`; explanatory pages still have both languages. Screenshots live in `docs/media/` and are referenced from the paired guides. Keep user data, credentials and private bot chats out of published media.

## Reproduce the visuals

After building, capture both languages:

```bash
DADDYLOOP_MEDIA_LOCALE=en node scripts/capture-daddy.mjs
DADDYLOOP_MEDIA_LOCALE=ru node scripts/capture-daddy.mjs
node scripts/capture-telegram.mjs
```

The browser and Ink CLI run against isolated fixtures with illustrative tasks, models and quotas. The capture checks terminal restoration and service survival after disconnect; phone scenes use 390 × 844. Only images referenced by the guides or READMEs are copied into `docs/media/`; other verification captures stay temporary. The README's main image uses Mint. Telegram cards are rendered locally without contacting Telegram.

Refresh affected screenshots when UI text, layout or colors change. Never publish tokens, private conversations or corporate task contents.

## Live agent checks

`scripts/smoke-codex.ts` and `scripts/smoke-claude.ts` are opt-in and make paid model calls. For Claude, after authentication and sandbox setup, run `DADDYLOOP_LIVE_CLAUDE_TEST=1 npx tsx scripts/smoke-claude.ts`. It checks file creation, native resume and MCP dispatch in a temporary folder, with two calls budgeted at $0.25 each. Ordinary tests stay offline.

## Release history

Keep guides about current behavior. PRs hold change-specific reviews and validation; [GitHub Releases](https://github.com/heesooyaam/daddyloop/releases) hold version history. The release workflow generates notes from merged PRs; no release diary is maintained in `docs/`.
