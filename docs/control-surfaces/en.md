[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Web and Telegram control coverage

The website and Telegram are clients of the same service. They should offer the same workflow decisions even when their screens differ. Telegram must remain useful from a phone without an HTTPS website, SSH connection or laptop.

This page records current coverage. A check means that the capability is available through the service policy in that client. “Partial” names a concrete remaining gap; it is not a claim of full parity.

## Sessions and tasks

| Capability                                 | Web       | Telegram private chat                             | Telegram session topic                            | Remaining gap                                               |
| ------------------------------------------ | --------- | ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| List, create and select sessions           | Yes       | Yes                                               | Yes; `/new` creates another topic                 | None                                                        |
| Select a session outside its topic         | Yes       | Yes; `/session`                                   | Yes; `/session` in the general topic              | Ordinary general-topic messages are deliberately not routed |
| Rename, pause, resume and delete a session | Yes       | Yes                                               | Yes                                               | None                                                        |
| Read the task list and task state          | Yes       | Yes; `/tasks` and `/task`                         | Yes; `/tasks` and `/task`                         | None                                                        |
| See the exact task revision and generation | Yes       | Yes                                               | Yes                                               | None                                                        |
| Submit saved work and publish reviews      | Automatic | Automatic                                         | Automatic                                         | No manual action; revision and provider checks still apply  |
| Approve a plan                             | Yes       | Yes, with a separate confirmation                 | Yes, with a separate confirmation                 | None                                                        |
| View CI state and record a reasoned waiver | Yes       | Yes; `/waive <reason>` confirms the exact version | Yes; `/waive <reason>` confirms the exact version | None                                                        |
| Read worker reports                        | Yes       | Yes; the private task card shows the latest eight | Yes; the group card opens the same private detail | None                                                        |

Telegram action buttons contain only a short-lived reference to service state. The saved reference binds the paired owner, chat, topic, session, task, revision and generation. The confirmation calls the same service method as the website. The coordinator’s ordinary reply never grants permission.

Session, workspace, discovered repository, task and preset lists have in-chat page controls and do not require a known item name to reach the final entry. Server-folder browsing shows up to the first 150 entries returned by the service; when that result is truncated, Telegram says so and asks for a more specific `/repo` path. Task cards render every reported CI check, and safe private links stay attached to their corresponding check. Paging during `/new` or a private repository choice keeps the original chat route and typed request.

The shared preset library can be browsed without selecting a session. Applying a preset remains bound to the session that produced the card; after a session switch the bot asks the user to reopen the library.

## Configuration and service controls

| Capability                                       | Web                                               | Telegram                                    | Remaining gap                                                   |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Add repositories and choose one for a request    | Yes, including a one-off branch and subfolder     | Yes, including `/repo --base` and `--scope` | None                                                            |
| Choose daddy and worker models and effort        | Yes                                               | Yes                                         | None                                                            |
| Inspect and resize the worker pool               | Yes                                               | Yes                                         | None                                                            |
| Set role instructions and attach a skill         | Yes                                               | Yes                                         | None                                                            |
| Select and manage shared presets                 | Yes                                               | Yes                                         | None                                                            |
| Import or export an instruction set              | Yes                                               | Yes, in private chat                        | None                                                            |
| View usage and confirm an available reset        | Yes                                               | Yes                                         | None                                                            |
| Configure notifications and language             | Yes                                               | Yes                                         | None                                                            |
| Check, install and roll back agent CLIs          | Yes                                               | Yes, in private chat                        | None                                                            |
| View enabled modules                             | Yes                                               | Yes                                         | None                                                            |
| Connect a Telegram forum and repair a topic link | Explains the Telegram step                        | Yes                                         | This is a Telegram transport operation, not a workflow decision |
| Voice input                                      | Yes, in chat and new-task forms                   | Yes                                         | Browser speech support depends on the device and permission     |
| Scheduled disk cleanup                           | Yes; schedule, threshold, skill and latest report | Yes; `/cleanup` in private chat             | Same service settings and report                                |
| Theme and layout                                 | Yes                                               | Telegram-controlled                         | Presentation does not need identical controls                   |

Secrets and account credentials are never rendered in a group. CLI updates, browser login links and group connection stay in the paired private chat. A group command that needs a private step links to that chat instead of asking for a token.

The private chat accepts bounded UTF-8 `.json`, `.md` and `.txt` documents. Instruction JSON is validated by the same schema as the website; skill files use the same snapshots and size limits. Exports are generated documents and never posted to a group. `/workspace` edits saved repository defaults. `/preset save|update|delete|rename|describe|parts` covers the shared library, while `enable|disable|remove` manages a session’s saved copy.

## Commands and routing

The bot registers separate command menus for all private chats and for the connected forum chat. Both `/command` and `/command@botname` work. A command addressed to another bot is ignored.

Inside a session topic, commands can only control that topic’s session. In the general topic, `/session <name or ID>` creates an explicit control selection for commands such as `/tasks`; it does not make ordinary messages flow into that session. Callback confirmations cannot be moved to another chat or topic.

## Integration boundary

The neighboring pinned-status and assistant-history work owns how long-lived Telegram status and answer cards are retained. This control work touches `src/integrations/telegram.ts`, `telegram-workspace.ts`, `telegram-delivery.ts` behavior and Telegram tests, but it does not add pinned messages or a second answer-history store. Future integration must keep the task confirmation records separate from delivery-card receipts.
