import { it, expect, vi } from 'vitest';
import { ArcadiaProvider } from '../src/providers/arcadia.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { parsePR, tag } from '../src/providers/provider.js';
import { ProviderWriteNotAttempted, sameRevision, type ReviewHandle } from '../src/core/types.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
class FakeArc extends ArcBridge {
  calls: string[][] = [];
  head = 'a'.repeat(40);
  base = 'b'.repeat(40);
  diff = '99';
  targetBranch = 'main';
  loseCreateResponse = false;
  cannotReadComments = false;
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
  inlineByDiff = new Map<string, typeof this.inline>();
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
      base: this.base,
      user: 'tester',
    };
  }
  override async activeDiff() {
    return this.diff;
  }
  override async api<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    if (args[1] === 'comments') {
      if (this.cannotReadComments) throw new Error('Failed to read comments');
      return (
        args[0] === 'pr' ? this.general : (this.inlineByDiff.get(args.at(-1)!) ?? this.inline)
      ) as T;
    }
    if (args[1] === 'checks') return { checks: [] } as T;
    if (args[1] === 'create-comment') {
      const note = {
        id: 103 + this.general.length,
        content: args[args.indexOf('--content') + 1],
        is_draft: true,
        author: { name: 'tester' },
      };
      this.general.push(note);
      if (this.loseCreateResponse) throw new Error('Lost create response');
      return note as T;
    }
    return { success: true } as T;
  }
}
class DoctorArc extends ArcBridge {
  events: string[] = [];
  override async sourceMounts() {
    this.events.push('sources');
    return [
      {
        status: 'mounted',
        mount: '/source-arcadia',
        store: '/source-store',
        'object-store': '/source-objects',
      },
    ];
  }
  override async api<T>(args: string[]): Promise<T> {
    this.events.push('arcanum:' + args.join(' '));
    return [] as T;
  }
  override async mounts() {
    this.events.push('helper');
    return [];
  }
  override async withMount<T>(_fn: (mount: string) => Promise<T>): Promise<T> {
    throw new Error('doctor must not allocate a probe copy');
  }
  override async native(args: string[], mount: string) {
    this.events.push('arc:' + args.join(' '));
    expect(mount).toBe('/source-arcadia');
    return JSON.stringify({
      user_login: 'tester',
      hash: 'a'.repeat(40),
      branch: 'trunk',
    });
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
it.each(['metadata', 'activeDiff'] as const)(
  'classifies an Arcanum %s failure before writing',
  async (method) => {
    const bridge = new FakeArc();
    vi.spyOn(bridge, method).mockRejectedValueOnce(new Error('Bridge read failed'));
    await expect(
      new ArcadiaProvider(bridge).createReview(
        ref,
        { ...review.revision, revisionId: undefined },
        review.marker,
      ),
    ).rejects.toBeInstanceOf(ProviderWriteNotAttempted);
    expect(bridge.calls.some((args) => args[1] === 'create-comment')).toBe(false);
  },
);

it('starts a review on the current Arcanum diff after preflight comment reads fail', async () => {
  const bridge = new FakeArc();
  bridge.general = [];
  bridge.inline = [];
  const provider = new ArcadiaProvider(bridge);
  const store = new Store(':memory:');
  const engine = new Engine(store, () => provider);
  try {
    const task = await engine.create({ ref, repoPath: '/tmp', requirements: 'Review the change' });
    bridge.cannotReadComments = true;
    await expect(engine.review(task.id)).rejects.toThrow();
    expect(bridge.calls.some((args) => args[1] === 'create-comment')).toBe(false);
    expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual([]);
    bridge.cannotReadComments = false;
    bridge.base = 'e'.repeat(40);
    bridge.diff = '100';
    const next = await new Engine(store, () => provider).review(task.id, true);
    expect(next).toMatchObject({
      state: 'reviewing',
      review: { nodeId: '100', revision: { base: bridge.base } },
    });
    expect(bridge.calls.filter((args) => args[1] === 'create-comment')).toHaveLength(1);
  } finally {
    store.close();
  }
});
it('parses Arcanum URLs and keeps diff versions in revision identity', () => {
  expect(ref.provider).toBe('arcadia');
  expect(parsePR('https://a.yandex-team.ru/arc/trunk/arcadia/pull/11111111').number).toBe(
    ref.number,
  );
  expect(sameRevision(review.revision, { ...review.revision, revisionId: '100' })).toBe(false);
});

it.each([
  'draft on new diff',
  'lost response',
  'lost response with another draft',
  'lost response after retargeting',
  'lost response then manual publication',
] as const)('retries Arcanum review creation after %s', async (scenario) => {
  const bridge = new FakeArc();
  bridge.general = [];
  bridge.inline = [];
  const provider = new ArcadiaProvider(bridge);
  const store = new Store(':memory:');
  const engine = new Engine(store, () => provider);
  try {
    const task = await engine.create({ ref, repoPath: '/tmp', requirements: 'Check the fix' });
    const started = await engine.review(task.id);
    const old = started.review!;
    store.cancelJobs(task.id);
    store.saveTask({ ...started, state: 'needs_input' });
    bridge.general[0].is_draft = false;
    bridge.general.push({
      id: 104,
      content: tag(`${old.marker}:comment:R2`),
      is_draft: false,
      author: { name: 'tester' },
    });
    bridge.diff = '100';
    const retargeted = scenario === 'lost response after retargeting';
    if (retargeted) {
      bridge.targetBranch = 'release';
    } else {
      const author = store.enqueue(started, 'author', 'fix', 'Save the fix');
      store.saveJob({ ...author, status: 'cancelled' });
      const original = started.revision!;
      bridge.head = 'c'.repeat(40);
      store.event(
        task.id,
        'author.feedback_snapshot',
        { revision: original, targetBranch: 'main' },
        author.id,
      );
      store.event(
        task.id,
        'author.fixes_saved',
        { head: bridge.head, revision: original },
        author.id,
      );
      store.saveTask({ ...store.getTask(task.id), generation: author.generation + 1 });
      expect(await engine.action(task.id, 'resume')).toMatchObject({ state: 'queued' });
    }

    const manual = {
      id: -110,
      content: 'Manual note',
      is_draft: true,
      author: { name: 'tester' },
    };
    if (scenario === 'draft on new diff') {
      bridge.inlineByDiff.set('100', [manual]);
      await expect(engine.review(task.id)).rejects.toMatchObject({ code: 'existing_drafts' });
      expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual(
        [],
      );
      bridge.inlineByDiff.delete('100');
    } else {
      bridge.loseCreateResponse = true;
      await expect(engine.review(task.id, retargeted)).rejects.toThrow('Lost create response');
      expect(
        store.db.prepare("SELECT id FROM operations WHERE status='pending'").all(),
      ).toHaveLength(1);
      bridge.loseCreateResponse = false;
    }
    const restarted = new Engine(store, () => provider);
    if (scenario === 'lost response with another draft') {
      bridge.inlineByDiff.set('100', [manual]);
      expect(await restarted.review(task.id, true)).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining('Arcanum'),
      });
      bridge.inlineByDiff.delete('100');
    }
    if (scenario === 'lost response then manual publication') {
      bridge.general.at(-1)!.is_draft = false;
      const stopped = await restarted.review(task.id, true);
      expect(stopped).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining('already published'),
      });
      expect(stopped.feedback?.comments.map(({ id }) => id)).toEqual(['pr:104']);
      expect(store.busy(task.id)).toBe(false);
    }
    const next = await restarted.review(task.id, true);
    expect(next).toMatchObject({
      state: 'reviewing',
      review: { nodeId: '100', targetBranch: bridge.targetBranch, revision: { head: bridge.head } },
    });
    expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['pr:104']);
    expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(
      scenario === 'lost response then manual publication' ? 3 : 2,
    );
    if (scenario === 'lost response then manual publication') {
      await restarted.completeJob(store.claim()!, {
        status: 'completed',
        summary: 'No new findings',
        checkedHead: bridge.head,
      });
      expect(store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining('not verified'),
      });
    }
    expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual([]);
  } finally {
    store.close();
  }
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

