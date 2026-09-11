[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# The daddy CLI

Run `daddy` for the interactive console. There is one conversation with daddy, a task board, workspace selection, worker pool and model choices.

| Command                        | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `/new`, `/workspaces`          | Select a workspace and start work         |
| `/sessions`                    | Switch sessions                           |
| `/tasks`, `/chat`              | Switch task board and conversation        |
| `/pool`, `/pool 3`             | Inspect or resize the worker pool         |
| `/models`                      | Choose an engine-tagged model and effort  |
| `/repo /path`, `/repo default` | Set or clear a repository override        |
| `/limits`                      | Read quotas and prepare a confirmed reset |
| `/notifications`, `/updates`   | Notifications and CLI versions            |
| `/language en`, `/language ru` | Language                                  |
| `/pause`, `/resume`            | Session lifecycle                         |
| `/quit`                        | Disconnect this client                    |

Ctrl+N starts a session, Ctrl+T selects one, Tab changes panes, PgUp/PgDn scroll, and Ctrl+Q exits. Enter sends text; the interface shows available shortcuts. Drafts stay separate while switching sessions within the same client.

```bash
daddy --theme dark
daddy --theme light
daddy --plain
daddy console SESSION_ID
daddy talk SESSION_ID "Take the next ticket"
```

The plain console is a basic client for the same daddy workflow. Closing either console restores terminal modes and leaves the service running. The eight web themes are separate browser preferences; see [appearance](../appearance/en.md).

For a CLI on another machine, build the source client with a supported Node version, then run `daddy connect https://your-host` and enter its token. The website needs no local Node installation: [open it from your computer](../web/en.md).
