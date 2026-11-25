import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRuntime } from '../src/modules/agents/codex/runtime.js';
import { buildContext } from '../src/runtime/context.js';
import { fixture } from './helpers.js';

it.each([3, 2968])('prepares a Codex review with %i recorded decisions', async (count) => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-review-context-'));
  try {
    const task = f.task;
    const head = task.revision!.head;
    const oldHead = 'b'.repeat(40);
    const commentId = 'published-1';
    task.feedback = {
      status: 'published',
      comments: [{ id: commentId, body: 'Published finding', url: '' }],
      revision: task.revision!,
      body: '',
      url: '',
    };
    const markdown =
      'Keep the pinned revision.\n\n```ts\ncheck(head);\n```\n[Details](https://demo.local/example)';
    f.store.transaction(() => {
      for (let i = 0; i < count - 2; i++) {
        f.store.decision(
          { ...task, revision: { ...task.revision!, head: oldHead } },
          {
            commentId,
            outcome: 'verified',
            reason: `Earlier round ${i}. ${'Synthetic review evidence. '.repeat(6)}`,
          },
        );
      }
    });
    const current = f.store.decision(task, { commentId, outcome: 'deferred', reason: markdown });
    f.store.decision(task, {
      commentId: 'draft-1',
      outcome: 'disputed',
      reason: 'Private draft rationale',
    });
    if (count > 3) task.reviewerThreadId = 'thread-fixture';
    const job = f.job();
    const trace = join(dir, 'requests.jsonl');
    const runtime = new CodexRuntime({
      executable: process.execPath,
      args: [resolve('tests/fixtures/fake-codex.mjs'), 'input-limit', trace],
      timeoutMs: 5000,
    });
    try {
      const result = await runtime.run({
        task,
        job,
        cwd: dir,
        prompt: buildContext(f.store, task, job),
        signal: new AbortController().signal,
        onEvent: () => {},
        onSession: () => {},
        onTool: async (name, args) => f.engine.broker.call(job, name, args),
      });
      expect(result.status).toBe('completed');
    } finally {
      const request = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((packet) => packet.method === 'turn/start');
      const prompt = request.params.input[0].text as string;
      process.stdout.write(
        `${count} decisions: ${prompt.length} characters in turn/start input text\n`,
      );
      expect(prompt).toContain(JSON.stringify(current.reason));
      expect(prompt).toContain(current.id);
      expect(prompt).toContain(head);
    }
    expect(f.store.decisions(task.id)).toHaveLength(count);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps whole decisions, limits distinct entries and pages history within the job scope', async () => {
  const f = await fixture();
  try {
    const task = f.task;
    const revision = task.revision!;
    const published = { id: 'published-1', body: 'Published finding', url: '' };
    task.feedback = { status: 'published', comments: [published], revision, body: '', url: '' };
    const oldTask = { ...task, revision: { ...revision, head: 'b'.repeat(40) } };
    const historical = f.store.decision(oldTask, {
      commentId: published.id,
      outcome: 'verified',
      reason: 'Verified on the previous head',
    });
    const current = f.store.decision(task, {
      commentId: published.id,
      outcome: 'verified',
      reason: 'Verified on the pinned head',
    });
    for (let i = 0; i < 30; i++) {
      f.store.decision(task, {
        commentId: `draft-${i}`,
        outcome: 'deferred',
        reason: 'Private draft rationale. '.repeat(200),
      });
    }
    const large = f.store.decision(task, {
      commentId: 'draft-large',
      outcome: 'disputed',
      reason: '\u0000'.repeat(60_000),
    });
    f.store.decision(
      { ...task, id: 'other-task' },
      {
        commentId: published.id,
        outcome: 'verified',
        reason: 'Unrelated task',
      },
    );
    f.store.saveTask(task);

    const reviewer = f.job();
    const author = f.job('author');
    const reviewerPrompt = buildContext(f.store, task, reviewer);
    expect(reviewerPrompt.length).toBeLessThan(70_000);
    expect(reviewerPrompt).toContain('"moreDecisions": true');
    expect(reviewerPrompt).toContain(current.id);
    expect(reviewerPrompt).toContain(historical.id);
    expect(reviewerPrompt).not.toContain(large.id);
    const authorPrompt = buildContext(f.store, task, author);
    expect(authorPrompt).toContain(current.id);
    expect(authorPrompt).toContain(historical.id);
    expect(authorPrompt).not.toContain('Private draft rationale');

    const history = (query: Record<string, string>) =>
      f.engine.broker.call(reviewer, 'read_review', { decisions: query });
    expect(await history({ commentId: published.id, head: oldTask.revision.head })).toEqual({
      decisions: [historical],
      nextBefore: null,
    });
    expect(await history({ commentId: large.commentId! })).toEqual({
      decisions: [large],
      nextBefore: null,
    });
    expect(await history({ head: revision.head })).toEqual({
      decisions: [large],
      nextBefore: large.id,
    });
    expect(await history({ head: revision.head, before: large.id })).toMatchObject({
      decisions: [29, 28, 27, 26, 25, 24, 23, 22, 21, 20].map((i) => ({
        commentId: `draft-${i}`,
      })),
      nextBefore: expect.any(String),
    });
    expect(await f.engine.broker.call(author, 'read_review', { decisions: {} })).toEqual({
      decisions: [current, historical],
      nextBefore: null,
    });
  } finally {
    f.store.close();
  }
});
