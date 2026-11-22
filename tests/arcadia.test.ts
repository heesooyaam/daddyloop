import { it, expect } from 'vitest';
import { ArcadiaProvider } from '../src/providers/arcadia.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { parsePR, tag } from '../src/providers/provider.js';
import { sameRevision, type ReviewHandle } from '../src/core/types.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
class FakeArc extends ArcBridge {
  calls: string[][] = [];
  head = 'a'.repeat(40);
  diff = '99';
  targetBranch = 'main';
  general = [
    { id: -7, content: tag('daddyloop:test'), is_draft: true, author: { name: 'tester' } },
  ];
  inline = [
    {
      id: -9,
      content: 'Exact markdown\n```cpp\nreturn;\n```\n' + tag('daddyloop:test:comment:R1'),
      is_draft: true,
      author: { name: 'tester' },
    },
  ];
  override async metadata(id: number) {
    return {
      pr: {
        id,
        url: ref.url,
        summary: 'Changes',
        description: '',
        status: 'open',
        author: 'tester',
        from_id: this.head,
        from_branch: 'fix',
        to_branch: this.targetBranch,
      },
      base: 'b'.repeat(40),
      user: 'tester',
    };
  }
  override async activeDiff() {
    return this.diff;
  }
  override async api<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    if (args[1] === 'comments') return (args[0] === 'pr' ? this.general : this.inline) as T;
    if (args[1] === 'checks') return { checks: [] } as T;
    if (args[1] === 'create-comment') {
      const note = {
        id: 103 + this.general.length,
        content: args[args.indexOf('--content') + 1],
        is_draft: true,
        author: { name: 'tester' },
      };
      this.general.push(note);
      return note as T;
    }
    return { success: true } as T;
  }
}
const ref = parsePR('https://a.yandex-team.ru/review/11111111');
const review: ReviewHandle = {
  id: '-7',
  nodeId: '99',
  marker: 'daddyloop:test',
  authorId: 'tester',
  revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40), revisionId: '99' },
};
it('parses Arcanum URLs and keeps diff versions in revision identity', () => {
  expect(ref.provider).toBe('arcadia');
  expect(parsePR('https://a.yandex-team.ru/arc/trunk/arcadia/pull/11111111').number).toBe(
    ref.number,
  );
  expect(sameRevision(review.revision, { ...review.revision, revisionId: '100' })).toBe(false);
});
it('preserves negative Arcanum IDs and publishes only its explicitly tracked drafts', async () => {
  const bridge = new FakeArc(),
    provider = new ArcadiaProvider(bridge);
  const snapshot = await provider.getReview(ref, review);
  expect(snapshot.comments[0].id).toBe('diff:-9');
  expect(snapshot.comments[0].body).toContain('```cpp\nreturn;');
  await provider.publish(ref, review);
  expect(bridge.calls.at(-1)).toEqual([
    'draft-comment',
    'publish',
    '--comment-for-review-ids=-7',
    '--comment-for-diff-ids=-9',
  ]);
});
it('refuses to publish unrelated Arc drafts', async () => {
  const bridge = new FakeArc();
  bridge.general.push({
    id: -8,
    content: 'Another manual draft',
    is_draft: true,
    author: { name: 'tester' },
  });
  await expect(new ArcadiaProvider(bridge).publish(ref, review)).rejects.toMatchObject({
    code: 'review_not_draft',
  });
  expect(bridge.calls.some((c) => c[0] === 'draft-comment')).toBe(false);
});
it('uses the pinned diff ID and retains the sign when deleting an inline draft', async () => {
  const bridge = new FakeArc();
  await new ArcadiaProvider(bridge).deleteComment(ref, review, 'diff:-9');
  expect(bridge.calls[0]).toEqual(['diff', 'delete-comment', '-9', '--diff-id', '99']);
});

it.each([
  ['retry', 'draft'],
  ['retry', 'partial'],
  ['retry', 'orphan draft'],
  ['resume', 'draft'],
  ['resume', 'published'],
  ['resume', 'orphan published'],
] as const)('checks the old Arcanum review before %s (%s)', async (entry, status) => {
  const bridge = new FakeArc();
  bridge.general = [];
  bridge.inline = [];
  const provider = new ArcadiaProvider(bridge);
  const store = new Store(':memory:');
  const engine = new Engine(store, () => provider);
  try {
    const task = await engine.create({ ref, repoPath: '/tmp', requirements: 'Check the fix' });
    const queued = await engine.review(task.id);
    const old = queued.review!;
    const original = queued.revision!;
    const prior = {
      status: 'published' as const,
      body: '',
      revision: original,
      url: ref.url,
      comments: [{ id: 'pr:102', body: 'First finding', url: ref.url }],
    };
    bridge.general.push({
      id: 104,
      content: `Second finding\n\n${tag(`${old.marker}:comment:R2`)}`,
      author: { name: 'tester' },
      is_draft: !['published', 'partial', 'orphan published'].includes(status),
    });
    if (status === 'published') bridge.general[0].is_draft = false;
    if (status.startsWith('orphan')) bridge.general.shift();
    store.cancelJobs(task.id);
    store.saveTask({ ...queued, state: 'needs_input', feedback: prior });
    if (entry === 'resume') {
      const author = store.enqueue(queued, 'author', 'fix', 'Fix the first finding');
      store.saveJob({ ...author, status: 'cancelled' });
      bridge.head = 'c'.repeat(40);
      bridge.diff = '100';
      store.event(
        task.id,
        'author.feedback_snapshot',
        { ...prior, targetBranch: bridge.targetBranch },
        author.id,
      );
      store.event(
        task.id,
        'author.fixes_saved',
        { head: bridge.head, revision: original },
        author.id,
      );
      store.saveTask({ ...store.getTask(task.id), generation: author.generation + 1 });
    } else bridge.targetBranch = 'release';

    const retry = () =>
      entry === 'resume' ? engine.action(task.id, 'resume') : engine.review(task.id, true);
    const operations = store.db.prepare('SELECT id, status FROM operations').all();
    if (status === 'draft' || status === 'partial' || status === 'orphan draft') {
      const blocked = await retry();
      expect(blocked).toMatchObject({
        state: 'needs_input',
        review: old,
        reason: expect.stringContaining('Arcanum'),
      });
      expect(store.db.prepare('SELECT id, status FROM operations').all()).toEqual(operations);
      bridge.general = bridge.general.filter((note) => !note.is_draft);
    }
    const resumed = await retry();
    const next = entry === 'resume' ? await engine.review(task.id) : resumed;
    expect(next).toMatchObject({
      state: 'reviewing',
      review: { targetBranch: bridge.targetBranch, revision: { head: bridge.head } },
    });
    const latestFinding = status === 'draft' || status === 'orphan draft' ? 'pr:102' : 'pr:104';
    expect(next.feedback?.comments.map(({ id }) => id)).toEqual([latestFinding]);
    expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(2);
  } finally {
    store.close();
  }
});
