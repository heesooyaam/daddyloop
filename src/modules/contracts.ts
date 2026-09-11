import type { AgentProfile, PRRef, Task, TicketSource, TicketRef } from '../core/types.js';
import type { AgentUsage } from '../core/usage.js';
import type { ModelOption, ModelCatalogueInfo } from '../core/agents.js';
import type { AgentRuntime, SessionRuntime } from '../runtime/agent.js';
import type { ReviewProvider } from '../providers/provider.js';
import type { Store } from '../core/store.js';
import type { TicketReader } from './repositories/tickets.js';
import type { Workspaces } from '../runtime/workspaces.js';
import type { ArcBridge } from '../integrations/arcadia.js';

/** The scheduler speaks this contract; engines own their CLI protocol and model catalogue. */
export interface AgentCatalogue {
  list(refresh?: boolean, signal?: AbortSignal): Promise<ModelOption[]>;
  validate(profile: AgentProfile): Promise<void>;
  metadata?(): ModelCatalogueInfo;
  engines?(): { id: string; name: string }[];
}
export interface AgentModule {
  id: string;
  name: string;
  runtime: AgentRuntime & SessionRuntime;
  catalogue: AgentCatalogue;
  usage?: AgentUsage;
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
}
