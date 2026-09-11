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

A PR should explain the user-visible change, relevant validation and limitations. For a module, test the common contract and its protocol adapter; see [modules](../modules/en.md). Preserve exact native Markdown, revisions, generations and ambiguous-operation recovery.

## Documentation is paired

Every topic belongs at `docs/<topic>/en.md` and `docs/<topic>/ru.md`. Update both in the same PR. The docs check rejects missing language pairs and broken local links. Update the corresponding index links and both root READMEs when navigation or onboarding changes.

Legal license originals are retained in `docs/licenses/`; explanatory pages still have both languages. Screenshots live in `docs/media/` and are referenced from the paired guides. Keep user data, credentials and private bot chats out of published media.

## Reproduce the visuals

After a production build, run `node scripts/capture-daddy.mjs`. It drives the real browser and terminal clients against an isolated fixture. It checks terminal restoration and verifies that disconnecting the client does not stop the fixture service. See [media](../media-guide/en.md).
