# Reviewloop 0.4.1

Telegram setup and service startup recover from temporary network failures instead of leaving the bot disconnected after a generic `TypeError: fetch failed`.

- Bounded retries for safe Bot API reads; startup reconnects in the background with backoff and cancels promptly during shutdown.
- Network diagnostics include DNS/socket/TLS codes without exposing credential-bearing request URLs. Redirects and malformed responses produce explicit errors.
- Pairing reports that configuration is saved while Telegram is connecting. Polling errors clear after recovery.
- Outgoing messages are never retried automatically after a lost response, preserving the existing duplicate-delivery protection.
- Corrected the ansi-tokenize lockfile version metadata to match its existing pinned archive; its payload and checksum remain unchanged.

Validation: 112 tests, including connection recovery with the website available, cancellation, invalid credentials, redirects and uncertain outgoing delivery. Existing task data, model profiles, policies and bot pairing are preserved.
