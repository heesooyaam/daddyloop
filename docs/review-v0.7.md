# Review: daddyloop 0.7

Full self-review covers the new orchestration layer, project selection, writer scheduling, Telegram forums, CLI/browser clients, migration and packaging. This is a self-review; no independent review agent was used to assess the product changes.

## Findings addressed

- **Private review boundary.** A coordination context with draft-review history could relay unpublished findings through writer instructions. Coordination and native review now use separate persistent contexts under the same daddy profile. The coordinator's task views exclude private reviewer messages, draft bodies and reviewer summaries. Follow-up writer instructions for a PR require its current published review. Regression coverage checks both omitted data and rejected handoff.
- **Arcadia capacity.** Allocating every mount to writers could prevent daddy from reviewing those writers. Allocation is serialized and retains one control/review workspace. Eligible configured slots may be mounted automatically. Jobs wait for capacity rather than failing immediately. Clean author leases can be released after the exact commit is confirmed in the native PR; unsubmitted or dirty work is retained.
- **Checkout recovery.** The private context record is saved even when preparation fails. Release distinguishes an unchanged original checkout from an unexpected modification. Live Arcadia verification confirmed a separate source-preserving checkout, restoration of its original branch/hash and lease release.
- **Late task creation.** Pull-request attachment and ticket import carry the daddy generation through asynchronous provider reads. A paused/replaced session cannot receive a late task from an old coordination turn.
- **Duplicate requests and delivery.** Session creation and user messages have request identities. Scoped tool effects use the outbox. Topic creation records intent before the Telegram write; a lost response requires reconciliation or owner attachment instead of another creation. Managed Codex updates mark their corresponding observed version change so only the operation result is announced.
- **Project parsing.** HTTPS remotes must not be interpreted as SCP-style SSH addresses. Tests cover both forms, source preservation, Arcadia detection before Git, relative working directories and directory-root/symlink bounds.
- **Client races and persistence.** Late responses cannot replace another selected session. Drafts remain separate, uncertain message retries reuse the request ID, and a remounted client creates a fresh abort controller. Closing a CLI only tears down that client. Manual task controls carry the viewed head and generation.

## Validation

The original review/publication/workspace suites remain in place. Additional tests exercise daddy task creation and assignment, N+1 tickets, writer limits and draining, dependency cycles, scope isolation, direct-writer-chat rejection, Telegram room ownership and topics, message retries, model selection, project registration and GitLab submission recovery. Browser checks include the new desktop/mobile experience and existing native workflow history.

A live Codex smoke run used GPT-6 Astra for daddy and GPT-5.6 Sol for its writer. daddy created and dispatched one implementation task; the writer implemented an ESM function and tests in the managed copy. `node --test` passed and the source checkout remained unchanged. Submission was explicitly disabled in the isolated smoke fixture. This validates real orchestration and code production, not external PR publication.

A separate real Arcadia check used the configured lease helper and shared object store. It verified checkout/branch restoration and lease release without running an Arcadia build or touching the source checkout. Actual PTY captures verified the new CLI, menus, terminal restoration and an unchanged backend PID after CLI exit. Screenshots use the real interfaces with labeled illustrative data.

## Deliberate limits

Telegram Bot API requires the owner to create/select the forum group once. Group controls remain limited to the paired user. Ambiguous topic creation cannot be resolved by a provider topic-list API, so owner attachment is supported.

Dependencies order tasks; they do not automatically combine unmerged code branches. daddy is instructed to keep tightly coupled edits in one implementation task or plan integration explicitly. Native publication/revision gates and the absence of an automatic merge tool remain unchanged.

Codex is the implemented runtime. Claude stays diagnostic only. Existing data and native identifiers retain compatibility paths/markers; schema 4 requires the pre-upgrade database backup to restore a pre-0.7 server.

Sources reviewed: `docs/architecture.md`, `docs/research-daddyloop.md`, the installed Codex 0.154.0 app-server schema, the official Telegram forum/chat-picker API and GitLab merge-request API documentation.