it('reads a recovered Arcanum review on its original diff after retargeting', async () => {
  const bridge = new FakeArc();
  bridge.general = [];
  bridge.inline = [];
  const provider = new ArcadiaProvider(bridge);
  const store = new Store(':memory:');
  const engine = new Engine(store, () => provider);
  try {
    const task = await engine.create({ ref, repoPath: '/tmp', requirements: 'Check the fix' });
    bridge.loseCreateResponse = true;
    await expect(engine.review(task.id)).rejects.toThrow('Lost create response');
    bridge.loseCreateResponse = false;
    const summary = bridge.general[0];
    const note = {
      id: 110,
      content: summary.content.replace(/ -->$/, ':comment:R1 -->'),
      is_draft: true,
      author: summary.author,
    };
    bridge.inlineByDiff.set('99', [note]);
    bridge.targetBranch = 'release';
    bridge.diff = '100';
    const restarted = new Engine(store, () => provider);
    const blocked = await restarted.review(task.id, true);
    expect(blocked).toMatchObject({
      state: 'needs_input',
      review: { nodeId: '99', targetBranch: 'main', revision: { revisionId: '99' } },
    });
    expect(blocked.reason).toContain('release');
    expect(store.busy(task.id)).toBe(false);
    summary.is_draft = false;
    note.is_draft = false;
    const next = await restarted.review(task.id, true);
    expect(next).toMatchObject({
      state: 'reviewing',
      review: { nodeId: '100', targetBranch: 'release' },
    });
    expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['diff:110']);
    expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(2);
  } finally {
    store.close();
  }
});

