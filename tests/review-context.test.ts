import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { dynamicTools } from '../src/core/broker.js';
import { reviewDecisionTool } from '../src/core/review-decisions.js';
import { codexInputLimit } from '../src/runtime/agent.js';
import type { Decision } from '../src/core/types.js';
import { CodexRuntime } from '../src/modules/agents/codex/runtime.js';
import { buildContext } from '../src/runtime/context.js';
import { fixture } from './helpers.js';
import { daddyFixture } from './daddy-fixture.js';

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
      f.engine.broker.readDecisions(reviewer, task, query);
    expect(await history({ commentId: published.id, head: oldTask.revision.head })).toEqual({
      decisions: [historical],
      nextBefore: null,
    });
    const filter = { commentId: large.commentId!, head: revision.head };
    let reason = '';
    let before: string | null = null;
    do {
      const page = await history(before ? { ...filter, before } : filter);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      expect(page.reasonOffset).toBe(reason.length);
      expect(page.decisions).toMatchObject([{ id: large.id, ...filter }]);
      reason += page.decisions[0].reason;
      before = page.nextBefore;
    } while (before);
    expect(reason).toBe(large.reason);
    const first = await history({ head: revision.head });
    expect(first).toMatchObject({
      decisions: [{ id: large.id }],
      nextBefore: expect.any(String),
      reasonOffset: 0,
    });
    expect(f.engine.broker.readDecisions(author, task, { before: first.nextBefore! })).toEqual({
      decisions: [],
      nextBefore: null,
    });
    const older = await history({ head: revision.head, before: large.id });
    expect(older).toMatchObject({
      decisions: [{ commentId: 'draft-29' }],
      nextBefore: expect.any(String),
      reasonOffset: 0,
    });
    expect(f.engine.broker.readDecisions(author, task, {})).toEqual({
      decisions: [current, historical],
      nextBefore: null,
    });
  } finally {
    f.store.close();
  }
});

