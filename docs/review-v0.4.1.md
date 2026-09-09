# Review 0.4.1

The reported `fetch failed` was reproduced in Telegram service initialization. The supplied token then passed real `getMe` and webhook checks; restarting the service restored the connection. The original failed request's nested network cause was not recorded, so its exact DNS/socket/TLS origin is unknown.

Full self-review focused on recovery and external side effects. Read retries are restricted to getMe/getWebhookInfo/getUpdates. Messages, callbacks and other writes are issued once because a lost response does not prove delivery failed. Startup recovery is independent of the HTTP server, backs off, and is cancelled on shutdown. Invalid credentials and redirects do not trigger that recovery loop. Raw credential-bearing URLs are excluded from network diagnostics. Polling and outgoing-delivery errors have separate persistence so successful polling cannot hide an uncertain send.

112 offline tests pass, including a real server lifecycle test with a failed Telegram factory followed by recovery, shutdown during backoff, read retry limits, explicit API failures and no duplicate write after a transport error. Account checks were performed live on the development host; the bot token and private chat identifiers are excluded from repository artifacts.
