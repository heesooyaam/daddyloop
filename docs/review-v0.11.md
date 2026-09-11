# Review: current daddy contracts

Reviewed the CLI and installer, public routes, Telegram dispatch and confirmation ownership, workspace snapshots, model profile selection, persistent writer slots, data version guards, build contents and browser authentication. This is an intentional breaking release: preserving previous interfaces is out of scope.

Resolved during review:

- Incremental TypeScript builds retained deleted client files. The production build now clears its generated output before compilation, so releases contain only current modules.
- Models must still bind a native author job to the writer profile and a review job to daddy. Both enqueue-time and runtime selection now use the current profile keys; native provider authorship fields remain unchanged.
- Source defaults and writer-slot ownership must come from saved current records, not reconstruction of pre-snapshot sessions. Resizing still drains the whole task, including review and CI.
- Converted data must not be read through old aliases or guessed directory locations. Config 2 and SQLite 6 are explicit; older or unversioned nonempty databases fail before mutation.
- The phone pairing and locale-before-login tests now exercise the only dashboard. A screenshot inspection caught the remaining workspace menu translation and corrected it.

Validation: 179 offline tests, 8 browser scenarios, and actual Ink/PTY captures with restored terminal modes and an unchanged service PID. Release packaging additionally checks the actual bundled speech recognizer and installer on Linux x64 and ARM64.

The host conversion is a private, one-time operational script, not a runtime migration layer. Its rehearsal preserves the four saved tasks, both workspaces, Telegram pairing/group, credentials and separate model choices. Original requirements, messages and published native Markdown are preserved. Earlier browser cookies must be replaced by signing in again.

No unresolved blocking findings from this review. Reviewed against the architecture and operations documents and the machine's ownership/resource constraints.
