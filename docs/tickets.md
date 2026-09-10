# Tickets and Daddy sessions

A Daddy session owns a shared goal, conversation, reviewer profile and writer pool. Add a ticket by sending its link or key in that session:

```bash
daddy new --project App "https://github.com/acme/app/issues/42"
daddy talk SESSION_ID "Also handle https://github.com/acme/app/issues/43"
daddy pool SESSION_ID 3
```

GitHub issues and Yandex Tracker tickets are read as source material, including their descriptions and comments. Daddy can also create local work items from a natural-language goal or attach an existing GitHub/GitLab/Arcadia PR/MR for review. A registered project supplies the server repository and starting directory.

Import does not start a writer automatically in a Daddy session. Daddy examines the goal, sets prerequisites where needed, and dispatches appropriate work. The backend enforces ownership, writer limits and dependency cycles. Per-task writer models can differ; choices are validated against the actual Codex catalogue.

Each task owns its author history and managed working copy. The pool is the maximum number of simultaneous writer turns. A queued task is not an extra running session. Dependencies order execution but do not integrate code branches; closely coupled changes should stay in one implementation task or have an explicit integration plan.

The original implementation/review pipeline remains: saved local implementation, ordinary push, durable native PR/MR creation, pinned review, published feedback, corrections and final checks. No merge tool is exposed. A lost provider response is reconciled before another native creation is attempted.

Existing idle work can be adopted into a Daddy session with the authenticated `/api/daddy/adopt` endpoint. Its task data and native reviewer history are retained. Direct author chat is disabled; use Daddy for follow-up instructions.
