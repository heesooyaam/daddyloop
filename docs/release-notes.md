# Reviewloop 0.4.2

Telegram messages now use native formatting and task cards instead of raw state names and unformatted text.

- Clear Russian status headings, task titles, result summaries, review/check facts and copyable task IDs.
- Author/reviewer Markdown renders as bold/italic text, lists, links and code blocks. Long answers retain formatting across messages without truncation or broken emoji.
- Task list pagination and inline navigation, notification preferences and links to native reviews or the configured website.
- The publication button opens a fresh confirmation; existing revision, author and snapshot checks are preserved.
- Network recovery and protection against duplicate outgoing writes remain in place.

Validation: 121 tests, including entity offsets, chunk preservation, safe links, private-user callback authorization and the two-stage publication gate. Two presentation examples were accepted by the real Telegram API with their native formatting entities. Existing accounts, pairing, task data and notification preferences are preserved.
