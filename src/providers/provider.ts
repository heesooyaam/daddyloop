import { allRepositories } from '../modules/repositories/index.js';
import {
  AppError,
  type PRRef,
  type PullRequest,
  type ReviewHandle,
  type ReviewSnapshot,
  type ReviewComment,
  type Location,
  type Revision,
} from '../core/types.js';

export interface ReviewProvider {
  getPR(ref: PRRef): Promise<PullRequest>;
  targetAdvanced?(ref: PRRef, before: string, after: string): Promise<boolean>;
  prepareMerge?(ref: PRRef): Promise<(expectedHead: string) => Promise<string>>;
  findReview(ref: PRRef, marker: string): Promise<ReviewHandle | undefined>;
  prepareDraftReview?(
    ref: PRRef,
    revision: Revision,
    marker: string,
    authorId?: string,
    reconcileOnly?: boolean,
  ): Promise<{
    authorId: string;
    existing?: ReviewHandle;
    requiresInspection?: boolean;
    occupied?: boolean;
    create: () => Promise<ReviewHandle>;
  }>;
  createReview(
    ref: PRRef,
    revision: Revision,
    marker: string,
    confirmOwner?: (owner: string) => Promise<void>,
  ): Promise<ReviewHandle>;
  getReview(ref: PRRef, review: ReviewHandle): Promise<ReviewSnapshot>;
  reviewDeleted?(ref: PRRef, review: ReviewHandle): Promise<boolean>;
  prepareDraftDeletion?(
    ref: PRRef,
    review: ReviewHandle,
    snapshot: ReviewSnapshot,
    checkPR?: () => Promise<void>,
  ): Promise<() => Promise<void>>;
  createComment(
    ref: PRRef,
    review: ReviewHandle,
    body: string,
    marker: string,
    location?: Location,
  ): Promise<ReviewComment>;
  updateComment(
    ref: PRRef,
    review: ReviewHandle,
    id: string,
    body: string,
    current?: ReviewComment,
  ): Promise<ReviewComment>;
  deleteComment(
    ref: PRRef,
    review: ReviewHandle,
    id: string,
    current?: ReviewComment,
  ): Promise<void>;
  updateSummary(ref: PRRef, review: ReviewHandle, body: string): Promise<void>;
  publish(ref: PRRef, review: ReviewHandle): Promise<void>;
}
export const tag = (marker: string) => `<!-- ${marker} -->`;
export function parsePR(url: string, provider?: string): PRRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('invalid_url', 'Enter a full GitHub PR or GitLab MR URL', 400);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  )
    throw new AppError(
      'invalid_url',
      'Use a clean HTTPS PR URL without credentials, port, query or fragment',
      400,
    );
  return allRepositories().parse(parsed, provider);
}

export function assertDraft(snapshot: ReviewSnapshot) {
  if (snapshot.status !== 'draft')
    throw new AppError(
      'review_not_draft',
      'This review is no longer a draft. Reconcile the task before making changes.',
    );
}
