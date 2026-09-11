import { z } from 'zod';
import { CodexConnection, type RpcMessage } from './protocol.js';
import {
  resultSchema,
  taskSession,
  type AgentRuntime,
  type AgentInput,
  type SessionInput,
  type SessionRuntime,
} from './agent.js';
import { dynamicTools } from '../core/broker.js';
import { AppError, type AgentResult } from '../core/types.js';
import { redact } from '../core/security.js';
import { selectedExecutable, type Executable } from './executable.js';

export class CodexRuntime implements AgentRuntime, SessionRuntime {
  constructor(
    private options: {
      executable?: Executable;
      args?: string[];
      model?: string;
      timeoutMs?: number;
    } = {},
  ) {}
  async run(input: AgentInput): Promise<AgentResult> {
    return this.runSession(taskSession(input));
  }
  async runSession(input: SessionInput): Promise<AgentResult> {
    if (input.profile?.effort === 'ultra')
      throw new AppError(
        'unsupported_profile',
        'Codex delegation mode is not supported by this module',
      );
    // Capture once per turn. Updating the selection never touches an existing process.
    const rpc = new CodexConnection(selectedExecutable(this.options.executable), this.options.args);
    const profile = input.profile,
      readOnly = input.readOnly;
    let threadId = input.threadId;
    let turnId: string | undefined;
    let final = '',
      completed = false;
    let toolChain = Promise.resolve();
    const earlyCompletions = new Map<string, Record<string, unknown>>();
    let resolveDone!: () => void, rejectDone!: (e: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // The connection can close while initialize/start is awaited. Attach a handler
    // immediately so a rejected completion promise cannot become unhandled.
    void done.catch(() => {});
    const abort = () => {
      rejectDone(new AppError('run_cancelled', 'Agent run interrupted'));
      rpc.close();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => {
        rejectDone(new AppError('run_timeout', 'Agent exceeded the configured run time limit'));
        rpc.close();
      },
      this.options.timeoutMs ?? 20 * 60 * 1000,
    );
    const acceptCompletion = (turn: Record<string, unknown>) => {
      if (turn.status !== 'completed') {
        rejectDone(
          new AppError(
            'incomplete_turn',
            `Codex turn ${String(turn.status)}: ${redact(turn.error ?? '')}`,
          ),
        );
        return;
      }
      completed = true;
      resolveDone();
    };
    rpc.on('diagnostic', (text) => input.onEvent('runtime.diagnostic', text));
    rpc.on('closed', (error) => {
      if (!completed) rejectDone(error);
    });
    rpc.on('message', (message: RpcMessage) => {
      const params = message.params ?? {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (message.id !== undefined && message.method) {
        toolChain = toolChain
          .then(async () => {
            if (message.method === 'item/tool/call') {
              try {
                input.onEvent('tool.started', {
                  tool: params.tool,
                  arguments: params.arguments,
                });
                if (input.signal.aborted)
                  throw new AppError('run_cancelled', 'Run is no longer active');
                const result = await input.onTool(
                  String(params.tool),
                  params.arguments,
                  String(params.callId),
                );
                rpc.respond(message.id!, {
                  success: true,
                  contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
                });
                input.onEvent('tool.completed', { tool: params.tool, result });
              } catch (error) {
                rpc.respond(message.id!, {
                  success: false,
                  contentItems: [{ type: 'inputText', text: redact(String(error)) }],
                });
                input.onEvent('tool.failed', {
                  tool: params.tool,
                  error: redact(String(error)),
                });
              }
            } else {
              // A host permission request is not interpreted as a grant. Surface it and
              // return a protocol-valid refusal; the agent can explain the missing step.
              input.onEvent('runtime.permission_requested', {
                method: message.method,
                params,
              });
              if (message.method === 'item/permissions/requestApproval')
                rpc.respond(message.id!, { permissions: {}, scope: 'turn' });
              else if (message.method?.includes('requestApproval'))
                rpc.respond(message.id!, { decision: 'decline' });
              else if (message.method?.includes('requestUserInput'))
                rpc.respond(message.id!, { answers: {} });
              else if (message.method?.includes('elicitation'))
                rpc.respond(message.id!, { action: 'decline', content: null });
              else
                rpc.send({
                  id: message.id,
                  error: { code: -32601, message: 'Unsupported host request' },
                });
            }
          })
          .catch((error) => rejectDone(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (params.turnId && turnId && params.turnId !== turnId) return;
      if (message.method === 'item/completed') {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === 'agentMessage' && item.phase !== 'commentary')
          final = String(item.text ?? '');
        if (item && !['reasoning', 'userMessage'].includes(String(item.type)))
          input.onEvent('runtime.item', item);
      } else if (message.method === 'item/agentMessage/delta') {
        input.onEvent('runtime.text', {
          delta: params.delta,
          itemId: params.itemId,
        });
      } else if (message.method === 'turn/completed') {
        const turn = params.turn as Record<string, unknown>;
        if (turnId === turn.id) acceptCompletion(turn);
        else earlyCompletions.set(String(turn.id), turn);
      } else if (message.method === 'error') input.onEvent('runtime.error', params);
    });
    try {
      if (input.signal.aborted) throw new AppError('run_cancelled', 'Run is already cancelled');
      await rpc.start(input.cwd);
      const config = {
        'features.apps': false,
        'features.multi_agent': false,
        mcp_servers: {},
        'shell_environment_policy.inherit': 'core',
      };
      const common = {
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        approvalPolicy: 'never',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        config,
        ...(profile?.model || this.options.model
          ? { model: profile?.model ?? this.options.model }
          : {}),
        developerInstructions: input.instructions,
      };
      if (threadId)
        await rpc.request('thread/resume', {
          ...common,
          threadId,
          excludeTurns: true,
        });
      else {
        const response = await rpc.request<{ thread: { id: string } }>('thread/start', {
          ...common,
          serviceName: 'daddyloop',
          dynamicTools: input.tools ?? dynamicTools,
        });
        threadId = response.thread.id;
      }
      input.onSession(threadId!);
      const response = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        ...(profile?.model ? { model: profile.model } : {}),
        ...(profile?.effort ? { effort: profile.effort } : {}),
        runtimeWorkspaceRoots: [input.cwd],
        input: [{ type: 'text', text: input.prompt }],
        outputSchema: z.toJSONSchema(resultSchema, { target: 'draft-7' }),
        sandboxPolicy: readOnly
          ? { type: 'readOnly', networkAccess: false }
          : {
              type: 'workspaceWrite',
              writableRoots: [input.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
      });
      turnId = response.turn.id;
      input.onSession(threadId!, turnId);
      if (earlyCompletions.has(turnId)) acceptCompletion(earlyCompletions.get(turnId)!);
      await done;
      await toolChain;
      let parsed: z.infer<typeof resultSchema>;
      try {
        parsed = resultSchema.parse(JSON.parse(final));
      } catch {
        throw new AppError(
          'invalid_agent_result',
          'Codex did not return a complete, valid review result. See run events; the workflow was not advanced.',
        );
      }
      return { ...parsed, question: parsed.question ?? undefined };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      rpc.close();
    }
  }
}
