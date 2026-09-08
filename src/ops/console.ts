import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Task, Message } from '../core/types.js';
import { VERSION } from '../version.js';

export async function consoleUI(
  api: <T>(path: string, body?: unknown) => Promise<T>,
  initial?: { id: string; role: 'author' | 'reviewer' },
) {
  if (!stdin.isTTY) {
    stdout.write(
      'Use reviewctl --help for commands, or run reviewctl in a terminal for the interactive console.\n',
    );
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  let taskId = initial?.id ?? '',
    role = initial?.role ?? 'reviewer',
    closing = false,
    refreshing = false;
  const seen = new Set<string>();
  const color = (text: string) => (stdout.isTTY ? `\x1b[32m${text}\x1b[0m` : text);
  const showTasks = async () => {
    const tasks = await api<Task[]>('/tasks');
    stdout.write('\n');
    for (const task of tasks)
      stdout.write(`${task.id.slice(0, 8)}  ${task.state.padEnd(22)} ${task.title}\n`);
    if (!tasks.length)
      stdout.write('No tasks yet. Use /attach to connect a PR, or /demo to try the workflow.\n');
    stdout.write('\n');
    return tasks;
  };
  const select = async (prefix: string) => {
    const tasks = await api<Task[]>('/tasks'),
      matches = tasks.filter((t) => t.id.startsWith(prefix));
    if (matches.length !== 1)
      throw new Error(matches.length ? 'Task prefix is ambiguous' : 'Task not found');
    taskId = matches[0].id;
    const detail = await api<{ messages: Message[] }>(`/tasks/${taskId}`);
    for (const message of detail.messages) seen.add(message.id);
    stdout.write(`\n${color(matches[0].title)} · ${matches[0].state}\n`);
    for (const message of detail.messages.filter((m) => m.role === role).slice(-3))
      stdout.write(`\n${message.sender}: ${message.text}\n`);
  };
  stdout.write(
    `\n${color('reviewloop')} ${VERSION}\nAuthor and reviewer sessions, managed by your background service.\nType /help for commands. Closing this console does not stop the service or agents.\n`,
  );
  try {
    if (taskId) await select(taskId);
    else await showTasks();
  } catch (error) {
    stdout.write(
      `\n${(error as Error).message}\nRun reviewctl init on the host, or reviewctl connect <https-url> on a client.\n`,
    );
    rl.close();
    return;
  }
  const timer = setInterval(async () => {
    if (!taskId || closing || refreshing) return;
    refreshing = true;
    const selected = taskId;
    try {
      const detail = await api<{ messages: Message[] }>(`/tasks/${selected}`);
      if (selected !== taskId) return;
      for (const message of detail.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (message.role === role && message.sender === 'agent')
          stdout.write(`\n\n${color(role)}\n${message.text}\n\n`);
      }
    } catch {
      /* The next user action reports connection errors without flooding the prompt. */
    } finally {
      refreshing = false;
    }
  }, 2000);
  rl.on('SIGINT', () => {
    closing = true;
    rl.close();
  });
  try {
    while (!closing) {
      const input = (
        await rl.question(`${taskId ? taskId.slice(0, 8) + ':' + role : 'reviewloop'} > `)
      ).trim();
      if (!input) continue;
      try {
        if (input === '/quit' || input === '/exit') break;
        if (input === '/help') {
          stdout.write(
            '\n/tasks                 List tasks\n/use <id-prefix>       Select a task\n/role author|reviewer  Choose a conversation\n/attach                Connect a PR/MR\n/demo                  Create a demo task\n/status                Show current task\n/publish               Publish the current finished review\n/pause /resume /retry  Control the task\n/logs                  Show recent activity\n/quit                  Close this client; work continues\n\nOther text is sent to the selected agent.\n',
          );
          continue;
        }
        if (input === '/tasks') {
          await showTasks();
          continue;
        }
        if (input.startsWith('/use ')) {
          await select(input.slice(5).trim());
          continue;
        }
        if (input.startsWith('/role ')) {
          const next = input.slice(6).trim();
          if (next !== 'author' && next !== 'reviewer')
            throw new Error('Choose author or reviewer');
          role = next;
          continue;
        }
        if (input === '/demo') {
          const task = await api<Task>('/demo', {});
          await select(task.id);
          continue;
        }
        if (input === '/attach') {
          const url = await rl.question('PR/MR URL: '),
            repoPath = await rl.question('Repository path on the service host: '),
            requirements = await rl.question('Original requirements: ');
          const task = await api<Task>('/tasks', { url, repoPath, requirements });
          await select(task.id);
          continue;
        }
        if (!taskId) throw new Error('Select a task with /use first');
        if (['/publish', '/pause', '/resume', '/retry'].includes(input)) {
          const task = await api<Task>(`/tasks/${taskId}/actions`, { action: input.slice(1) });
          stdout.write(`${task.state}: ${task.reason}\n`);
          continue;
        }
        if (input === '/status') {
          const { task } = await api<{ task: Task }>(`/tasks/${taskId}`);
          stdout.write(`${task.state}: ${task.reason}\n`);
          continue;
        }
        if (input === '/logs') {
          const detail = await api<{ events: { type: string; at: string }[] }>(`/tasks/${taskId}`);
          for (const event of detail.events.filter((e) => e.type !== 'runtime.text').slice(-12))
            stdout.write(`${event.at} ${event.type}\n`);
          continue;
        }
        if (input.startsWith('/')) throw new Error('Unknown command. Use /help');
        await api(`/tasks/${taskId}/messages`, { role, text: input });
        stdout.write('Message queued. The response will appear here.\n');
      } catch (error) {
        stdout.write(`${(error as Error).message}\n`);
      }
    }
  } catch (error) {
    if (!closing && (error as NodeJS.ErrnoException).code !== 'ERR_USE_AFTER_CLOSE') throw error;
  } finally {
    closing = true;
    clearInterval(timer);
    rl.close();
  }
}
