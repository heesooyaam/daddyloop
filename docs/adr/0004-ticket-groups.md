# Ticket-first work and shared reviewers

Status: accepted in 0.4.0.

An issue or Tracker ticket can start a conversation before a PR exists. The source is imported read-only, with its title, description and comments saved as a snapshot. Discussion starts in an isolated read-only author workspace. An explicit implementation action enables writing there; submitting the resulting work creates or connects a native PR and enters the existing review loop. Review comments and completion still depend on the native PR, exact revision and checks.

A large ticket defines a review group. Each child ticket has its own author profile, conversation and working copy. The group owns one reviewer profile and one persistent reviewer thread. Reviewer jobs within a group are serialized even when the configured worker concurrency allows several authors to run. Context passed to an author contains the parent requirements and its own published feedback, never sibling private conversations or reviewer drafts.

Model IDs and supported reasoning efforts come from the authenticated Codex model catalogue. Profiles are independently configurable for authors and reviewers; a child can override its author while inheriting the group reviewer. A job records its profile when queued. Settings cannot silently change a running job or share an author thread with the reviewer. Configuring a group reviewer requires its reviewer queue to be idle.

Git and Arc remain separate workspace implementations. Existing source checkouts are preserved. Ticket work uses managed branches and ordinary pushes. PR creation uses durable operation identity and native reconciliation after an uncertain response. Arc operations require verified leases; clean reviewer mounts can be released after a turn so a large group does not reserve one mount per historical revision.

The UI exposes starting from a ticket, adding a child, configuring models, beginning implementation and submitting for review. Existing PR attachment and old persisted tasks remain compatible.

New real tasks publish finished reviews automatically by default. Manual publication remains an explicit policy choice; existing saved policies are preserved. Telegram notification preferences are visible in the clients, with attention/completion notifications as the default mode and all intermediate messages available as an option. Bot pairing remains necessary before any delivery.
