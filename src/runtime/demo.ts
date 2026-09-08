import type { AgentInput, AgentRuntime } from './agent.js';
import type { AgentResult } from '../core/types.js';
import { setTimeout as delay } from 'node:timers/promises';
export class DemoRuntime implements AgentRuntime {
  async run(input: AgentInput): Promise<AgentResult> {
    input.onSession(`${input.job.role}-demo-${input.task.id}`, `demo-turn-${input.job.id}`);
    input.onEvent('runtime.item', {
      type: 'commandExecution',
      command: 'Demo fixture · inspect session generation guard',
      status: 'completed',
    });
    await delay(150, undefined, { signal: input.signal });
    let summary =
      'Demo fixture: the final revision has a generation guard and its test checks the stale callback scenario.';
    if (input.job.kind === 'review') {
      if (input.task.round === 1) {
        await input.onTool('add_comment', {
          key: 'R1',
          body: '**A stale callback can update the replacement session.**\n\nAfter session A closes and session B replaces it, a queued callback from A still updates `currentSession`. Capture the generation at dispatch and compare it before applying the response.\n\nA regression test should replace the session before delivering the old callback.',
          path: 'src/session.ts',
          line: 42,
          side: 'RIGHT',
        });
        summary =
          'Demo fixture: reviewed callback lifetime and session replacement. One reproducible issue is saved as a native draft comment. Discuss it or publish the review to start the author.';
      }
      await input.onTool('set_summary', { body: summary });
    } else if (input.job.kind === 'fix')
      summary =
        'Demo fixture: added a generation check and a stale callback regression test. The demo provider will now advance its revision for independent verification.';
    else {
      summary =
        'Demo session: the issue is about callback ordering, even on a single event loop. The callback captured session A, but its result arrives after B becomes current. In live mode this conversation continues in the same Codex thread.';
      if (
        input.job.role === 'reviewer' &&
        /^(remove|delete|удали|убери)\b/i.test(input.job.input.trim()) &&
        input.task.snapshot?.comments[0]
      ) {
        await input.onTool('remove_comment', {
          id: input.task.snapshot.comments[0].id,
          outcome: 'deferred',
          reason: 'Explicitly removed by the human in the demo reviewer session.',
        });
        summary = 'Demo session: removed the draft finding and recorded your decision.';
        await input.onTool('set_summary', { body: summary });
      }
    }
    return {
      status: 'completed',
      summary,
      checkedHead: input.task.revision!.head,
      verifiedCommentIds: input.task.feedback?.comments.map((c) => c.id) ?? [],
      disputedCommentIds: [],
    };
  }
}
