import { z } from 'zod';
import type { RuntimeTool } from '../runtime/agent.js';
import { profileSchema } from './agents.js';
const id = z.string().uuid(),
  text = z.string().trim().min(1).max(20000);
export const daddySchemas = {
  create_session: z
    .object({ title: z.string().trim().min(1).max(200), goal: text, workspaceId: id.optional() })
    .strict(),
  read_conversation: z
    .object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(30),
    })
    .strict(),
  read_board: z.object({}).strict(),
  list_workspaces: z.object({}).strict(),
  list_models: z.object({}).strict(),
  read_task: z.object({ taskId: id }).strict(),
  import_ticket: z
    .object({ source: z.string().min(1).max(2048), workspaceId: id.optional() })
    .strict(),
  attach_review: z
    .object({
      url: z.string().url().max(2048),
      workspaceId: id.optional(),
      requirements: text.optional(),
    })
    .strict(),
  create_task: z
    .object({
      source: z.string().url().max(2048).optional(),
      title: z.string().trim().min(1).max(200),
      requirements: text,
      architecturePlan: text.optional(),
      reportOnly: z.boolean().optional(),
      validatePlan: z.boolean().optional(),
      architectProfile: profileSchema.optional(),
      workspaceId: id.optional(),
      dependsOn: z.array(id).max(20).optional(),
    })
    .strict(),
  dispatch: z
    .object({
      taskId: id,
      instruction: text.optional(),
      validatePlan: z.boolean().optional(),
      architectProfile: profileSchema.optional(),
    })
    .strict(),
  message_worker: z.object({ taskId: id, instruction: text }).strict(),
  set_dependencies: z.object({ taskId: id, dependsOn: z.array(id).max(20) }).strict(),
  pause_task: z.object({ taskId: id, reason: text }).strict(),
  resume_task: z.object({ taskId: id }).strict(),
  submit_task: z.object({ taskId: id }).strict(),
  retry_review: z.object({ taskId: id, clarification: text.optional() }).strict(),
  set_architect_model: z.object({ taskId: id, profile: profileSchema.nullable() }).strict(),
  set_worker_model: z.object({ taskId: id, profile: profileSchema }).strict(),
};
const descriptions: Record<keyof typeof daddySchemas, string> = {
  create_session:
    'Create an independent daddy session in a workspace ONLY when the user explicitly asks for a new session/conversation. In Telegram it gets a NEW topic; the current topic keeps its session. Use create_task for more work in the current session. The supplied goal starts the new conversation.',
  read_conversation:
    'Read saved messages in this session, newest first, using offset and limit. Use this to recover earlier requirements beyond the recent context. It never exposes native private-review messages.',
  read_board:
    'Read this daddy session: tasks, dependencies, worker capacity and current jobs. Inspect before dispatching.',
  list_workspaces:
    'List repositories the user registered on this server. Choose only these workspace IDs.',
  list_models:
    'Read the enabled agent model catalogues and supported reasoning efforts before choosing a different worker model.',
  read_task:
    'Read a task in this session, including its worker reports and pinned native review status.',
  import_ticket:
    'Read a GitHub issue or Yandex Tracker ticket and add it to this session. Does not start a worker or write to the tracker.',
  attach_review:
    'Attach an existing GitHub/GitLab/Arcadia pull request to this daddy session for its native review/fix workflow. The workspace must match the native repository.',
  create_task:
    'Create a concrete task. For coding work always supply architecturePlan in the user’s language: the agreed design, affected components, steps and acceptance checks. On GitHub the service records this brief in an issue before queueing the local task. For a report-only request set reportOnly=true to omit the coding brief. Set validatePlan=true when the user asks for a separate planning pass. For an existing GitHub issue or newly created sub-issue, pass its canonical issue URL in source (one task per issue). Choose a registered workspace and optional dependencies. Does not start a worker.',
  dispatch:
    'Start work on a ready task. validatePlan can explicitly enable or disable the extra architecture check. Coordinator-created tasks normally use the agreed ticket plan directly. The service enforces dependencies and worker limits. Work without code changes goes through a report review. Saved code changes go through native PR review.',
  message_worker:
    'Send scoped instructions to the task worker. When an author asks a question and the answer is already in the session, send the decision here to resume that fix. Results return to daddy.',
  set_dependencies:
    'Set prerequisites before initial dispatch or while a native correction waits. The assigned worker and corrective architect start after the prerequisite tasks complete. Use message_worker to confirm who owns the shared edit. Completion orders the work; a dependency does not merge code into a branch.',
  pause_task:
    'Pause a task and preserve its current work. Use when the user changes direction or a dependent task must wait.',
  resume_task:
    'Resume a paused task in this session, preserving existing work and revision guards.',
  submit_task:
    'Submit or reconcile a completed implementation when its automatic-push policy allows it. An uncertain native PR creation is reconciled, never repeated blindly.',
  retry_review:
    'Retry an incomplete review of a worker report or a pinned native revision after inspecting task state.',
  set_architect_model:
    'Choose an architect profile for one task. Pass null to inherit the session architect, which defaults to the shared reviewer. Applies to queued and future planning turns.',
  set_worker_model:
    'Choose a validated model/effort for one idle task worker. Does not change daddy or other workers.',
};
export const daddyTools: RuntimeTool[] = Object.entries(daddySchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
}));
