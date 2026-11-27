[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Telegram: private chat and forum topics

When daddy or a worker asks for a decision, the bot sends a new message with a mention of the paired owner and the question. It uses the session topic or the paired private chat. A plan awaiting approval also alerts the owner. Attention and All notifications include these mentions. Ordinary progress updates stay silent. A private draft that requires the owner’s inspection includes a link to its PR. On restart, outstanding worker questions are recovered from the saved agent result when it still matches the current task.

In session settings, the All workers profile applies to every slot, including slots with individual profiles. A running worker turn finishes on its current model and the next turn uses the new profile. Choose Apply now to restart the active daddy turn or review on the new model. In Telegram, open /models to access these controls.

Replying in a topic sends the original message and the selected quotation to daddy with your question. You can reply to an older worker question after the conversation has moved on. A voice reply keeps the same context during transcription.

While an owner decision remains open, the bot repeats the mention 30 minutes after the previous delivery. Resolution, pausing and disabled notifications stop reminders. After downtime only one overdue reminder is sent.

## Connect the bot

1. Create a dedicated bot with **@BotFather** and copy its token.
2. On the service host run `daddy telegram setup`, then paste the token into the hidden prompt. You can supply `--token-file /private/path` instead.
3. Open the one-use pairing link it prints and press **Start**. The bot binds to your Telegram user.

```bash
daddy telegram status
daddy telegram pair       # issue a new pairing link
daddy telegram unpair    # revoke the binding
```

The bot token belongs to this service installation. A dedicated bot must not simultaneously use another webhook/poller. Only the paired user can control work.

## Work from the chat

In the private chat, choose **New task** or open a conversation from the list. The bot shows which conversation receives your next message. A regular message or issue link goes to daddy. Use `/task` to put a specific description straight into the worker queue. **Settings** in the private chat opens repositories, group setup, notifications and updates.

The bot adds 👀 to an accepted message after saving the request. The reaction is queued and retried after temporary failures. In a topic, it depends on the group's settings. The status card shows the current stage.

The bot keeps an editable status card pinned in the session topic, with the current phase at the top and unfinished task IDs below it. The card updates when the phase changes and roughly once a minute during work. It shows elapsed time and the latest agent activity. When there is no group, the bot posts progress in the selected private conversation. Send `/status` for the current status.

## A topic per daddy session

Create a Telegram **supergroup with Topics enabled**, add the bot as administrator, and grant **Manage Topics** and **Pin Messages**. In the private bot chat send `/group` and select the group using Telegram's picker. The service verifies your membership and the bot's rights. Telegram requires you to create or join the group yourself.

Each daddy session gets a topic. Send goals and tickets there. Workers report to daddy. `/new Another job` inside a topic starts a separate session and topic. If topic creation had an uncertain result, follow the bot's `/attach` instructions.

## Tasks and workers

- `/task Fix search filters` creates and queues a task in the current session. The bot returns a short ID such as `DADDY-12ab34cd`.
- `/task --no-plan -- Fix search` skips the default architecture check for this task. A regular message can ask daddy to discuss the plan and record it in the issue before dispatch.
- Use `/models` → **Architect** to change the session default. To override only the current task, use its **Architect** button or queue it with `/task --architect-model MODEL --architect-effort high -- Fix search`. Add `--architect-engine ENGINE` to select a different engine.
- `/task DADDY-12ab34cd` shows the task’s current stage, assigned worker and PR when available.
- `/queue` lists unfinished tasks with their status and worker assignment. The queue shows how long ago work began and, during an active run, who is running it and for how long. Use the task's ID button to open its details. The queue button takes you back to the page you opened the task from. `/workers` shows the numbered workers, their models and assigned work.
- `/task --worker 2 --model MODEL --effort EFFORT -- Fix search filters` waits for worker 2 and uses the requested profile. The options are independent. A model request without a worker number prefers a free worker with that profile and reconfigures the first free worker if needed.
- `/worker 2 MODEL EFFORT` sets worker 2’s profile for its next task. Add `--force` to resume an active author run with the new profile in the same working copy. A run that is already saving a result finishes that step first. Add `--engine ENGINE` with a model when switching agent engines. Use `/models` to find available models and reasoning levels.

## Commands

Send `/help` in the private chat or a group topic to see available commands and descriptions. Use `/help task` or `/help /worker` for syntax and options. In groups, `/help@your_bot task` also works. Telegram suggests commands for the current chat type when you type `/`. Russian Telegram clients receive Russian menu descriptions. Use `/language` to select the language for bot replies.

| Where                                     | Commands                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private chat and connected session topics | `/new`, `/sessions`, `/workspaces`, `/task`, `/queue`, `/workers`, `/worker`, `/status`, `/pool`, `/models`, `/instructions`, `/skill`, `/presets`, `/preset`, `/repo`, `/limits`, `/pause`, `/resume`, `/notifications`, `/language en`, `/language ru`, `/help` |
| Private chat                              | `/group`, `/updates`, `/web`, `/cleanup`                                                                                                                                                                                                                          |

In the paired private bot chat, `/cleanup` opens the disk cleanup schedule. Enable cleanup and check its threshold, skill and most recent result here. See [operations](../operations/en.md) for the settings.

`/web` creates a browser login link after [permanent HTTPS access](../web/en.md) is configured. CLI updates and account confirmations stay in the private chat. Work continues when the phone and laptop are offline.

Send `/notifications` to choose quiet completion/decision notices, all updates, or mute. Voice messages follow the same session routing; see [voice](../voice/en.md).

Open **Settings → Instructions for this session** from the session card. `/instructions daddy <text>` and `/instructions worker <text>` set separate prompts. `/skill <role> <GitHub URL>` adds a skill. These commands work in private conversations and their group topics. [Task instructions](../instructions/en.md)

`/presets` lists shared presets. `/preset <name>` enables one for the selected conversation/topic. Other sessions keep their choices. Individual parts are selected in the website’s session settings.

After a successful callback-button action sends a replacement message, the bot deletes the clicked card. Failed actions keep the old card for retry; messages in another topic do not remove it. Link buttons open their URL directly and do not notify the bot of a click.

Session preparation updates one card: “Preparing the session copy” changes to “Session copy ready” in place. A failed preparation uses the same card. Delivery retries and service restarts preserve its Telegram message ID. If the card was deleted through navigation, the bot creates a replacement only after Telegram confirms that it no longer exists.

For Arcadia, choose Work and keep automatic session copies enabled, then use **Start session**. The session settings offer **Delete session** with confirmation. The service archives its results and removes its copies. [Arcadia](../arcadia/en.md)

To register a repository from your phone, open **Settings → Repositories → Add repository**. Choose GitHub or GitLab and send its HTTPS/SSH URL, then a name. For Arcadia choose its module and send an existing mount path. `/cancel` cancels registration. Each step belongs to your chat or topic and expires after ten minutes. `/repo URL` chooses a different repository for one request. [Workspace sources and copies](../workspaces/en.md)

## One conversation across CLI, web and Telegram

After `/group` connects a forum supergroup, **every new session** gets a topic, including sessions started with `daddy new` or from the website. A Telegram channel is not a forum group. The bot must have permission to create and manage topics; once connected, topic creation needs no manual step.

The topic mirrors sent user messages as `[user]` and assistant messages as `[daddy]`. Each turn has one message card. New progress updates edit it; the final answer replaces the progress text. Commands, tool arguments/results, stdout/stderr, reasoning, structured protocol output and private worker reports are not part of this feed. Codex and Claude publish through the same public-text adapter callback.

Write in the topic to continue the same server-side session. The original Telegram message is not echoed into its own topic. A message sent in the private bot chat is mirrored to the session topic. Reconnecting replays unsent saved conversation messages using per-topic delivery receipts; reconnecting alone does not duplicate delivered messages. Notification preferences control private alerts; the linked topic keeps the conversation itself.

The server hosts the agents, SQLite history and Telegram connection. A laptop terminal is just another client: closing it leaves the topic and agents running.

## Session commands and delivery

- `/new Your task description` saves the goal, then lets you choose a workspace. The description is optional. The session and topic use the goal as their name; a session started without a goal gets its name from the first message.
- `/rename New name` changes this session and the same Telegram topic. It preserves topic ID, history, tasks and running agents. In private chat, open the intended session first.
- A regular message goes to the current conversation with daddy.
- `/modules` shows enabled integrations. `/models` selects an installed agent and model. Missing modules are added through the server installer.

**Working copy settings** is a separate optional screen. Automatic copies are recommended: daddy creates the session's folders and removes them after archiving results on deletion. Prepared copies require an administrator-managed set of free server checkouts. The ordinary session screen keeps **Start session** and **Browse server folders** as its main actions.

If SQLite fails while saving a task command or an incoming text or voice message, the bot fetches the unconfirmed message again and preserves the order. Use `daddy telegram status` to see a polling error. Telegram retains incoming updates for up to 24 hours. [Telegram Bot API](https://core.telegram.org/bots/api#getting-updates)

Outgoing messages are buffered in SQLite before sending. Failed deliveries retry after 1, 2, 4… seconds, capped at five minutes; new conversation messages also wake the buffer. Telegram's `retry_after` always takes precedence. Agent replies and requested menus each retain their own order within a topic across restarts. An information command such as /queue, /status, /workers or /help, or a navigation button, can show a menu ahead of a pending agent reply. Both senders observe the same Telegram retry deadline. The bot acknowledges an information command once its response is durable. Replaying the same input reuses its existing card. Superseded unsent progress is replaced by the newest text, and acknowledged parts of a long reply are not resent. Renaming a topic uses this queue too.

If Telegram accepted a brand-new message but its acknowledgement was lost, its API offers no idempotency key to prove that fact: a retry can rarely create a duplicate. Edits of known message IDs can be retried safely. Changing or revoking the paired account prevents delivery to the old recipient. Backups retain conversation history, but do not transfer the old bot's delivery queue.
