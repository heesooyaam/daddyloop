# Review 0.4.0

Reviewed the ticket workflow, group scheduling, profile configuration, native submission, notification preferences, terminal and browser clients against the architecture and ADR 0004. This was a full self-review with regression tests, not an independent third-party review.

## Findings corrected

- Tracker issue comments use an `id` cursor; numbered pages were ignored by the real API. Added cursor-based retrieval, duplicate-page rejection and a 101-comment regression. Verified advancement against a real ticket with `perPage=1`. See [the official comment API](https://yandex.ru/support/tracker/ru/api/issues/get-comments).
- A child's conflicting reviewer must be rejected, and queued jobs must retain their recorded model/effort. The group owns the canonical profile and one reviewer thread; physical and persisted job guards serialize its use.
- Task publication and submission policy are saved atomically with import, before the first author job is queued.
- PR creation is recovered by operation identity, branch, repository and authenticated author. The task connects only to the submitted head; uncertain creation blocks a second implementation until reconciled.
- Git commit/push validates the managed directory, common repository, expected author branch and saved head. Dirty user source files are preserved. Arc ticket preparation retains locally advanced author commits.
- Native submission no longer blocks the worker's resource-check tick. Pending work is awaited during shutdown.
- Conversations after a failed submission retain its recovery state. Retry rechecks task state under the task lock.
- Terminal defaults use the selected profile, late settings responses cannot close a newer menu, and small layouts preserve selectable options. Model inputs have unique accessible labels.
- Quiet Telegram notices exclude intermediate replies; repeated identical milestones are deduplicated. Preferences are rechecked before delivery and can be changed from the paired bot.

## Validation

- Offline tests cover source parsing, exact Markdown, credentials by destination, comment pagination, profile packets on thread start/resume/turn start, concurrent authors and one reviewer, native-create ambiguity, source preservation and a complete ticket → discussion → implementation → PR → automatic publication cycle.
- Browser tests cover the existing manual demo, ticket creation with role profiles, child inheritance, notification preferences on a phone, and persistent HTTPS access after the laptop browser closes.
- Real PTY capture checks multiline input, paste, role drafts, model/notification screens, resize and terminal restoration on Ctrl+Q and SIGHUP. The backend PID remains unchanged when clients exit.
- Read-only live import succeeded for a GitHub issue and a Tracker ticket with comments. Internal identifiers/content are excluded from repository artifacts.
- Two small live Codex calls used GPT-5.6-Sol/max and GPT-6-Astra/max, including a dynamic-tool response and persistent thread resume.
- Host checks during development: about 180 GiB disk free and 82 GiB available RAM; no cleanup trigger reached.

## Limits

The complete native write path uses controlled HTTP/workspace fixtures; no real production PR was created for this test. Arc command flags were verified against the installed CLI, but live Arc commit/push/publication remains untested. Actual Telegram delivery requires an owner-provided bot token. Groups do not merge child branches or infer dependency order. Codex is the only implemented engine.
