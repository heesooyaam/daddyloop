import type { Options, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import {
  resultSchema,
  taskSession,
  type AgentInput,
  type SessionInput,
  type AgentRuntime,
  type SessionRuntime,
} from '../../../runtime/agent.js';
import { dynamicTools } from '../../../core/broker.js';
import { AppError, type AgentResult } from '../../../core/types.js';
import { redact } from '../../../core/security.js';
import type { Executable } from '../../../runtime/executable.js';
import { connectionOptions, type ClaudeQuery } from './connection.js';
import type { ClaudeUsage } from './usage.js';

function inside(cwd: string, value: string) {
  const absolute = resolve(cwd, value);
  let parent = absolute;
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  while (!exists(parent) && parent !== dirname(parent)) parent = dirname(parent);
  let canonical: string;
  try {
    canonical = resolve(realpathSync(parent), relative(parent, absolute));
  } catch {
    return false;
  }
  const rel = relative(cwd, canonical);
  return !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel);
}
/** Applied before native auto-approval too; unknown tools cannot acquire new authority. */
export function claudeToolGuard(
  cwd: string,
  readOnly: boolean,
  custom: Set<string>,
  workspaceRoot = cwd,
  readPaths: string[] = [],
): HookCallback {
  cwd = realpathSync(cwd);
  workspaceRoot = realpathSync(workspaceRoot);
  readPaths = readPaths.map((path) => realpathSync(path));
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const name = input.tool_name;
    const args = input.tool_input as Record<string, unknown>;
    let reason: string | undefined;
    if (custom.has(name) || name === 'StructuredOutput') return {};
    if (name === 'Bash') {
      if (args.dangerouslyDisableSandbox === true || args.run_in_background === true)
        reason = 'Commands must finish inside the workspace sandbox before the agent returns';
    } else if (['Read', 'Glob', 'Grep', 'Edit', 'Write'].includes(name)) {
      if (readOnly && ['Edit', 'Write'].includes(name)) reason = 'This session is read-only';
      const path = args.file_path ?? args.path ?? cwd;
      if (
        typeof path !== 'string' ||
        !(['Edit', 'Write'].includes(name) ? [cwd] : [workspaceRoot, ...readPaths]).some((root) =>
          inside(root, resolve(cwd, path)),
        )
      )
        reason = 'Files must stay inside the task workspace';
      if (
        name === 'Glob' &&
        typeof args.pattern === 'string' &&
        (isAbsolute(args.pattern) || args.pattern.split('/').includes('..'))
      )
        reason = 'Glob patterns must stay inside the task workspace';
    } else reason = 'Use daddyloop tools for delegation, publication and user questions';
    return reason
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : {};
  };
}

