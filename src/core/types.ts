export type ProviderName = string;
export type Role = 'author' | 'reviewer';
export type State =
  | 'discussing'
  | 'implementing'
  | 'ready_for_review'
  | 'submitting'
  | 'queued'
  | 'reviewing'
  | 'awaiting_publication'
  | 'fixing'
  | 'awaiting_push'
  | 'awaiting_merge'
  | 'awaiting_checks'
  | 'awaiting_plan_approval'
  | 'needs_input'
  | 'paused'
  | 'complete';
export interface Policy {
  planApproval: 'human' | 'auto';
  maxNoProgress: number;
  requireChecks: boolean;
}
export const defaultPolicy: Policy = {
  planApproval: 'human',
  maxNoProgress: 2,
  requireChecks: true,
};
export interface PRRef {
  kind?: 'pull_request';
  provider: ProviderName;
  host: string;
  repo: string;
  number: number;
  url: string;
}
export interface TicketRef extends Omit<PRRef, 'kind'> {
  kind: 'ticket';
  key: string;
}
export type TaskRef = PRRef | TicketRef;
/** Validated against the selected CLI model catalogue before use. */
export type ReasoningEffort = string;
export interface AgentProfile {
  engine: string;
  model?: string;
  effort?: ReasoningEffort;
}
export function sameAgentProfile(a: AgentProfile | undefined, b: AgentProfile) {
  return a?.engine === b.engine && a.model === b.model && a.effort === b.effort;
}
export interface AgentProfiles {
  worker: AgentProfile;
  daddy: AgentProfile;
}
export interface WorkerRequest {
  slot?: number;
  profile?: AgentProfile;
}
export interface WorkerSlot {
  number: number;
  taskId?: string;
  /** Model to use for the next task. */
  profile?: AgentProfile;
}
export interface TicketSource {
  kind: 'github_issue' | 'tracker' | 'local';
  key: string;
  url: string;
  title: string;
  body: string;
  state: string;
  fetchedAt: string;
  updatedAt?: string;
  comments?: { id: string; author: string; body: string }[];
}
export type PRTask = Task & { ref: PRRef };
export type AutoMergeMode = 'inherit' | 'on' | 'off';
export interface ReviewGroup {
  titleSource?: 'placeholder' | 'goal' | 'manual';
  resourceWait?: { reasons: string[]; since: string; state: 'waiting' | 'repairing' | 'blocked' };
  instructions?: import('./instructions.js').SessionInstructions;
  id: string;
  title: string;
  requirements: string;
  source?: TicketSource;
  rootTaskId: string;
  daddy: AgentProfile;
  reviewerThreadId?: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  orchestrated?: boolean;
  workerLimit?: number;
  requestedWorkerLimit?: number;
  /** The occupied task list from stores created before numbered slots. */
  workerTasks?: string[];
  /** Occupied slots survive author turns, review, pauses and restarts. */
  workerSlots?: WorkerSlot[];
  /** Snapshot: later edits to workspace defaults affect new sessions only. */
  workspace?: Workspace;
  worker?: AgentProfile;
  daddyState?: 'active' | 'paused' | 'needs_input' | 'archived';
  summary?: string;
  autoTurns?: number;
  daddyThreadId?: string;
  daddyToolSignature?: string;
  parentGroupId?: string;
  createdByAction?: string;
  workspacePreparation?: {
    state: 'pending' | 'preparing' | 'ready' | 'error';
    path?: string;
    error?: string;
  };
  deletion?: {
    state: 'pending' | 'running' | 'error' | 'complete';
    archivePath?: string;
    error?: string;
  };
  deletedAt?: string;
}
export interface Workspace {
  id: string;
  name: string;
  /** Canonical Git URL or absolute path to a local Git/Arcadia source. */
  repoPath: string;
  scope: string;
  vcs: 'git' | 'arcadia';
  provider: ProviderName;
  host: string;
  repo: string;
  base?: string;
  copyMode?: 'session' | 'pool';
  createdAt: string;
  updatedAt: string;
}
export interface DaddyJob {
  firstAttemptId?: string;
  instructions?: import('./instructions.js').AgentInstructions;
  id: string;
  groupId: string;
  generation: number;
  trigger: 'user' | 'worker' | 'recovery' | 'resources';
  waitingTaskId?: string;
  input: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  profile: AgentProfile;
  workspace?: Workspace;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  notBefore?: string;
}
export interface Revision {
  head: string;
  base: string;
  start: string;
  revisionId?: string;
}
export interface PullRequest extends Revision {
  draft?: boolean;
  mergeable?: boolean | null;
  mergeConflict?: boolean;
  targetCloneUrl?: string;
  mergeCommit?: string;
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
  nodeId?: string;
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
  authorId?: string;
  status: 'draft' | 'published' | 'missing' | 'partial';
  body: string;
  comments: ReviewComment[];
  url: string;
  revision: Revision;
}
export interface Task {
  inputRequest?: { runId: string; role: Role; generation: number };
  resourcePause?: { generation: number; at: string };
  id: string;
  title: string;
  requirements: string;
  kind: 'plan' | 'code';
  ref: TaskRef;
  source?: TicketSource;
  groupId?: string;
  parentTaskId?: string;
  workspaceId?: string;
  scope?: string;
  dependsOn?: string[];
  createdByAction?: string;
  agents?: AgentProfiles;
  workerRequest?: WorkerRequest;
  ticketRepository?: { baseHead: string; baseBranch: string; cloneUrl?: string; branch: string };
  repoPath: string;
  policy: Policy;
  workspaceIsolation?: 'session' | 'pool';
  state: State;
  reason: string;
  generation: number;
  contextVersion: number;
  round: number;
  noProgress: number;
  revision?: Revision;
  pr?: PullRequest;
  review?: ReviewHandle;
  partialReview?: {
    reviewId: string;
    runId: string;
    question?: string;
    limitation: string;
    retryAt?: number;
  };
  draftRecheck?: { commentIds: string[]; retried?: boolean };
  snapshot?: ReviewSnapshot;
  workerReport?: { runId: string; revision: Revision };
  summary: string;
  authorThreadId?: string;
  reviewerThreadId?: string;
  reviewFinished?: boolean;
  verifiedMerge?: Revision & { mergeCommit?: string };
  authorWorktree?: string;
  authorBaseHead?: string;
  pendingAuthorHead?: string;
  fixingMergeConflict?: boolean;
  conflictCheckpoint?: string;
  deferredWorkerInstructions?: { id: string; text: string }[];
  pendingFix?: { revision: Revision; attempted?: boolean; confirmUntil?: string };
  reviewerWorktree?: string;
  arcWorkspaces?: Partial<
    Record<
      Role,
      {
        mount: string;
        ownerId: string;
        objectStore: string;
        managed?: { sessionId: string; taskId: string; role: Role };
        initialHash: string;
        initialBranch: string;
        baseHead: string;
        prepared?: boolean;
        targetBranch?: string;
      }
    >
  >;
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
  needsReply?: boolean;
  phase?: 'progress' | 'final';
  /** Used to mirror a conversation without echoing a Telegram message back into its own topic. */
  origin?: { channel: 'telegram'; chatId: number; threadId?: number };
  workspace?: Workspace;
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
  instructions?: import('./instructions.js').AgentInstructions;
  id: string;
  taskId: string;
  generation: number;
  role: Role;
  kind: 'review' | 'fix' | 'chat' | 'implement' | 'verify_merge';
  freshContextRetry?: boolean;
  timeoutRetry?: boolean;
  deferredResult?: AgentResult;
  errorCode?: string;
  profile?: AgentProfile;
  groupId?: string;
  groupGeneration?: number;
  input: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  threadId?: string;
  turnId?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  actionId?: string;
  firstAttemptId?: string;
  notBefore?: string;
}
export function requestsHumanInput(result: AgentResult) {
  return (
    result.status === 'needs_input' || (result.status === 'incomplete' && !!result.question?.trim())
  );
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
  hostMemoryAvailableGiB?: number;
  memoryScope?: 'host' | 'service';
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
export interface ExpectedTask {
  head: string;
  generation: number;
  groupId?: string;
}
export function assertTaskVersion(task: Task, expected?: ExpectedTask) {
  if (
    expected &&
    (task.revision?.head !== expected.head ||
      task.generation !== expected.generation ||
      (expected.groupId !== undefined && task.groupId !== expected.groupId))
  )
    throw new AppError('stale_task', 'The task changed. Refresh it before confirming this action.');
}
export const isTicket = (task: Task) => task.ref.kind === 'ticket';
export function prRef(task: Task): PRRef {
  if (task.ref.kind === 'ticket')
    throw new AppError('pr_required', 'Submit or attach a PR before starting native review');
  return task.ref;
}
export const sameRevision = (a?: Revision, b?: Revision) =>
  !!a &&
  !!b &&
  a.head === b.head &&
  a.base === b.base &&
  a.start === b.start &&
  a.revisionId === b.revisionId;
export const revisionOf = (value: Revision): Revision => ({
  head: value.head,
  base: value.base,
  start: value.start,
  ...(value.revisionId ? { revisionId: value.revisionId } : {}),
});
