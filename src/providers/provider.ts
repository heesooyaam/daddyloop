import { allRepositories } from '../modules/repositories/index.js';
import {
  AppError,
  ProviderWriteNotAttempted,
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
  findReview(
    ref: PRRef,
    marker: string,
    intent?: { revision: Revision; targetBranch?: string },
  ): Promise<ReviewHandle | undefined>;
  createReview(ref: PRRef, revision: Revision, marker: string): Promise<ReviewHandle>;
  prepareReviewCreation?(
    ref: PRRef,
    revision: Revision,
    marker: string,
  ): Promise<{ baselineNoteId: number; write: () => Promise<ReviewHandle> }>;
  getReview(
    ref: PRRef,
    review: ReviewHandle,
    successor?: ReviewHandle,
    retired?: readonly ReviewHandle[],
  ): Promise<ReviewSnapshot>;
  createComment(
    ref: PRRef,
    review: ReviewHandle,
    body: string,
    marker: string,
    location?: Location,
  ): Promise<ReviewComment>;
  updateComment(ref: PRRef, review: ReviewHandle, id: string, body: string): Promise<ReviewComment>;
  deleteComment(ref: PRRef, review: ReviewHandle, id: string): Promise<void>;
  updateSummary(ref: PRRef, review: ReviewHandle, body: string): Promise<void>;
  publish(ref: PRRef, review: ReviewHandle): Promise<void>;
}
export const tag = (marker: string) => `<!-- ${marker} -->`;

export function reviewPreparationError(
  error: unknown,
  provider: string,
): ProviderWriteNotAttempted {
  if (error instanceof ProviderWriteNotAttempted) return error;
  if (error instanceof AppError)
    return new ProviderWriteNotAttempted(error.code, error.message, error.statusCode);
  return new ProviderWriteNotAttempted(
    'provider_shape',
    `Could not read ${provider} review information before creating a draft.`,
    502,
  );
}

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
