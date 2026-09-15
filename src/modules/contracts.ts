import type {
  AgentProfile,
  PRRef,
  Task,
  TicketSource,
  TicketRef,
  ReviewGroup,
} from '../core/types.js';
import type { AgentUsage } from '../core/usage.js';
import type { ModelOption, ModelCatalogueInfo } from '../core/agents.js';
import type { AgentRuntime, SessionRuntime } from '../runtime/agent.js';
import type { ReviewProvider } from '../providers/provider.js';
import type { Store } from '../core/store.js';
import type { TicketReader } from './repositories/tickets.js';
import type { Workspaces } from '../runtime/workspaces.js';
import type { ArcBridge } from '../integrations/arcadia.js';
import type { WorkspaceRegistry } from '../core/workspace-registry.js';

/** The scheduler speaks this contract; engines own their CLI protocol and model catalogue. */
export interface AgentCatalogue {
  list(refresh?: boolean, signal?: AbortSignal): Promise<ModelOption[]>;
  validate(profile: AgentProfile): Promise<void>;
  metadata?(): ModelCatalogueInfo;
  engines?(): { id: string; name: string }[];
}
export interface AgentInstallation {
  executable: string;
  version: string;
}
export interface AgentPackage {
  version: string;
  platform: string;
  url: string;
  integrity: string;
}
/** Native packaging and validation belong to the adapter; activation belongs to the host. */
export interface AgentCli {
  name: string;
  executable(): string;
  releaseUrl: string;
  probe(executable: string, signal: AbortSignal): Promise<AgentInstallation>;
  latestVersion(signal: AbortSignal): Promise<string>;
  validate(
    executable: string,
    signal: AbortSignal,
  ): Promise<{ version?: string; models: ModelOption[] }>;
  diagnose?(signal: AbortSignal): Promise<Record<string, unknown>>;
  updates?: {
    unavailableReason?: string;
    latest(signal: AbortSignal): Promise<AgentPackage>;
    install(
      pkg: AgentPackage,
      root: string,
      signal: AbortSignal,
      resourceCheck: () => void,
    ): Promise<string>;
  };
}
export interface AgentModule {
  id: string;
  name: string;
  runtime: AgentRuntime & SessionRuntime;
  catalogue: AgentCatalogue;
  usage?: AgentUsage;
  cli?: AgentCli;
}
export interface SubmissionContext {
  reader: TicketReader;
  workspaces: Workspaces;
  arc: ArcBridge;
}
/** Native writes still execute inside the engine's durable outbox and revision fences. */
export interface SubmissionBackend {
  owner(task: Task): Promise<string>;
  prepare(task: Task): Promise<void>;
  create(task: Task, title: string, body: string): Promise<PRRef>;
  find(task: Task, marker: string, owner: string): Promise<PRRef | undefined>;
}
export interface WorkspaceBackupSink {
  readonly dataDir?: string;
  file(path: string, source: string): Promise<void>;
  text(path: string, content: string): Promise<void>;
  warning(message: string): void;
}
export interface RepositoryModule {
  id: string;
  name: string;
  acceptsTicket?(input: string): boolean;
  readTicket?(
    input: string,
    reader: TicketReader,
  ): Promise<{ source: TicketSource; ref: TicketRef }>;
  vcs: 'git' | 'arcadia';
  backupWorkspace?(task: Task, sink: WorkspaceBackupSink): Promise<void>;
  matchesRepository(input: { vcs: 'git' | 'arcadia'; host: string; remotes: string[] }): number;
  parsePR(url: URL): PRRef | undefined;
  review(ref: PRRef, store: Store): ReviewProvider;
  submission(context: SubmissionContext): SubmissionBackend;
  sessionWorkspace?(context: SessionWorkspaceContext): SessionWorkspaceBackend;
}

export interface SessionWorkspaceContext {
  dataDir: string;
  store: Store;
  registry: WorkspaceRegistry;
  checkouts: Workspaces;
}
/** Native allocation and removal belong to the repository module; the host stops runs first. */
export interface SessionWorkspaceBackend {
  prepare(group: ReviewGroup, signal: AbortSignal): Promise<{ path: string }>;
  remove(group: ReviewGroup): Promise<{ archivePath?: string }>;
}
