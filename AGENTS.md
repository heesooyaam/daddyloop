# daddyloop development

This project is a standalone Git repository. It is unrelated to the machine's Arcadia working copies.

- Read `docs/architecture.md` before changing workflow behavior. Later product decisions in that document supersede early design sketches.
- Keep native comment Markdown intact. The reviewer writes comments through scoped tools; the author receives the published snapshot, not draft chat.
- Bind review results, policy decisions and CI to the exact revision and run generation. Never replace incomplete work with a successful state during recovery.
- Preserve existing local author changes and normal non-force push semantics. Keep side-effect intent and confirmed result separate.
- Credentials and `.reviewloop/` state must never enter commits. Search `~/.tokens/` filenames before concluding that machine credentials are unavailable; never print token contents.
- Default local development: `npm run check`. Meaningful workflow, transport, provider and persistence regressions belong in `tests/`. Browser tests: `npm run test:e2e` after a production build.
- `scripts/smoke-codex.ts` is opt-in and makes two live model calls. Ordinary tests are offline and must not write to real PRs.
- The installed Codex app-server schema used for the first version is `0.153.4`. Validate protocol changes against the installed CLI and official documentation.
- Follow the user's host resource rules. Never delete another project's worktrees, caches, runtime files or services to make this project fit.