export class ClaudeRuntime implements AgentRuntime, SessionRuntime {
  constructor(
    private options: {
      executable?: Executable;
      protectedPaths?: string[];
      timeoutMs?: number;
      maxBudgetUSD?: number;
      usage?: ClaudeUsage;
      connect?: ClaudeQuery;
    } = {},
  ) {}
  run(input: AgentInput) {
    return this.runSession(taskSession(input));
  }
  async runSession(input: SessionInput): Promise<AgentResult> {
    input.signal.throwIfAborted();
    const { query, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    input.signal.throwIfAborted();
    const cwd = realpathSync(input.cwd);
    const workspaceRoot = realpathSync(input.workspaceRoot ?? cwd);
    if (!inside(workspaceRoot, cwd))
      throw new AppError('workspace_scope', 'Agent cwd must belong to its managed repository root');
    const readPaths = (input.readPaths ?? []).map((path) => realpathSync(path));
    const usageIdentity = this.options.usage?.identity();
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs ?? 20 * 60 * 1000);
    let session: ReturnType<ClaudeQuery> | undefined;
    let server: ReturnType<typeof createSdkMcpServer> | undefined;
    try {
      const tools = input.tools ?? dynamicTools;
      const custom = new Set(tools.map((tool) => 'mcp__daddyloop__' + tool.name));
      server = createSdkMcpServer({
        name: 'daddyloop',
        tools: tools.map((tool) => {
          const schema = z.fromJSONSchema(tool.inputSchema) as z.ZodObject;
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: schema.shape,
            handler: async (args: unknown, extra: unknown) => {
              const callId = String((extra as { requestId?: string })?.requestId ?? randomUUID());
              try {
                controller.signal.throwIfAborted();
                input.onEvent('tool.started', { tool: tool.name, arguments: args });
                const result = await input.onTool(tool.name, args, callId);
                input.onEvent('tool.completed', { tool: tool.name, result });
                return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
              } catch (error) {
                input.onEvent('tool.failed', { tool: tool.name, error: redact(String(error)) });
                return {
                  isError: true,
                  content: [{ type: 'text' as const, text: redact(String(error)) }],
                };
              }
            },
          };
        }),
      });
      const builtin = input.readOnly
        ? ['Read', 'Glob', 'Grep', 'Bash']
        : ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];
      const options: Options = {
        ...connectionOptions(this.options.executable),
        cwd,
        abortController: controller,
        resume: input.threadId,
        model: input.profile?.model,
        effort: input.profile?.effort as Options['effort'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions },
        tools: builtin,
        allowedTools: [...custom],
        permissionMode: 'default',
        mcpServers: { daddyloop: server },
        hooks: {
          PreToolUse: [
            { hooks: [claudeToolGuard(cwd, input.readOnly, custom, workspaceRoot, readPaths)] },
          ],
        },
        canUseTool: async (name, args) => {
          if (
            custom.has(name) ||
            name === 'StructuredOutput' ||
            (builtin.includes(name) && name !== 'Bash')
          )
            return { behavior: 'allow', updatedInput: args };
          return { behavior: 'deny', message: 'daddyloop did not grant this host permission' };
        },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: {
            denyRead: [homedir(), ...(this.options.protectedPaths ?? [])],
            allowRead: [workspaceRoot, ...readPaths],
            denyWrite: input.readOnly ? [cwd, '/tmp'] : [],
            allowWrite: input.readOnly ? [] : [cwd],
          },
          network: {
            allowedDomains: [],
            strictAllowlist: true,
            allowUnixSockets: [],
            allowLocalBinding: false,
          },
          credentials: {
            envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }],
            files: [{ path: join(homedir(), '.tokens'), mode: 'deny' }],
          },
        },
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(resultSchema, { target: 'draft-7' }),
        },
        maxTurns: 100,
        maxBudgetUsd: this.options.maxBudgetUSD,
        stderr: (text) => input.onEvent('runtime.diagnostic', redact(text).slice(0, 8000)),
      };
      if (!options.env?.ANTHROPIC_API_KEY)
        throw new AppError(
          'credentials_missing',
          'Connect a Claude API key with daddy auth agent claude on the service host',
          422,
        );
      session = (this.options.connect ?? query)({ prompt: input.prompt, options });
      for await (const message of session) {
        controller.signal.throwIfAborted();
        if ('session_id' in message && message.session_id) input.onSession(message.session_id);
        if (message.type === 'rate_limit_event')
          this.options.usage?.observe(message.rate_limit_info, usageIdentity);
        if (message.type === 'assistant') {
          for (const block of message.message.content)
            if (block.type === 'text')
              input.onEvent('runtime.text', { delta: block.text, itemId: message.uuid });
        }
        if (message.type === 'result') {
          this.options.usage?.observeActivity(message.modelUsage, usageIdentity);
          input.onEvent('runtime.usage', {
            engine: 'claude',
            costUSD: message.total_cost_usd,
            models: message.modelUsage,
          });
          if (message.subtype !== 'success' || message.is_error)
            throw new AppError(
              'incomplete_turn',
              `Claude did not complete the turn: ${redact(message.subtype === 'success' ? message.result : message.errors.join('; '))}`,
            );
          const parsed = resultSchema.safeParse(message.structured_output);
          if (!parsed.success)
            throw new AppError(
              'invalid_agent_result',
              'Claude did not return a complete structured result; the workflow was not advanced',
            );
          return { ...parsed.data, question: parsed.data.question ?? undefined };
        }
      }
      throw new AppError(
        'incomplete_turn',
        'Claude exited without a result; the workflow was not advanced',
      );
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      controller.abort();
      session?.close();
      await server?.instance.close();
    }
  }
}
