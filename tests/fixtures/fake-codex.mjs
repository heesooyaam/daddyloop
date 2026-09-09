import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const mode = process.argv[2] ?? 'happy';
const threadId = 'thread-fixture',
  turnId = 'turn-fixture';
let result;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (process.argv[3]) appendFileSync(process.argv[3], line + '\n');
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume')
    send({ id: m.id, result: { thread: { id: threadId } } });
  if (m.method === 'turn/start') {
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
    if (mode === 'tool') {
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
    if (!m.result.success || m.result.contentItems[0].type !== 'inputText') process.exit(3);
    complete();
  }
});
function complete() {
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
