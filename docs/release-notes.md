# Reviewloop 0.4.3

Telegram now presents task cards, formatted author/reviewer replies and inline navigation. This release includes the 0.4.2 presentation changes and two final review corrections:

- Native GitHub/GitLab correlation comments are hidden from rendered summaries; original database/native Markdown and literal code examples are preserved.
- Error cards ask the user to check the result instead of claiming the operation failed when only its confirmation may have been lost.

Bold/italic text, lists, links, code language and long-message formatting are preserved. Task pagination, status and notification buttons work only in the paired private chat; publication still requires the existing fresh confirmation.

Validation: 123 tests, production build and live Telegram acceptance of formatted demo messages. Pairing, task data, policies and notification preferences are preserved.
