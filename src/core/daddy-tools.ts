import { z } from 'zod';
import type { RuntimeTool } from '../runtime/agent.js';
import { profileSchema } from './agents.js';
const id = z.string().uuid(),
  text = z.string().trim().min(1).max(20000);
export const daddySchemas = {
  read_board: z.object({}).strict(),
  list_projects: z.object({}).strict(),
  list_models: z.object({}).strict(),
  read_task: z.object({ taskId: id }).strict(),
  import_ticket: z
    .object({ source: z.string().min(1).max(2048), projectId: id.optional() })
    .strict(),
  attach_review: z
    .object({
      url: z.string().url().max(2048),
      projectId: id.optional(),
      requirements: text.optional(),
    })
    .strict(),
  create_task: z
    .object({
      title: z.string().trim().min(1).max(200),
      requirements: text,
      projectId: id.optional(),
      dependsOn: z.array(id).max(20).optional(),
    })
    .strict(),
  dispatch: z.object({ taskId: id, instruction: text.optional() }).strict(),
  message_worker: z.object({ taskId: id, instruction: text }).strict(),
  set_dependencies: z.object({ taskId: id, dependsOn: z.array(id).max(20) }).strict(),
  pause_task: z.object({ taskId: id, reason: text }).strict(),
  resume_task: z.object({ taskId: id }).strict(),
  submit_task: z.object({ taskId: id }).strict(),
  retry_review: z.object({ taskId: id }).strict(),
  set_writer_model: z.object({ taskId: id, profile: profileSchema }).strict(),
};
const descriptions: Record<keyof typeof daddySchemas, string> = {
  read_board:
    'Read this Daddy session: tasks, dependencies, writer capacity and current jobs. Inspect before dispatching.',
  list_projects:
    'List repositories the user registered on this server. Choose only these project IDs.',
  list_models:
    'Read the actual Codex model catalogue and supported reasoning efforts before choosing a different writer model.',
  read_task:
    'Read a task in this session, including its worker reports and pinned native review status.',
  import_ticket:
    'Read a GitHub issue or Yandex Tracker ticket and add it to this session. Does not start a writer or write to the tracker.',
  attach_review:
    'Attach an existing GitHub/GitLab/Arcadia pull request to this Daddy session for its native review/fix workflow. The project must match the native repository.',
  create_task:
    'Create a concrete task from the user requirements. Choose a registered project and optional dependencies. Does not start a writer.',
  dispatch:
    'Start implementation of a ready task. Dependencies and per-session writer limits are enforced by the service. Native push/review follows the task policy.',
  message_worker:
    'Send scoped instructions or a question to the task writer. Results return to Daddy; do not ask the user to contact workers.',
  set_dependencies:
    'Set same-session prerequisites before a task starts. This orders work; it does not merge branches. Keep interdependent edits in one implementation task unless their base already contains the prerequisites.',
  pause_task:
    'Pause a task and preserve its current work. Use when the user changes direction or a dependent task must wait.',
  resume_task:
    'Resume a paused task in this session, preserving existing work and revision guards.',
  submit_task:
    'Submit or reconcile a completed implementation when its automatic-push policy allows it. An uncertain native PR creation is reconciled, never repeated blindly.',
  retry_review:
    'Retry an incomplete pinned native review after inspecting task state. Does not publish, approve or merge anything.',
  set_writer_model:
    'Choose a validated model/effort for one idle task writer. Does not change Daddy or other writers.',
};
export const daddyTools: RuntimeTool[] = Object.entries(daddySchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
}));