it.each(['review', 'verify_merge'] as const)(
  'reads an omitted decision through Codex in %s',
  async (kind) => {
    const f = await fixture();
    const dir = mkdtempSync(join(tmpdir(), 'daddyloop-review-read-'));
    try {
      const task = f.task;
      const job = { ...f.job(), kind };
      const oldHead = 'c'.repeat(40);
      const archived = f.store.decision(
        { ...task, revision: { ...task.revision!, head: oldHead } },
        {
          commentId: 'finding',
          outcome: 'verified',
          reason: '[Artifact](https://example.invalid)',
        },
      );
      if (kind === 'review') task.reviewerThreadId = 'thread-fixture';
      else {
        task.feedback = {
          status: 'published',
          comments: [{ id: 'finding', body: 'Published artifact check', url: '' }],
          revision: task.revision!,
          body: '',
          url: '',
        };
        f.store.decision(
          { ...task, revision: { ...task.revision!, head: 'd'.repeat(40) } },
          { commentId: 'finding', outcome: 'verified', reason: 'Verified a later revision' },
        );
      }
      f.store.saveTask(task);
      const trace = join(dir, 'requests.jsonl');
      const query = { commentId: archived.commentId, head: oldHead };
      const runtime = new CodexRuntime({
        executable: process.execPath,
        args: [
          resolve('tests/fixtures/fake-codex.mjs'),
          'review-history',
          trace,
          JSON.stringify(query),
        ],
        timeoutMs: 5000,
      });
      const prompt = buildContext(f.store, task, job);
      expect(prompt).not.toContain(archived.reason);
      const result = await runtime.run({
        task,
        job,
        cwd: dir,
        prompt,
        tools: kind === 'review' ? [...dynamicTools, reviewDecisionTool] : [reviewDecisionTool],
        signal: new AbortController().signal,
        onEvent: () => {},
        onSession: () => {},
        onTool: async (name, args) => {
          expect(name).toBe(reviewDecisionTool.name);
          expect(args).toEqual(query);
          return f.engine.broker.readDecisions(job, task, args);
        },
      });
      expect(JSON.parse(result.summary)).toEqual({ decisions: [archived], nextBefore: null });
      const packets = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const start = packets.find(
        (packet) =>
          packet.method.startsWith('thread/') &&
          ['thread/start', 'thread/resume'].includes(packet.method),
      );
      expect(start.params.config.mcp_servers.daddyloop_history.url).toMatch(
        /^http:\/\/127\.0\.0\.1:/,
      );
      if (kind === 'review') {
        expect(start.method).toBe('thread/resume');
        expect(start.params.dynamicTools).toBeUndefined();
        const handle = await f.engine.broker.ensureReview(task);
        f.store.saveTask(task);
        expect(await f.engine.broker.call(job, 'read_review', {})).toEqual(
          await f.provider.getReview(task.ref, handle!),
        );
      } else {
        expect(start.method).toBe('thread/start');
        expect(start.params.dynamicTools).toEqual([]);
        await expect(f.engine.broker.call(job, 'add_comment', {})).rejects.toMatchObject({
          code: 'role_forbidden',
        });
        await expect(f.engine.broker.call(job, 'set_summary', {})).rejects.toMatchObject({
          code: 'role_forbidden',
        });
        await expect(f.engine.broker.call(job, 'publish', {})).rejects.toMatchObject({
          code: 'role_forbidden',
        });
        f.store.saveTask({ ...task, revision: { ...task.revision!, head: oldHead } });
        expect(() => f.engine.broker.readDecisions(job, task, query)).toThrow(
          /pinned decision history/,
        );
      }
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('budgets decisions against the complete text received by turn/start', async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-review-input-limit-'));
  try {
    const task = f.task;
    const job = f.job();
    task.feedback = {
      status: 'published',
      comments: Array.from({ length: 17 }, (_, index) => ({
        id: String(index),
        url: '',
        body: 'a'.repeat(60_000),
      })),
      revision: task.revision!,
      body: '',
      url: '',
    };
    const additions = ['The full worker-supplied instruction is part of the budget.'];
    const baseline = buildContext(f.store, task, job, additions);
    job.input += 'b'.repeat(codexInputLimit - baseline.length - 1024);
    const mandatory = buildContext(f.store, task, job, additions);
    const omitted = f.store.decision(task, {
      outcome: 'accepted',
      reason: 'c'.repeat(60_000),
    });
    const kept = f.store.decision(task, {
      outcome: 'deferred',
      reason: 'Keep [link](https://example.invalid)',
    });
    const prompt = buildContext(f.store, task, job, additions);
    expect(prompt).toContain(kept.reason);
    expect(prompt).not.toContain(omitted.id);
    expect(prompt).toContain(job.input);
    expect(prompt.endsWith(additions[0])).toBe(true);
    const runtime = new CodexRuntime({
      executable: process.execPath,
      args: [resolve('tests/fixtures/fake-codex.mjs'), 'input-limit'],
      timeoutMs: 5000,
    });
    expect(
      await runtime.run({
        task,
        job,
        cwd: dir,
        prompt,
        signal: new AbortController().signal,
        onEvent: () => {},
        onSession: () => {},
        onTool: async () => ({}),
      }),
    ).toMatchObject({ status: 'completed' });
    expect(f.engine.broker.readDecisions(job, task, {})).toEqual({
      decisions: [kept],
      nextBefore: kept.id,
    });
    process.stdout.write(
      `Near-limit turn/start: ${mandatory.length} required; ${prompt.length} with decisions\n`,
    );
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('parses only the SQLite page during a complete filtered walk', async () => {
  const f = await fixture();
  try {
    const task = f.task;
    const head = task.revision!.head;
    const commentId = 'published-1';
    task.feedback = {
      status: 'published',
      comments: [{ id: commentId, body: '', url: '' }],
      revision: task.revision!,
      body: '',
      url: '',
    };
    f.store.saveTask(task);
    const expected: Decision[] = [];
    f.store.transaction(() => {
      for (let i = 0; i < 2968; i++) {
        expected.push(
          f.store.decision(task, {
            commentId,
            outcome: 'verified',
            reason: `Round ${i}\n\n~~~ts\ncheck();\n~~~\n[Artifact](https://example.invalid)`,
          }),
        );
      }
      f.store.decision(task, { commentId: 'draft', outcome: 'deferred', reason: 'Private draft' });
      f.store.decision(
        { ...task, id: 'other-task' },
        { commentId, outcome: 'verified', reason: 'Other task' },
      );
    });
    const author = f.job('author');
    const parse = vi.spyOn(JSON, 'parse');
    const seen: Decision[] = [];
    let before: string | undefined;
    try {
      do {
        const page = f.engine.broker.readDecisions(author, task, { commentId, head, before });
        expect(page.decisions.length).toBeLessThanOrEqual(10);
        seen.push(...page.decisions);
        before = page.nextBefore ?? undefined;
      } while (before);
      const parsedRows = parse.mock.calls.filter(([data]) => data.includes('"outcome":"verified"'));
      expect(parsedRows).toHaveLength(expected.length);
    } finally {
      parse.mockRestore();
    }
    expect(seen).toEqual(expected.toReversed());
    const privatePage = f.engine.broker.readDecisions(author, task, { head });
    expect(privatePage.decisions).toEqual(expected.slice(-10).reverse());
    const foreignId = f.store.decisions('other-task')[0].id;
    expect(f.engine.broker.readDecisions(author, task, { before: foreignId })).toEqual({
      decisions: [],
      nextBefore: null,
    });
  } finally {
    f.store.close();
  }
});

it('follows a single cursor through a mixed page of Markdown decisions', async () => {
  const f = await fixture();
  try {
    const task = f.task;
    const job = f.job();
    const commentId = 'published-1';
    const head = task.revision!.head;
    const expected = Array.from({ length: 10 }, (_, index) =>
      f.store.decision(task, {
        commentId,
        outcome: 'verified',
        reason: [
          `Decision ${index}`,
          '~~~md',
          '🧩 "\\" café\u0000'.repeat(index % 2 === 0 ? 150 : 700),
          `CONTROL_MARKER_${index}`,
          '~~~',
          '[Example](https://example.invalid)',
        ].join('\r\n'),
      }),
    ).reverse();

    const received = new Map<string, Decision>();
    let before: string | undefined;
    let pages = 0;
    do {
      expect(++pages).toBeLessThan(50);
      const page = f.engine.broker.readDecisions(job, task, { commentId, head, before });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      for (const decision of page.decisions) {
        const prior = received.get(decision.id)?.reason ?? '';
        expect(page.reasonOffset ?? 0).toBe(prior.length);
        received.set(decision.id, { ...decision, reason: prior + decision.reason });
      }
      before = page.nextBefore ?? undefined;
    } while (before);
    expect([...received.values()]).toEqual(expected);
  } finally {
    f.store.close();
  }
});

it('walks past a saved decision whose comment ID alone exceeds the page budget', async () => {
  const f = await fixture();
  try {
    const task = f.task;
    const job = f.job();
    await f.engine.broker.ensureReview(task);
    f.store.saveTask(task);
    const commentId = 'x'.repeat(4096);
    const expected = [];
    for (const id of ['oldest', commentId, 'newest']) {
      expected.push(
        await f.engine.broker.call(job, 'record_decision', {
          commentId: id,
          outcome: 'verified',
          reason: 'Exact Markdown: [evidence](https://example.invalid)',
        }),
      );
    }

    const received = [];
    let record = '';
    let before: string | undefined;
    let pages = 0;
    do {
      expect(++pages).toBeLessThan(10);
      const page = f.engine.broker.readDecisions(job, task, { before });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      received.push(...page.decisions);
      if (page.recordFragment) {
        const { id, offset, json, complete } = page.recordFragment;
        expect(offset).toBe(record.length);
        record += json;
        if (complete) {
          const decision = JSON.parse(record) as Decision;
          expect(decision.id).toBe(id);
          received.push(decision);
          record = '';
        }
      }
      before = page.nextBefore ?? undefined;
    } while (before);
    expect(record).toBe('');
    expect(received).toEqual(expected.toReversed());
  } finally {
    f.store.close();
  }
});

it.each([10, 3772, 4096])(
  'reads a long reason with a %i-character comment ID in at most 20 pages',
  async (idLength) => {
    const f = await fixture();
    try {
      const task = f.task;
      const job = f.job();
      await f.engine.broker.ensureReview(task);
      f.store.saveTask(task);
      const expected = await f.engine.broker.call(job, 'record_decision', {
        commentId: 'x'.repeat(idLength),
        outcome: 'verified',
        reason: 'a'.repeat(60_000),
      });

      let before: string | undefined;
      let pages = 0;
      let recordJson = '';
      let decision: Decision | undefined;
      let reason = '';
      do {
        expect(++pages).toBeLessThanOrEqual(20);
        const page = f.engine.broker.readDecisions(job, task, { before });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
        if (page.recordFragment) {
          const { offset, json, complete } = page.recordFragment;
          expect(offset).toBe(recordJson.length);
          recordJson += json;
          if (complete) decision = JSON.parse(recordJson) as Decision;
        } else {
          expect(page.decisions).toHaveLength(1);
          expect(page.reasonOffset).toBe(reason.length);
          reason += page.decisions[0].reason;
          decision = { ...page.decisions[0], reason };
        }
        before = page.nextBefore ?? undefined;
      } while (before);
      expect(decision).toEqual(expected);
    } finally {
      f.store.close();
    }
  },
);

it('keeps linked task context and published findings on a correction without repeating unrelated sessions tasks', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 41,
        url: 'https://demo.local/pull/41',
      },
      repoPath: f.dir,
      groupId: group.id,
      requirements: 'Fix the returned state.',
    });
    f.store.saveTask({ ...task, id: 'linked', title: 'Linked prerequisite name' });
    f.store.saveTask({ ...task, id: 'other', title: 'An unrelated backlog item' });
    task.dependsOn = ['linked'];
    const job = f.store.enqueue(task, 'reviewer', 'review', 'Review the pinned head');
    expect(buildContext(f.store, task, job)).toContain('An unrelated backlog item');
    task.feedback = {
      status: 'published',
      body: 'Published note on the previous head',
      comments: [],
      revision: task.revision!,
      url: task.ref.url,
    };
    const context = buildContext(f.store, task, job);
    expect(context).toContain('Linked prerequisite name');
    expect(context).toContain('Published note on the previous head');
    expect(context).not.toContain('An unrelated backlog item');
  } finally {
    await f.close();
  }
});
