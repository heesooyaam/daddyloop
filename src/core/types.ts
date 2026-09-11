export type ProviderName = 'github' | 'gitlab' | 'arcadia' | 'demo';
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
  publication: 'auto',
  planApproval: 'human',
  maxRounds: 3,
  maxNoProgress: 2,
  requireChecks: true,
  autoPush: true,
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
  engine: 'codex';
  model?: string;
  effort?: ReasoningEffort;
}
export interface AgentProfiles {
  writer: AgentProfile;
  daddy: AgentProfile;
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
export interface ReviewGroup {
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
  writerLimit?: number;
  requestedWriterLimit?: number;
  /** Occupied slots survive author turns, review, pauses and restarts. */
  writerTasks?: string[];
  /** Snapshot: later edits to workspace defaults affect new sessions only. */
  workspace?: Workspace;
  writer?: AgentProfile;
  daddyState?: 'active' | 'paused' | 'needs_input' | 'archived';
  summary?: string;
  autoTurns?: number;
  daddyThreadId?: string;
  daddyToolSignature?: string;
  parentGroupId?: string;
  createdByAction?: string;
  defaultPolicy?: Pick<Policy, 'publication' | 'autoPush'>;
}
export interface Workspace {
  id: string;
  name: string;
  repoPath: string;
  scope: string;
  vcs: 'git' | 'arcadia';
  provider: 'github' | 'gitlab' | 'arcadia';
  host: string;
  repo: string;
  base?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DaddyJob {
  id: string;
  groupId: string;
  generation: number;
  trigger: 'user' | 'worker' | 'recovery';
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
  ref: TaskRef;
  source?: TicketSource;
  groupId?: string;
  parentTaskId?: string;
  workspaceId?: string;
  scope?: string;
  dependsOn?: string[];
  createdByAction?: string;
  agents?: AgentProfiles;
  ticketRepository?: { baseHead: string; baseBranch: string; cloneUrl?: string; branch: string };
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
  arcWorkspaces?: Partial<
    Record<
      Role,
      {
        mount: string;
        ownerId: string;
        objectStore: string;
        initialHash: string;
        initialBranch: string;
        baseHead: string;
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
  id: string;
  taskId: string;
  generation: number;
  role: Role;
  kind: 'review' | 'fix' | 'chat' | 'implement';
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
  notBefore?: string;
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
