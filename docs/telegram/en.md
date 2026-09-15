[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Telegram: private chat and forum topics

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

## A topic per daddy session

Create a Telegram **supergroup with Topics enabled**, add the bot as administrator, and allow it to manage topics. In the private bot chat send `/group` and select the group using Telegram's picker. The service verifies your membership and the bot's rights. Telegram requires you to create/join the group; the bot cannot silently create one and add you.

Each daddy session gets a topic. Send goals and tickets there; workers report to daddy. `/new Another job` inside a topic starts a separate session/topic. Ordinary messages add work to the current session. If topic creation had an uncertain result, follow the bot's `/attach` instruction rather than creating duplicates.

## Commands

| Where                                     | Commands                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private chat and connected session topics | `/new`, `/sessions`, `/workspaces`, `/status`, `/pool`, `/models`, `/instructions`, `/skill`, `/presets`, `/preset`, `/repo`, `/limits`, `/pause`, `/resume`, `/notifications`, `/language en`, `/language ru`, `/help` |
| Private chat                              | `/group`, `/updates`, `/web`                                                                                                                                                                                            |

`/web` creates a browser login link after [permanent HTTPS access](../web/en.md) is configured. CLI updates and account confirmations stay in the private chat. Work continues when the phone and laptop are offline.

Send `/notifications` to choose quiet completion/decision notices, all updates, or mute. Voice messages follow the same session routing; see [voice](../voice/en.md).

The session card opens **Instructions for this session**. `/instructions daddy <text>` and `/instructions worker <text>` set separate prompts; `/skill <role> <GitHub URL>` adds a skill. These commands work in private conversations and their group topics. See [task instructions](../instructions/en.md).

`/presets` lists shared presets. `/preset <name>` enables one for the selected conversation/topic. Other sessions keep their choices. Individual parts are selected in the website’s session settings.

After a successful callback-button action sends a replacement message, the bot deletes the clicked card. Failed actions keep the old card for retry; messages in another topic do not remove it. Link buttons open their URL directly and do not notify the bot of a click.

For Arcadia, choose Work and keep automatic session copies enabled, then use **Start session**. The session card offers **Delete session** with confirmation; the service archives its results and removes its copies. See [Arcadia](../arcadia/en.md).

To register a repository from your phone: **Workspaces → Add workspace → GitHub/GitLab**, send its HTTPS/SSH URL, then a name. For Arcadia choose its module and send an existing mount path. `/cancel` cancels registration. Each step belongs to your chat or topic and expires after ten minutes. `/repo URL` chooses a different repository for one request. [Workspace sources and copies](../workspaces/en.md).
