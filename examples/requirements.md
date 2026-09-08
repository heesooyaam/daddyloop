# Requirements: ignore callbacks from replaced sessions

The service can replace the active session while callbacks from its predecessor remain queued on the event loop. Those callbacks must never update the replacement session.

## Constraints

- Preserve the single event loop architecture and the public API.
- Keep callbacks for the current session working as before.
- Do not add global locks or change unrelated request cancellation behavior.

## Acceptance criteria

- A callback captures the generation of the session that scheduled it.
- Applying a callback requires the captured generation to match the current session.
- A regression test replaces the session before delivering an old callback and verifies that the replacement session remains unchanged.
- Existing current-session callback tests and CI pass on the final revision.
