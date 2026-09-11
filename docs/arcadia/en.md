[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Arcadia and Tracker

Select the `arcadia` module during installation. It uses existing corporate tools; the public installer does not install or authenticate Arc/Arcanum for you.

```bash
daddy arcadia setup --help
daddy arcadia setup
daddy arcadia mounts
daddy workspaces add ~/arcadia2 --name Work --base trunk
```

Configure an `arcadia-mount-lease` helper appropriate to this host. Its config defines the shared object store, mount range, reservations and lease root. A mount must use the expected shared store. The registered source, session snapshots and task sources are protected from worker allocation.

Workers claim separate eligible mounts. One control/review slot is kept available; allocation waits when no suitable slot is free. Dirty or unpushed work is preserved. Lease identity, branch and exact revision are checked before submission. The source mount is not switched to a task branch.

Tracker credentials are read from `TRACKER_OAUTH_TOKEN`, `TRACKER_TOKEN` or `~/.tokens/tracker`. A ticket such as `TEAM-123` is imported read-only; the tool does not write comments to Tracker. Native review uses Arcanum and Arc tools. Imported descriptions and published comment Markdown stay intact.

```bash
daddy new --workspace Work "TEAM-123"
daddy talk SESSION_ID "Also take TEAM-124"
```

Review and implementation still follow [the common task cycle](../tasks/en.md). A clean, confirmed author lease may be released after its exact head is visible in the native PR. Unpublished or dirty work stays protected. Cleanup is described in [operations](../operations/en.md).
