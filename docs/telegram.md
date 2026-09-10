# Telegram workspace

Daddyloop supports a private control chat and a forum group with one topic per Daddy session. Work messages go to Daddy; writer reports are collected by him instead of becoming separate conversations.

## Connect

```bash
daddy telegram setup
```

Create a dedicated bot with BotFather, provide its token and follow the pairing link. Only the paired private user can issue commands. The token is kept in a private local file.

In the private chat, send `/workspace`. Create a group in Telegram, enable Topics and choose it using the bot's chat picker. The bot needs administrator status with `can_manage_topics`. The picker and subsequent membership checks verify the group and permissions.

The [Bot API](https://core.telegram.org/bots/api#keyboardbuttonrequestchat) provides a user-driven group selector, not a method for creating a group on the user's behalf. Once the group is connected, Daddyloop creates [session topics](https://core.telegram.org/bots/api#createforumtopic) itself.

## Daily use

- `/new`: choose a registered project and start a Daddy session.
- `/sessions`: open an existing session/topic.
- `/projects`: choose or register a detected repository on the server.
- `/workspace`: connect the forum group from the private chat.
- `/status`: show the current session's task board.
- `/pool` or `/pool 3`: inspect or change the simultaneous writer limit.
- `/models`: select the model and reasoning effort for Daddy or new writers.
- `/pause` and `/resume`: control the current Daddy session.
- `/updates`: Codex version checks, confirmed installation and rollback in the private control chat.
- `/notifications`: choose notification preferences in the private control chat.
- `/language en` / `/language ru`: change the interface language.

Inside a linked topic, plain text goes to that topic's Daddy session. Paste a GitHub issue, a Tracker key, an existing PR/MR, several links or a description. New work joins the same session and writer pool.

Replies to user messages are delivered to the session. Automatic messages follow notification preferences; the default focuses on necessary input and completed work. Raw writer messages are not forwarded. A managed Codex update has one completion notice; its observed version change does not create another equivalent notice.

## Delivery and recovery

Telegram commands and callbacks are checked against the paired user, linked room and topic. An action from a different topic cannot change another session's pool or state. Replies are sent using `message_thread_id`.

Creating a topic has no provider idempotency key or reliable topic-list lookup. Daddyloop records an intent first. If the response is lost, it does not blindly create another topic. Open the existing topic and send `/attach SESSION_ID` to bind it explicitly; the owner and room are verified again.

Message delivery records intent and confirmed success separately. A lost `sendMessage` response stays uncertain rather than triggering duplicate sends. Existing session history and task state remain available on the website and CLI.

The server polls Telegram independently of the laptop. Startup retries transient connection failures while keeping the website available. Revoking the bot's group permissions or removing it requires restoring those permissions before topic operations can continue.
