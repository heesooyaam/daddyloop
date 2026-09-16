[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Start here

**Install on the Linux machine that will do the work.** Open the website from your laptop or phone. The server stays on; clients can disconnect.

## 1. Install

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.20.2/install.sh | bash
```

Choose modules with **↑/↓**, toggle with **Space**, confirm with **Enter**. Codex and GitHub are selected initially. GitLab uses its REST API; Arcadia uses your existing corporate tools. The installer downloads the CLI packages selected by your choices, installs Node and the local speech model, then starts a systemd service. No tmux setup is needed.

For an unattended installation:

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.20.2/install.sh | bash -s -- --yes --modules codex,github,arcadia
```

Linux x64 and ARM64 are supported. The script needs curl and tar; it can install Git through apt. One-time sudo access may be needed for Git and the persistent service. macOS and Windows can use the website. See [operations](../operations/en.md) for service management.

### Modules

| ID        | What it adds                                                              |
| --------- | ------------------------------------------------------------------------- |
| `codex`   | Codex CLI, models, quotas and managed updates                             |
| `claude`  | Claude Code CLI and its sandbox dependencies (Bubblewrap and socat)       |
| `github`  | GitHub issues, PRs and reviews; GitHub CLI for account setup              |
| `gitlab`  | GitLab MRs and reviews through REST; no extra CLI                         |
| `arcadia` | Arcadia reviews and Tracker tickets through your existing corporate tools |

`daddy modules list` shows the installed selection. The installer downloads extra CLI packages only for selected modules. `--yes` reuses the current selection when upgrading, or the recommended defaults on a new host; `--modules` supplies the full desired list. To change modules, finish or pause work and rerun the installer with that list. Data and credentials live separately from the installation.

## 2. Connect accounts

```bash
daddy auth agent codex
daddy auth github       # when GitHub is selected
```

Codex opens a device login flow. GitHub uses browser login and SSH for Git. For GitLab use `daddy auth gitlab`; for Arcadia follow [its setup](../arcadia/en.md). For Claude, follow [agent authentication](../agents/en.md#claude). Choosing a module does not sign in to its account.

## 3. Register a workspace

```bash
daddy workspaces add https://github.com/your-team/app --name App
```

This saves the source address. daddy prepares a copy for each worker when work starts. You can also register an existing Git folder or Arcadia mount. See [workspaces](../workspaces/en.md).

## 4. Give daddy a job

```bash
daddy
# In the console: /new → App → describe the job or paste a ticket.
```

Or use a command:

```bash
daddy new --workspace App "Fix duplicate payments and add a regression test"
```

**To open the site on your computer, follow [computer and phone access](../web/en.md).** It includes the exact SSH tunnel command. For Telegram, follow [bot setup](../telegram/en.md).

## Check the installation

```bash
daddy --version
daddy modules list
daddy service status
daddy doctor
```

`doctor` reads resource/account/protocol status; it does not run an agent task. Model choices are covered in [agents](../agents/en.md).

[Portable backups](../backups/en.md)
