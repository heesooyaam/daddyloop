import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const mode = process.argv[2] ?? 'happy';
const threadId = 'thread-fixture',
  turnId = 'turn-fixture';
let result;
let compacted = false;
let historyConfig;
let expectToolSuccess = true;
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (process.argv[3])
    appendFileSync(
      process.argv[3],
      JSON.stringify(m, (key, value) => (key === 'http_headers' ? '[redacted]' : value)) + '\n',
    );
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    historyConfig = m.params.config?.mcp_servers?.daddyloop_history;
    send({ id: m.id, result: { thread: { id: threadId } } });
  }
  if (m.method === 'thread/inject_items')
    send(
      mode === 'policy-error'
        ? { id: m.id, error: { code: -32603, message: 'Policy update failed' } }
        : { id: m.id, result: {} },
    );
  if (m.method === 'thread/compact/start') {
    const id = 'compact-turn';
    send({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } } });
    send({ id: m.id, result: {} });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'unrelated',
        turn: { id, status: 'completed', items: [{ type: 'contextCompaction' }] },
      },
    });
    setTimeout(() => {
      const status = mode === 'compact-fails' ? 'failed' : 'completed';
      compacted = status === 'completed';
      send({
        method: 'item/completed',
        params: { threadId, turnId: id, item: { type: 'contextCompaction' } },
      });
      send({ method: 'turn/completed', params: { threadId, turn: { id, status } } });
    }, 40);
  }
  if (m.method === 'turn/start') {
    if (mode === 'input-limit' && m.params.input[0].text.length > 1_048_576) {
      send({
        id: m.id,
        error: { code: -32602, message: 'Input exceeds the maximum length of 1048576 characters' },
      });
      return;
    }
    if (mode.startsWith('compact-') && (!compacted || mode === 'compact-overflows-again')) {
      send({ id: m.id, result: { turn: { id: turnId } } });
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: { codexErrorInfo: 'contextWindowExceeded' },
          },
        },
      });
      return;
    }
    if (mode === 'exit') {
      process.exit(2);
    }
    result = JSON.stringify({
      status: 'completed',
      summary: 'Verified callback ordering',
      checkedHead: 'a'.repeat(40),
      question: null,
      verifiedCommentIds: [],
      disputedCommentIds: [],
    });
    if (mode === 'malformed') result = 'Agent said done, but no valid structured result';
    if (mode === 'review-history') {
      try {
        const { url, http_headers } = historyConfig;
        const denied = await fetch(url);
        if (denied.status !== 403) throw new Error('Missing authentication check');
        const client = new Client({ name: 'test-codex', version: '1' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: http_headers },
          }),
        );
        try {
          const { tools } = await client.listTools();
          if (tools.length !== 1 || tools[0].name !== 'read_review_decisions')
            throw new Error('Expected exactly one read-only history tool');
          const response = await client.callTool({
            name: tools[0].name,
            arguments: JSON.parse(process.argv[4]),
          });
          if (response.isError) throw new Error('History lookup failed');
          result = JSON.stringify({ ...JSON.parse(result), summary: response.content[0].text });
        } finally {
          await client.close();
        }
      } catch (error) {
        send({ id: m.id, error: { code: -32603, message: String(error) } });
        return;
      }
    }
    if (mode === 'tool' || mode === 'tool-grants') {
      expectToolSuccess = mode !== 'tool-grants' || m.params.sandboxPolicy.type !== 'readOnly';
      send({ id: m.id, result: { turn: { id: turnId } } });
      send({
        id: 'tool-1',
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          callId: 'call-1',
          namespace: null,
          tool: 'read_review',
          arguments: {},
        },
      });
    } else {
      // Notifications may be delivered before the turn/start response.
      complete();
      send({ id: m.id, result: { turn: { id: turnId } } });
    }
  }
  if (m.id === 'tool-1' && m.result) {
    if (m.result.success !== expectToolSuccess || m.result.contentItems[0].type !== 'inputText')
      process.exit(3);
    complete();
  }
});
function complete() {
  if (mode === 'messages') {
    for (const item of [
      {
        type: 'agentMessage',
        id: 'comment-1',
        phase: 'commentary',
        text: 'Checking the implementation.',
      },
      {
        type: 'commandExecution',
        id: 'command-1',
        command: 'tail logs',
        aggregatedOutput: 'PRIVATE COMMAND OUTPUT',
      },
      { type: 'reasoning', id: 'reason-1', content: 'PRIVATE REASONING' },
    ])
      send({ method: 'item/completed', params: { threadId, turnId, item } });
  }
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text: result, phase: 'final_answer' },
    },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed' } },
  });
}
