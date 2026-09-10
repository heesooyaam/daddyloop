# Getting started with Daddyloop

Install the managed Linux service from the current release, authenticate Codex and the review provider, then register a source project:

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.7.0/install.sh | bash
daddy auth codex
daddy auth github
daddy projects add ~/projects/app --name App
daddy
```

In the terminal, choose `/new`, select the project and describe the goal or paste a ticket. On the website, use **Projects** to browse the server's folders, then **New session**. A project records its source repository, optional starting subdirectory and base branch. Each writer receives an isolated working copy.

A session has one Daddy conversation and a pool of writers. It starts with one writer; change the limit with `/pool` or the website's pool control. Daddy assigns work and reviews results. Send additional tickets in the same session to add work to its pool. Writer reports are readable; user instructions go through Daddy.

For Telegram, run `daddy telegram setup`, pair the bot, then send `/workspace` in the private chat. Choose a group with Topics enabled and give the bot permission to manage them. New Daddy sessions get topics automatically.

The service survives client/SSH disconnects. A phone browser needs persistent HTTPS; use `daddy web tailscale` or `daddy web origin <https-url>`, then `daddy phone`. Telegram connects from the server independently of the laptop.

[Full guide](../README.md) · [English quickstart](quickstart-en.md) · [CLI](terminal.md) · [Arcadia](arcadia.md) · [Telegram](telegram.md)
