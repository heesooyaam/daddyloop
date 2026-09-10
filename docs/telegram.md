# Telegram group

daddyloop supports a private control chat and a forum group with one topic per daddy session. Work messages go to daddy; writer reports are collected by him instead of becoming separate conversations.

## Connect

```bash
daddy telegram setup
```

Create a dedicated bot with BotFather, provide its token and follow the pairing link. Only the paired private user can issue commands. The token is kept in a private local file.

In the private chat, send `/group` (the old `/workspace` command remains an alias). Create a group in Telegram, enable Topics and choose it using the bot's chat picker. The bot needs administrator status with `can_manage_topics`. The picker and subsequent membership checks verify the group and permissions.

The [Bot API](https://core.telegram.org/bots/api#keyboardbuttonrequestchat) provides a user-driven group selector, not a method for creating a group on the user's behalf. Once the group is connected, daddyloop creates [session topics](https://core.telegram.org/bots/api#createforumtopic) itself.

## Daily use

- `/new [goal]`: choose a workspace and create a daddy session from the private chat or a linked group topic. A new session gets a new topic.
- `/sessions`: open an existing session/topic.
- `/workspaces`: choose or register a detected repository on the server.
- `/group`: connect the forum group from the private chat.
- `/status`: show the current session's task board.
- `/pool` or `/pool 3`: inspect or change the simultaneous writer limit.
- `/models`: select the model and reasoning effort for daddy or new writers.
- `/pause` and `/resume`: control the current daddy session.
- `/updates`: Codex version checks, confirmed installation and rollback in the private control chat.
- `/notifications`: choose notification preferences in the private control chat.
- `/language en` / `/language ru`: change the interface language.

Inside a linked topic, plain text goes to that topic's daddy session. Paste a GitHub issue, a Tracker key, an existing PR/MR, several links or a description. New work joins the same session and writer pool.

Replies to user messages are delivered to the session. Automatic messages follow notification preferences; the default focuses on necessary input and completed work. Raw writer messages are not forwarded. A managed Codex update has one completion notice; its observed version change does not create another equivalent notice.

## Delivery and recovery

Telegram commands and callbacks are checked against the paired user, linked room and topic. An action from a different topic cannot change another session's pool or state. Replies are sent using `message_thread_id`.

Creating a topic has no provider idempotency key or reliable topic-list lookup. daddyloop records an intent first. If the response is lost, it does not blindly create another topic. Open the existing topic and send `/attach SESSION_ID` to bind it explicitly; the owner and room are verified again.

Message delivery records intent and confirmed success separately. A lost `sendMessage` response stays uncertain rather than triggering duplicate sends. Existing session history and task state remain available on the website and CLI.

The server polls Telegram independently of the laptop. Startup retries transient connection failures while keeping the website available. Revoking the bot's group permissions or removing it requires restoring those permissions before topic operations can continue.

## Voice notes

An existing session accepts Telegram OGG/Opus voice notes, up to 5 minutes and 10 MB. Recognition is local, using the bundled Whisper Small model. `/language ru` or `/language en` selects both interface and recognition language. The transcript is shown and routed to the captured session/workspace; daddy replies with text. Voice input requires an already selected session.

The durable inbox keeps voice and following conversation text ordered. One disposable CPU process handles recognition with two inference threads and a timeout; completed audio files are removed. Control commands are processed independently. Restart resumes queued recognition; the original Telegram receipt prevents a second task handoff. A changed owner, topic binding or session generation rejects an outdated handoff.

`/new` works inside a group topic and returns the link to a new topic. Plain-language requests can use daddy's scoped `create_session` tool. Global CLI updates still live in the private bot chat; `/updates` in a group provides a link there. `/group` also remains private because Telegram's chat picker requires it.
