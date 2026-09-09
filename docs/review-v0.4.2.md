# Review 0.4.2

Full self-review focused on formatting validity, data integrity and button authority. Telegram text uses explicit [message entities](https://core.telegram.org/bots/api#messageentity), with UTF-16 offsets. Titles and metadata are literal text. Markdown is converted from a syntax tree; HTML is never interpreted, structural code entities do not overlap styling, and inline links use validated HTTP(S) URLs without embedded credentials.

Long replies are split at grapheme and text boundaries. Entity spans are clipped to each part, code language is retained, and buttons appear only on the final part. Every rendered character is retained; only presentation is transformed. Original database messages and native comment Markdown are unchanged. A malformed or excessively nested Markdown input can fall back to literal display before any network request.

Buttons are processed only after private-chat and user binding checks. Task/status pagination is read-only. A publication button only creates the existing time-limited confirmation; publishing still checks the current generation, head, idle state and exact review snapshot. Confirmation IDs and navigation callbacks occupy separate namespaces. Completed cards distinguish waived, optional, failing and passing checks.

121 tests pass. New regressions cover emoji offsets, formatting around code, dense entity lists, long multipart answers, unsafe links, pagination, unknown-user callbacks and publication only after confirmation. Live Telegram responses confirmed bold, italic, code/preformatted and link entities for two explicitly labeled demo examples. Private chat IDs, bot credentials and preview message IDs remain in ignored local state.
