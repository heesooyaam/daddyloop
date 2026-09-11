import { it, expect } from 'vitest';
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