it.each(['deleted', 'published finding', 'partial'] as const)(
  'continues a completed Arcanum creation without a summary (%s)',
  async (status) => {
    const bridge = new FakeArc();
    bridge.general = [];
    bridge.inline = [];
    const provider = new ArcadiaProvider(bridge);
    const store = new Store(':memory:');
    const engine = new Engine(store, () => provider);
    try {
      const task = await engine.create({ ref, repoPath: '/tmp', requirements: 'Check the change' });
      const previous = await engine.review(task.id);
      store.cancelJobs(task.id);
      store.saveTask(task);
      bridge.general = [];
      const author = { name: 'tester' };
      if (status !== 'deleted')
        bridge.inline.push({
          id: 110,
          content: tag(`${previous.review!.marker}:comment:R1`),
          is_draft: false,
          author,
        });
      const restarted = new Engine(store, () => provider);
      if (status === 'partial') {
        bridge.inline.push({
          id: -111,
          content: tag(`${previous.review!.marker}:comment:R2`),
          is_draft: true,
          author,
        });
        expect(await restarted.review(task.id, true)).toMatchObject({ state: 'needs_input' });
        expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(1);
        bridge.inline.pop();
      }
      const next = await restarted.review(task.id, true);
      expect(next).toMatchObject({ state: 'reviewing', round: 2, revision: task.revision });
      expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(2);
      if (status !== 'deleted')
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['diff:110']);
    } finally {
      store.close();
    }
  },
);
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
    expect(next.feedback?.comments.map(({ id }) => id)).toEqual(
      status === 'published' || status === 'partial' || status === 'orphan published'
        ? ['pr:102', latestFinding]
        : [latestFinding],
    );
    expect(bridge.calls.filter((call) => call[1] === 'create-comment')).toHaveLength(2);
  } finally {
    store.close();
  }
});

it('checks Arcanum, the helper and journals without allocating a probe copy', async () => {
  const bridge = new DoctorArc();
  await expect(bridge.doctor()).resolves.toMatchObject({ user_login: 'tester' });
  expect(bridge.events).toEqual([
    'sources',
    'arcanum:repo list --fields repos(id)',
    'helper',
    'arc:info --json',
  ]);
});
