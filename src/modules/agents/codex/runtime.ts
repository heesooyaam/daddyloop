import { startReviewHistory } from './review-history.js';
import { reviewDecisionTool } from '../../../core/review-decisions.js';
import { codexExecutable } from './executable.js';
import { z } from 'zod';
import { CodexConnection, type RpcMessage } from './protocol.js';
import {
  resultSchema,
  executionInstructions,
  taskSession,
  type AgentRuntime,
  type AgentInput,
  type SessionInput,
  type SessionRuntime,
} from '../../../runtime/agent.js';
import { dynamicTools } from '../../../core/broker.js';
import { AppError, type AgentResult } from '../../../core/types.js';
import { redact } from '../../../core/security.js';
import { type Executable } from '../../../runtime/executable.js';

// compact/start acknowledges scheduling. Only the compaction turn can confirm completion.
async function compactThread(rpc: CodexConnection, threadId: string, interrupted: Promise<void>) {
  let onMessage!: (message: RpcMessage) => void;
  const finished = new Promise<void>((resolve, reject) => {
    let started: string | undefined;
    let compactTurn: string | undefined;
    onMessage = ({ method, params }) => {
      if (params?.threadId !== threadId) return;
      const turn = params.turn as
        { id: string; status: string; items?: { type: string }[] } | undefined;
      if (method === 'turn/started' && turn) started = turn.id;
      if (
        (method === 'item/started' || method === 'item/completed') &&
        (params.item as { type?: string } | undefined)?.type === 'contextCompaction'
      )
        compactTurn = String(params.turnId);
      if (method !== 'turn/completed' || !turn) return;
      if (turn.status !== 'completed' && (turn.id === compactTurn || turn.id === started))
        reject(
          new AppError('context_window_exceeded', 'Codex could not compact the review thread.'),
        );
      else if (
        turn.status === 'completed' &&
        (turn.id === compactTurn || turn.items?.some((item) => item.type === 'contextCompaction'))
      )
        resolve();
    };
    rpc.on('message', onMessage);
  });
  try {
    await Promise.race([
      Promise.all([rpc.request('thread/compact/start', { threadId }), finished]),
      interrupted,
    ]);
  } catch (error) {
    if (error instanceof AppError && error.code === 'codex_rpc')
      throw new AppError(
        'context_window_exceeded',
        'Codex rejected compaction of the review thread.',
      );
    throw error;
  } finally {
    rpc.off('message', onMessage);
  }
}

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
    const session = taskSession(input);
    const executable = codexExecutable(this.options.executable);
    const deadline = Date.now() + (this.options.timeoutMs ?? 20 * 60 * 1000);
    let threadId = session.threadId;
    const onSession = (id: string, turn?: string) => {
      threadId = id;
      session.onSession(id, turn);
    };
    try {
      return await this.execute({ ...session, onSession }, executable, deadline);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== 'context_window_exceeded' ||
        input.job.role !== 'reviewer' ||
        !['review', 'verify_merge'].includes(input.job.kind) ||
        !threadId ||
        input.signal.aborted
      )
        throw error;
      input.onEvent('review.compacting', {});
      return this.execute(
        {
          ...session,
          threadId,
          onSession,
          instructions:
            session.instructions +
            '\nContinue the interrupted review. Inspect the saved draft or report and the current pinned revision before acting. Preserve completed work and do not duplicate findings.',
        },
        executable,
        deadline,
        true,
      );
    }
  }
  runSession(input: SessionInput): Promise<AgentResult> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 20 * 60 * 1000);
    return this.execute(input, codexExecutable(this.options.executable), deadline);
  }
  private async execute(
    input: SessionInput,
    executable: string,
    deadline: number,
    compacting = false,
  ): Promise<AgentResult> {
    const rpc = new CodexConnection(executable, this.options.args);
    const profile = input.profile,
      readOnly = input.readOnly;
    const host = input.execution !== 'sandbox';
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
      Math.max(1, deadline - Date.now()),
    );
    const acceptCompletion = (turn: Record<string, unknown>) => {
      if (turn.status !== 'completed') {
        if (
          (turn.error as { codexErrorInfo?: unknown } | null)?.codexErrorInfo ===
          'contextWindowExceeded'
        ) {
          rejectDone(
            new AppError(
              'context_window_exceeded',
              'Codex reached the context limit for this thread.',
            ),
          );
          return;
        }
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
      if (compacting) {
        if (message.id !== undefined && message.method)
          rpc.send({
            id: message.id,
            error: { code: -32601, message: 'Tools are unavailable during compaction' },
          });
        return;
      }
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
        if (
          item?.type === 'agentMessage' &&
          item.phase === 'commentary' &&
          typeof item.text === 'string'
        )
          input.onAssistantMessage?.({ id: String(item.id ?? ''), text: item.text });
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
    let history: Awaited<ReturnType<typeof startReviewHistory>> | undefined;
    const tools = input.tools ?? dynamicTools;
    try {
      if (input.signal.aborted) throw new AppError('run_cancelled', 'Run is already cancelled');
      await rpc.start(input.cwd, host, input.processScope?.env);
      // Dynamic schemas are persisted in Codex rollouts. Configure the read-only
      // MCP tool on both start and resume so older threads can discover it.
      if (tools.some((tool) => tool.name === reviewDecisionTool.name))
        history = await startReviewHistory(input);
      const config = {
        'features.apps': false,
        'features.multi_agent': false,
        mcp_servers: history?.config ?? {},
        'shell_environment_policy.inherit': host ? 'all' : 'core',
        ...(input.processScope ? { 'shell_environment_policy.set': input.processScope.env } : {}),
      };
      const common = {
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        approvalPolicy: 'never',
        sandbox: host ? 'danger-full-access' : readOnly ? 'read-only' : 'workspace-write',
        config,
        ...(profile?.model || this.options.model
          ? { model: profile?.model ?? this.options.model }
          : {}),
        developerInstructions: executionInstructions(input),
      };
      if (threadId) {
        await rpc.request('thread/resume', {
          ...common,
          threadId,
          excludeTurns: true,
        });
        if (compacting) {
          await compactThread(rpc, threadId, done);
          compacting = false;
          input.onEvent('review.compacted', {});
        }
        // A resumed rollout can retain developer messages from its first launch.
        // Append the current policy at developer priority before the model runs.
        await rpc.request('thread/inject_items', {
          threadId,
          items: [
            {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: common.developerInstructions }],
            },
          ],
        });
      } else {
        const response = await rpc.request<{ thread: { id: string } }>('thread/start', {
          ...common,
          serviceName: 'daddyloop',
          dynamicTools: tools.filter((tool) => tool.name !== reviewDecisionTool.name),
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
        sandboxPolicy: host
          ? { type: 'dangerFullAccess' }
          : readOnly
            ? { type: 'readOnly', networkAccess: false }
            : {
                type: 'workspaceWrite',
                writableRoots: [
                  input.cwd,
                  ...(input.processScope ? [input.processScope.cacheDir] : []),
                ],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
      });
      turnId = response.turn.id;
      input.onSession(threadId!, turnId);
      if (earlyCompletions.has(turnId)) acceptCompletion(earlyCompletions.get(turnId)!);
      await done.finally(() => toolChain);
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
      await history?.close();
    }
  }
}
