import { GitHubRetryError } from '../providers/github-quota.js';
import { AppError, type ReviewSnapshot } from './types.js';

/** GitHub can temporarily return an incomplete snapshot on a successful read. */
export function assertConsistentReview(
  previous: ReviewSnapshot | undefined,
  current: ReviewSnapshot,
  placeholder?: string,
) {
  const visibleIds = new Set(current.comments.map((comment) => comment.id));
  const incomplete = previous?.comments.some((comment) => !visibleIds.has(comment.id));
  if (
    incomplete ||
    (placeholder &&
      previous?.status === 'draft' &&
      previous.body !== placeholder &&
      current.status === 'draft' &&
      current.body === placeholder) ||
    (current.status === 'missing' && !current.authorId) ||
    (previous?.status === 'published' && current.status !== 'published' && !current.dismissed)
  )
    throw new GitHubRetryError(
      'github_read_unavailable',
      'Waiting for GitHub to confirm the status and known findings of the original review.',
      Date.now() + 15000,
      false,
      503,
    );
}

export function assertReviewNotDismissed(current: ReviewSnapshot) {
  if (current.dismissed)
    throw new AppError(
      'draft_dismissed',
      'GitHub dismissed the original review. Inspect the preserved review before continuing.',
    );
}
