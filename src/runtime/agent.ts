import { z } from 'zod';
import type { Job, Task, AgentResult } from '../core/types.js';
export const resultSchema = z
  .object({
    status: z.enum(['completed', 'needs_input', 'incomplete']),
    summary: z.string().min(1),
    checkedHead: z.string(),
    question: z.string().nullable(),
    verifiedCommentIds: z.array(z.string()),
    disputedCommentIds: z.array(z.string()),
  })
  .strict();
export interface AgentInput {
  task: Task;
  job: Job;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onSession: (threadId: string, turnId?: string) => void;
  onEvent: (type: string, data: unknown) => void;
  onTool: (name: string, args: unknown, callId?: string) => Promise<unknown>;
}
export interface AgentRuntime {
  run(input: AgentInput): Promise<AgentResult>;
}
