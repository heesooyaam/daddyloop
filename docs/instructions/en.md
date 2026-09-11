[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Instructions and skills for one task

Give daddy a style and give the workers their own working instructions. These settings belong to one daddy session: the larger task and its worker pool. They never change another session, account defaults, or your personal Codex/Claude configuration.

In **New session**, open **Style and skills for this session** before starting. In an existing session, open **Session settings**. Choose **daddy** or **All workers**, write your instructions and attach any skills you need. Each role can combine several skills with additional text. The additional text follows the skills and can refine their style, for example “use caveman lite”.

## Attach a skill

![Session instructions and skill selection](../media/en/daddy-instructions.png)

| Source                       | How to use it                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                       | Paste `JuliusBrussee/caveman`, or a URL to a specific skill folder or Markdown file. Branches and tags are resolved to a commit. |
| Folder or file on the server | Enter `~/.agents/skills/caveman` or a path to `SKILL.md`. A folder must contain `SKILL.md`.                                      |
| File from this device        | Choose a `.md` or `.txt` file on your laptop or phone.                                                                           |
| Paste skill text             | Give the skill a name and paste its instructions.                                                                                |
| Saved instruction set        | Load a JSON file exported with **Download this instruction set**. It includes both roles and the attached text.                  |

The importer attaches the **instruction text**, including its name, source and checksum. It does not install native plugins, hooks or executables, or copy supporting files referenced by a skill. A skill needing those files or additional tools needs separate setup; a text-only style skill such as [caveman](https://github.com/JuliusBrussee/caveman/tree/main/skills/caveman) can be attached directly. The importer never runs the repository’s installer.

Up to 12 skills per role, 64 KiB per skill and 128 KiB of instructions per role. Public GitHub imports need no account; private repositories use the server’s GitHub credential configured by `daddy auth github`. Explicit URLs help when a repository contains several skills.

## CLI

Configure the first turn when creating the session:

```bash
daddy new --workspace Work \
  --daddy-instructions "Explain decisions briefly in Russian." \
  --daddy-skill JuliusBrussee/caveman \
  --worker-instructions "Verify the change with focused tests." \
  --worker-skill ./skills/testing/SKILL.md \
  "Fix the duplicate requests"
```

Change or inspect one existing session:

```bash
daddy instructions SESSION_ID
daddy instructions SESSION_ID --worker-skill server:~/.agents/skills/testing
daddy instructions SESSION_ID --daddy-instructions "Use caveman lite."
daddy instructions SESSION_ID --clear-instructions worker
daddy instructions SESSION_ID --export task-instructions.json
daddy new --workspace Work --instructions-file task-instructions.json "Next task"
```

Skill flags are repeatable. Ordinary file paths refer to the machine running the CLI; `server:` explicitly reads a file on the service host. Exports create a new file and do not overwrite an existing one. JSON sets have the form `{"daddy":{"prompt":"…","skills":[]},"worker":{"prompt":"…","skills":[]}}`.

## Telegram and interactive CLI

Inside the task’s conversation or Telegram topic:

```text
/instructions
/instructions daddy Explain decisions briefly.
/instructions worker Keep technical details in reports.
/skill daddy JuliusBrussee/caveman
/skill worker https://github.com/owner/repo/tree/main/skills/testing
/instructions daddy --clear
```

Create an empty session with `/new`, configure it, then send the task if the first turn needs these instructions. `/instructions` lists both roles; `--clear` removes that role’s additional text and skills. The website and full CLI also support file imports and exporting sets.

## Changes, engines and backups

Newly queued turns take a snapshot of the selected role. Running and already queued turns keep their snapshot. Changing worker instructions covers subsequent turns of all workers in this session; daddy uses his own instructions both when coordinating and reviewing. Model choices are separate.

The common runtime composes the same instructions for Codex, Claude and modules using `taskSession`. Styles can replace the default voice; they cannot grant file access, change publication policy or bypass workflow checks.

Backups include the actual selected texts and checksums in session/job records. Restoring does not fetch GitHub or read the old skill folder. Source paths remain attribution. Agent contexts are reset as described in [backups](../backups/en.md), but the saved instructions are supplied again when work resumes. Reimport explicitly to take an upstream skill update.
