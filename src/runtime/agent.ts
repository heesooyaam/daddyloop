import { z } from 'zod';
import type { Job, Task, AgentResult, AgentProfile } from '../core/types.js';
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface SessionInput {
  cwd: string;
  prompt: string;
  threadId?: string;
  profile?: AgentProfile;
  readOnly: boolean;
  instructions: string;
  tools?: RuntimeTool[];
  signal: AbortSignal;
  onSession: (threadId: string, turnId?: string) => void;
  onEvent: (type: string, data: unknown) => void;
  onTool: (name: string, args: unknown, callId?: string) => Promise<unknown>;
}
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
  tools?: RuntimeTool[];
}
export interface AgentRuntime {
  run(input: AgentInput): Promise<AgentResult>;
}
export interface SessionRuntime {
  runSession(input: SessionInput): Promise<AgentResult>;
}
