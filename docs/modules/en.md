[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Modules and their contracts

The installer offers the modules that actually work:

| ID        | Purpose                                                    | Additional installation                    |
| --------- | ---------------------------------------------------------- | ------------------------------------------ |
| `codex`   | Agent execution, model catalogue, Codex quotas and updates | Codex CLI                                  |
| `github`  | GitHub reviews, PR submission and issues                   | GitHub CLI for account setup               |
| `gitlab`  | GitLab reviews and MR submission                           | REST adapter; no GitLab CLI                |
| `arcadia` | Arcadia reviews/submission and Tracker tickets             | Uses existing Arc, Arcanum and mount tools |

The lightweight adapters and interfaces live in the application. Module selection controls which integrations can run; the installer downloads the selected extra CLI packages only. GitLab and Arcadia do not add an unrelated CLI. Accounts and corporate tools still require their own setup. See [installation](../start/en.md) and [Arcadia](../arcadia/en.md).

```bash
daddy modules list
# During installation:
# --modules codex,github,gitlab
```

Without `--yes`, the installer shows checkboxes: arrows move, Space toggles, Enter installs. `--yes` chooses defaults; a current configuration can supply its existing selection. Explicit `--modules` overrides it. To change the selection, finish or pause work, rerun the installer with the required full list, and check `daddy modules list`. Different selections are stored as immutable installation variants. Source data and credentials are separate from these variants.

Claude is not a shipped adapter yet. A new engine implements the same execution interface; there is no fake Claude installation option.

## Agent boundary

[`AgentModule`](../../src/modules/contracts.ts) supplies a runtime and catalogue. [`AgentRegistry`](../../src/modules/agents/registry.ts) routes both task and coordinator turns by `profile.engine`. It passes the model/effort to that module as data.

- `AgentRuntime.run(AgentInput)` executes a task turn.
- `SessionRuntime.runSession(SessionInput)` executes a coordinator turn.
- Inputs include the working directory, cancellation signal, tools, scoped tool callback, event callback and persistent-session callback.
- Results use the common `AgentResult`: completion status, summary, checked head and verification/dispute IDs.
- A catalogue lists engine-tagged models and validates its profiles. Engines own their protocol, authentication and model discovery.

Session handles are opaque to the scheduler and bound to an engine. A turn cannot resume a different engine's handle. An explicit engine change starts a new context and records previous handles. The workflow engine still validates exact revisions and generations before accepting a result.

## Repository boundary

[`RepositoryModule`](../../src/modules/contracts.ts) supplies PR parsing, repository matching, a native `ReviewProvider`, optional ticket import, and a `SubmissionBackend`:

- `owner` verifies the native actor.
- `prepare` validates/pushes the saved implementation.
- `create` creates the native PR/MR.
- `find` reconciles a lost creation response using identity, branch/repository and marker.

[`RepositoryRegistry`](../../src/modules/repositories/registry.ts) selects enabled modules. `TicketWorkflow` owns serialization, the outbox and revision/generation checks; provider-specific REST/Arc behavior lives in module implementations. Shared Git and Arc workspace helpers own checkout isolation and source protection.

## Add a module through a PR

1. Implement the contract under `src/modules/agents/` or `src/modules/repositories/`.
2. Register it in that directory's `index.ts` and add installer metadata in `src/modules/catalogue.ts`.
3. If it needs an extra CLI, add its verified release component to `scripts/build-release.mjs`. The installer consumes the artifact metadata and does not need an engine-specific shell branch.
4. Test cancellation, session resume, invalid results and scoped tools for an agent; exact-head checks, ownership, partial publication and ambiguous writes for a repository.
5. Add both `docs/<topic>/en.md` and `ru.md`. Update [the docs index](../index/en.md) and run the [contribution checks](../contributing/en.md).

Modules are trusted application code reviewed and built with the release. A task cannot install arbitrary code or register its own backend.
