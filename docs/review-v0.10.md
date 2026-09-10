# Review: daddyloop 0.10

Full self-review of workspace terminology, group/session routing, voice ingestion and packaging. No independent review agent was used.

## Findings addressed

- **Group wizard cross-talk.** Creation drafts now bind owner, chat and topic. A choice from another topic cannot consume the draft. Listing workspaces leaves the current conversation active; returning to sessions cancels the wizard. A new session receives its own topic and a link from the original topic.
- **New tools on persistent native threads.** The installed Codex protocol accepts dynamic tools at thread creation. Coordination tool signatures therefore retain the previous native thread ID, start a refreshed context and expose saved history through `read_conversation`. Native review threads and application conversation IDs remain unchanged.
- **Unverified audio support.** Although the installed protocol declares audio inputs, both actual OGG and WAV probes returned that the recording could not be heard. Voice support uses verified local ASR instead of relying on that declaration. The bundled Small checkpoint improved the difficult Russian synthetic sample; a real Russian pronunciation and an English synthetic recording were recognized. Transcripts remain visible for correction.
- **Durability and ordering.** Incoming voice and conversation input are staged before update acknowledgment. Their captured session/workspace/generation cannot silently change during ASR. Following text waits behind the voice. The original receipt prevents repeated handoff after restart; commands such as pause remain independent.
- **Media bounds and resource lifetime.** Download origin/path/redirect/size checks precede decoding. Opus headers and incremental output guard channels and duration. One disposable, credential-free child uses two CPU threads, a bounded heap, resource monitoring and a timeout. Audio writes are atomic; processed files are cleaned without deleting unexpected directories. A failed queue acknowledgment does not cancel an already persisted input.
- **Dependency/release footprint.** Model revision, file sizes and SHA-256 digests are pinned. CUDA downloads are disabled and irrelevant ONNX runtime architectures are removed only from generated release staging. A compatible Sharp override resolves the new transitive advisories; the dependency audit is clean. Model attribution/license are included.

- **Explicit lifecycle.** A CI shutdown test exposed a recognition timer created during bot configuration. Voice processing now starts only with the bot and stops before storage closes; configuring an unstarted bot creates no background work.

## Validation

The normal suite covers voice ownership, ordered delivery, generation changes, duplicate input, restart, memory gating, size/path/redirect failures, group wizard scope, workspace endpoint aliases and natural-language session-tool idempotency. Browser/terminal tests exercise the renamed controls. A release smoke check loads the packaged speech backend and bundled CPU model on each release architecture. Ordinary tests use offline fixtures and do not write real PRs.

Sources: project instructions and `docs/architecture.md`; the generated Codex 0.154.0 schema and official app-server documentation; Telegram Bot API `getFile` / forum-topic documentation; the Transformers.js Node audio guide; the Opus decoder documentation; and the original/ONNX Whisper model cards.

## Limits

Voice input requires a selected session. It returns text, uses the chosen EN/RU language, and can misrecognize speech. A new session creates a new topic; more work for the same daddy stays in the existing topic. Group connection and CLI updates use the private control chat. Schema 5 requires the pre-upgrade database backup for a rollback to older server versions.
