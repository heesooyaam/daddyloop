import { findingVersion } from '../src/core/review-decisions.js';
import { it, expect, vi } from 'vitest';
import { ArcadiaProvider } from '../src/providers/arcadia.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { parsePR, tag } from '../src/providers/provider.js';
import { sameRevision, type ReviewHandle } from '../src/core/types.js';
class FakeArc extends ArcBridge {
  calls: string[][] = [];
  general = [
    { id: -7, content: tag('daddyloop:test'), is_draft: true, author: { name: 'tester' } },
  ];
  inline = [
    {
      id: -9,
      anchor: { file_path: 'file.cpp', line: 5, size: 5, side: 'new' },
      content: 'Exact markdown\n```cpp\nreturn;\n```\n' + tag('daddyloop:test:comment:R1'),
      is_draft: true,
      author: { name: 'tester' },
    },
  ];
  override async api<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    if (args[1] === 'comments') return (args[0] === 'pr' ? this.general : this.inline) as T;
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

it('keeps the native Arcanum range in the version of a published finding', async () => {
  const bridge = new FakeArc();
  bridge.general[0].is_draft = false;
  bridge.inline[0].is_draft = false;
  const provider = new ArcadiaProvider(bridge);
  const before = (await provider.getReview(ref, review)).comments[0];
  bridge.inline[0].anchor.size = 3;
  const after = (await provider.getReview(ref, review)).comments[0];
  expect(before.location).toMatchObject({ startLine: 5, line: 9 });
  expect(after.location).toMatchObject({ startLine: 5, line: 7 });
  expect(findingVersion(after)).not.toBe(findingVersion(before));
});

it('checks the head reported by the active diff before reading its checks', async () => {
  const head = 'c'.repeat(40);
  const bridge = new FakeArc();
  vi.spyOn(bridge, 'metadata').mockResolvedValue({
    pr: {
      from_id: head,
      from_branch: 'users/me/fix',
      to_branch: 'trunk',
      status: 'open',
      summary: 'Fix',
    },
    base: review.revision.base,
    user: 'tester',
  } as Awaited<ReturnType<ArcBridge['metadata']>>);
  let active = { id: 101, commit_ids: { head: review.revision.head } };
  const calls: string[][] = [];
  bridge.api = async <T>(args: string[]) => {
    calls.push(args);
    return (args[1] === 'get' ? active : { checks: [] }) as T;
  };
  const provider = new ArcadiaProvider(bridge);
  await expect(provider.getPR(ref)).rejects.toMatchObject({ code: 'diff_unavailable' });
  expect(calls).toEqual([
    ['diff', 'get', '--pr', String(ref.number), '--fields', 'id,commit_ids(head)'],
  ]);
  active = { id: 103, commit_ids: { head } };
  expect(await provider.getPR(ref)).toMatchObject({ head, revisionId: '103', diffHead: head });
  expect(calls.at(-1)).toContain('103');
  active = { id: 101, commit_ids: { head: review.revision.head } };
  calls.length = 0;
  await expect(
    provider.createReview(ref, { ...review.revision, head, revisionId: '103' }, 'test'),
  ).rejects.toMatchObject({ code: 'diff_unavailable' });
  expect(calls.every((args) => args[1] === 'get')).toBe(true);
});
