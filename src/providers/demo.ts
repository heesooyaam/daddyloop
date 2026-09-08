import { randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import {
  AppError,
  type PRRef,
  type PullRequest,
  type Revision,
  type ReviewHandle,
  type ReviewSnapshot,
  type Location,
} from '../core/types.js';
import { type ReviewProvider, tag } from './provider.js';
export class DemoProvider implements ReviewProvider {
  constructor(private store: Store) {}
  async getPR(ref: PRRef): Promise<PullRequest> {
    return (
      this.store.setting<PullRequest>(`demo-pr:${ref.number}`) ?? {
        title: 'Prevent stale session callbacks',
        body: 'Ignore callbacks belonging to a replaced session.',
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        start: 'b'.repeat(40),
        branch: 'fix/session-generation',
        targetBranch: 'main',
        cloneUrl: '',
        state: 'open',
        checks: 'passing',
        checkDetails: [{ name: 'Unit tests · demo fixture', status: 'success' }],
      }
    );
  }
  async advance(ref: PRRef) {
    const pr = await this.getPR(ref);
    pr.head = randomUUID().replaceAll('-', '') + '12345678';
    this.store.setSetting(`demo-pr:${ref.number}`, pr);
  }
  async findReview(_ref: PRRef, marker: string) {
    return this.store.setting<ReviewHandle>(`demo-handle:${marker}`);
  }
  async createReview(ref: PRRef, revision: Revision, marker: string) {
    const handle = { id: randomUUID(), marker, revision };
    this.store.setSetting(`demo-handle:${marker}`, handle);
    this.store.setSetting(`demo-review:${handle.id}`, {
      status: 'draft',
      body: tag(marker),
      comments: [],
      url: ref.url,
      revision,
    });
    return handle;
  }
  async getReview(_ref: PRRef, review: ReviewHandle) {
    const snapshot = this.store.setting<ReviewSnapshot>(`demo-review:${review.id}`);
    if (!snapshot) throw new AppError('not_found', 'Demo review not found', 404);
    return snapshot;
  }
  async createComment(
    ref: PRRef,
    review: ReviewHandle,
    body: string,
    marker: string,
    location?: Location,
  ) {
    const snapshot = await this.getReview(ref, review),
      item = {
        id: randomUUID(),
        body: `${body}\n\n${tag(marker)}`,
        marker,
        url: ref.url,
        location,
      };
    snapshot.comments.push(item);
    this.save(review, snapshot);
    return item;
  }
  async updateComment(ref: PRRef, review: ReviewHandle, id: string, body: string) {
    const s = await this.getReview(ref, review),
      c = s.comments.find((c) => c.id === id);
    if (!c) throw new AppError('not_found', 'Comment not found', 404);
    c.body = body;
    this.save(review, s);
    return c;
  }
  async deleteComment(ref: PRRef, review: ReviewHandle, id: string) {
    const s = await this.getReview(ref, review);
    s.comments = s.comments.filter((c) => c.id !== id);
    this.save(review, s);
  }
  async updateSummary(ref: PRRef, review: ReviewHandle, body: string) {
    const s = await this.getReview(ref, review);
    s.body = body + '\n\n' + tag(review.marker);
    this.save(review, s);
  }
  async publish(ref: PRRef, review: ReviewHandle) {
    const s = await this.getReview(ref, review);
    s.status = 'published';
    this.save(review, s);
  }
  private save(review: ReviewHandle, snapshot: ReviewSnapshot) {
    this.store.setSetting(`demo-review:${review.id}`, snapshot);
  }
}
