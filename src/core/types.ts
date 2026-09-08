export type ProviderName = 'github' | 'gitlab' | 'demo';
export type Role = 'author' | 'reviewer';
export type State =
  | 'queued'
  | 'reviewing'
  | 'awaiting_publication'
  | 'fixing'
  | 'awaiting_push'
  | 'awaiting_checks'
  | 'awaiting_plan_approval'
  | 'needs_input'
  | 'paused'
  | 'complete';
export interface Policy {
  publication: 'human' | 'auto';
  planApproval: 'human' | 'auto';
  maxRounds: number;
  maxNoProgress: number;
  requireChecks: boolean;
  autoPush: boolean;
}
export const defaultPolicy: Policy = {
  publication: 'human',
  planApproval: 'human',
  maxRounds: 3,
  maxNoProgress: 2,
  requireChecks: true,
  autoPush: true,
};
export interface PRRef {
  provider: ProviderName;
  host: string;
  repo: string;
  number: number;
  url: string;
}
export interface Revision {
  head: string;
  base: string;
  start: string;
}
export interface PullRequest extends Revision {
  title: string;
  body: string;
  branch: string;
  targetBranch: string;
  cloneUrl: string;
  state: 'open' | 'closed' | 'merged';
  checks: 'passing' | 'pending' | 'failing' | 'missing';
  checkDetails: { name: string; status: string; url?: string }[];
}
export interface Location {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  oldPath?: string;
  startLine?: number;
}
export interface ReviewComment {
  id: string;
  body: string;
  url: string;
  location?: Location;
  marker?: string;
  author?: string;
  resolved?: boolean;
}
export interface ReviewHandle {
  id: string;
  nodeId?: string;
  marker: string;
  revision: Revision;
  authorId?: string;
  createdAt?: string;
  baselineNoteId?: number;
}
export interface ReviewSnapshot {
  status: 'draft' | 'published' | 'missing' | 'partial';
  body: string;
  comments: ReviewComment[];
  url: string;
  revision: Revision;
}
export interface Task {
  id: string;
  title: string;
  requirements: string;
  kind: 'plan' | 'code';
  ref: PRRef;
  repoPath: string;
  policy: Policy;
  state: State;
  reason: string;
  generation: number;
  contextVersion: number;
  round: number;
  noProgress: number;
  revision?: Revision;
  pr?: PullRequest;
  review?: ReviewHandle;
  snapshot?: ReviewSnapshot;
  summary: string;
  authorThreadId?: string;
  reviewerThreadId?: string;
  reviewFinished?: boolean;
  authorWorktree?: string;
  authorBaseHead?: string;
  pendingAuthorHead?: string;
  reviewerWorktree?: string;
  planTaskId?: string;
  planDocuments?: { path: string; body: string }[];
  approvedPlan?: {
    taskId: string;
    head: string;
    contextVersion: number;
    requirements: string;
    documents: { path: string; body: string }[];
  };
  approvedAt?: string;
  checksWaivedAt?: string;
  resumeState?: State;
  lastFeedbackHash?: string;
  feedback?: ReviewSnapshot;
  createdAt: string;
  updatedAt: string;
}
export interface Event {
  id: number;
  taskId: string;
  runId?: string;
  type: string;
  data: unknown;
  at: string;
}
export interface Message {
  id: string;
  taskId: string;
  role: Role;
  sender: 'user' | 'agent' | 'system';
  text: string;
  runId?: string;
  at: string;
}
export interface Decision {
  id: string;
  taskId: string;
  commentId?: string;
  outcome: 'withdrawn' | 'deferred' | 'rejected' | 'accepted' | 'verified' | 'disputed';
  reason: string;
  head: string;
  at: string;
}
export interface Job {
  id: string;
  taskId: string;
  generation: number;
  role: Role;
  kind: 'review' | 'fix' | 'chat';
  input: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  threadId?: string;
  turnId?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}
export interface AgentResult {
  status: 'completed' | 'needs_input' | 'incomplete';
  summary: string;
  checkedHead: string;
  question?: string;
  verifiedCommentIds?: string[];
  disputedCommentIds?: string[];
}
export interface ResourceStatus {
  memoryAvailableGiB: number;
  memoryTotalGiB: number;
  diskAvailableGiB: number;
  diskUsedPercent: number;
  ok: boolean;
  reasons: string[];
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export const now = () => new Date().toISOString();
export const sameRevision = (a?: Revision, b?: Revision) =>
  !!a && !!b && a.head === b.head && a.base === b.base && a.start === b.start;
