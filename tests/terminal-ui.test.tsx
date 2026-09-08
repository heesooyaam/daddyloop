import { afterEach, it, expect } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { TerminalApp, contentRows } from '../src/terminal/app.js';
import { ConsoleModel } from '../src/terminal/model.js';
import { transport, taskA } from './terminal-fixture.js';
afterEach(cleanup);
it('navigates roles and task search using the keyboard', async () => {
  const model = new ConsoleModel(transport().api);
  await model.refresh();
  await expect.poll(() => model.snapshot().detail?.task.id).toBe(taskA.id);
  const ui = render(<TerminalApp model={model} />);
  try {
    await expect.poll(() => ui.lastFrame()).toContain('REVIEWER');
    ui.stdin.write('\t');
    await expect.poll(() => model.snapshot().role).toBe('author');
    expect(
      contentRows(model.snapshot(), 70)
        .map((row) => row.text)
        .join('\n'),
    ).not.toContain('Reviewer-only');
    ui.stdin.write('\x14');
    await expect.poll(() => ui.lastFrame()).toContain('Choose a task');
    ui.stdin.write('reconnect');
    await expect.poll(() => ui.lastFrame()).toContain('Handle reconnects');
    ui.stdin.write('\r');
    await expect.poll(() => model.snapshot().detail?.task.title).toBe('Handle reconnects');
  } finally {
    ui.unmount();
    model.stop();
  }
});
it('keeps bracketed multiline paste in the composer until explicit Enter sends a message', async () => {
  const { api, writes } = transport(),
    model = new ConsoleModel(api);
  await model.refresh();
  await expect.poll(() => model.snapshot().detail?.task.id).toBe(taskA.id);
  const ui = render(<TerminalApp model={model} />);
  try {
    await expect.poll(() => ui.lastFrame()).toContain('REVIEWER');
    ui.stdin.write('\x1b[200~/publish\nThis is pasted text.\x1b[201~');
    await expect.poll(() => model.editor().text).toBe('/publish\nThis is pasted text.');
    expect(writes).toEqual([]);
    ui.stdin.write('\r');
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].path).toContain('/messages');
  } finally {
    ui.unmount();
    model.stop();
  }
});
