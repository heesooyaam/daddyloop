import { translator, type Locale } from '../i18n/index.js';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from 'ink';
import { ConsoleModel, commands, type ConsoleState, type Detail } from './model.js';
import { edit, editorRows, emptyEditor, insert } from './editor.js';
import { clip, markdown, oneLine, wrap, type Row } from './text.js';
import type { State, Task } from '../core/types.js';
import { VERSION } from '../version.js';
import { choices, planningRows, profileText } from './planning.js';

const themes = {
  dark: {
    background: '#102019',
    panel: '#162b21',
    foreground: '#e3eee6',
    muted: '#9caf9f',
    accent: '#88d6ad',
    author: '#a5bfe6',
    border: '#425a4b',
    selected: '#294735',
    warning: '#e3c385',
    error: '#f0a799',
    code: '#c0dabb',
  },
  light: {
    background: '#f5f8f4',
    panel: '#e9f0e8',
    foreground: '#233f2b',
    muted: '#607566',
    accent: '#266744',
    author: '#365c86',
    border: '#9bb8a4',
    selected: '#d4e5d6',
    warning: '#81570c',
    error: '#aa382b',
    code: '#345c36',
  },
};
type Theme = typeof themes.dark;
const labels: Record<State, string> = {
  discussing: 'Discussing ticket',
  implementing: 'Implementing',
  ready_for_review: 'Ready to submit',
  submitting: 'Creating PR',
  queued: 'Queued',
  reviewing: 'Reviewing',
  awaiting_publication: 'Review ready',
  fixing: 'Author working',
  awaiting_push: 'Awaiting push',
  awaiting_checks: 'CI pending',
  awaiting_plan_approval: 'Plan approval',
  needs_input: 'Needs input',
  paused: 'Paused',
  complete: 'Complete',
};
const taskIcon = (task: Task) =>
  task.state === 'complete'
    ? '✓'
    : ['reviewing', 'fixing'].includes(task.state)
      ? '◌'
      : task.state === 'awaiting_publication'
        ? '◆'
        : '·';
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
function recentActivity(detail?: Detail, locale: Locale = 'en') {
  const tr = translator(locale);

  const event = detail?.events
    .filter((event) =>
      ['tool.started', 'tool.completed', 'runtime.item', 'job.queued'].includes(event.type),
    )
    .at(-1);
  if (!event) return tr('Waiting for the service');
  const data = event.data as Record<string, unknown> | undefined;
  return oneLine(data?.command ?? data?.tool ?? event.type.replaceAll('.', ' / '));
}
export function contentRows(state: ConsoleState, columns: number): Row[] {
  const tr = translator(state.locale);

  const detail = state.detail;
  if (!detail)
    return [
      { text: tr('A workspace for the work between agents.'), kind: 'heading' },
      { text: '' },
      ...markdown(
        state.connection === 'offline'
          ? tr(
              'The service is unavailable. Your console will reconnect automatically.\n\nRun reviewctl init on the service host, or reviewctl connect <https-url> on a client.\n\n/refresh retries now. Ctrl+Q closes this client.',
            )
          : state.tasks.length
            ? tr('Loading the selected conversation…')
            : tr(
                'Start with a ticket, attach a PR or try the demo.\n\n/new      Start from a GitHub issue or Tracker ticket\n/defaults Choose author and reviewer models\n/attach   Connect an existing review\n/demo     Explore a complete review loop\n/notifications  Telegram updates\n\nThe service owns the agent sessions. Closing this console leaves the work running.',
              ),
        columns,
      ),
    ];
  const rows: Row[] = [];
  if (state.view === 'group') {
    rows.push(
      ...markdown(
        detail.group
          ? tr('{v0}\n\nShared reviewer: {v1}\n\n{v2}', {
              v0: detail.group.title,
              v1: profileText(detail.group.reviewer, state.locale),
              v2: detail.group.requirements,
            })
          : tr(
              'This task has no group yet. /child adds a ticket with its own author and this reviewer.',
            ),
        columns,
      ),
      { text: '' },
    );
    for (const sibling of detail.siblings ?? [])
      rows.push(
        { text: `${sibling.id === detail.task.id ? '›' : ' '} ${sibling.title}`, kind: 'accent' },
        { text: `${sibling.id.slice(0, 8)} · ${tr(labels[sibling.state])}`, kind: 'muted' },
      );
  } else if (state.view === 'findings') {
    const snapshot = detail.task.snapshot;
    rows.push(
      {
        text: tr('{v0} · {v1} findings', {
          v0: snapshot?.status === 'published' ? 'PUBLISHED REVIEW' : 'REVIEW DRAFT',
          v1: snapshot?.comments.length ?? 0,
        }),
        kind: 'heading',
      },
      { text: '' },
    );
    if (snapshot?.body) rows.push(...markdown(snapshot.body, columns), { text: '' });
    for (const comment of snapshot?.comments ?? [])
      rows.push(
        {
          text: `${comment.location ? `${comment.location.path}:${comment.location.line}` : tr('General comment')} · ${comment.id}`,
          kind: 'accent',
        },
        ...markdown(comment.body, columns),
        { text: '' },
      );
    if (!snapshot?.comments.length)
      rows.push({ text: tr('No findings in the current review.'), kind: 'muted' });
  } else if (state.view === 'context') {
    rows.push(
      { text: tr('ORIGINAL REQUIREMENTS'), kind: 'heading' },
      { text: '' },
      ...markdown(detail.task.requirements, columns),
      { text: '' },
      { text: tr('PERSISTENT SESSIONS'), kind: 'heading' },
    );
    rows.push(
      ...markdown(
        tr(
          'Reviewer model: {v0}\nAuthor model: {v1}\nReviewer session: {v2}\nAuthor session: {v3}\nRepository: {v4}\nSource: {v5}',
          {
            v0: profileText(detail.agents?.reviewer, state.locale),
            v1: profileText(detail.agents?.author, state.locale),
            v2:
              detail.group?.reviewerThreadId ??
              detail.task.reviewerThreadId ??
              tr('Starts with the first review'),
            v3: detail.task.authorThreadId ?? tr('Starts with the first conversation'),
            v4: detail.task.repoPath,
            v5: detail.task.ref.url,
          },
        ),
        columns,
      ),
    );
  } else if (state.view === 'activity') {
    rows.push({ text: tr('ACTIVITY · latest persisted events'), kind: 'heading' }, { text: '' });
    for (const event of detail.events
      .filter((event) => event.type !== 'runtime.text')
      .slice(-150)) {
      const data = event.data as Record<string, unknown> | undefined;
      rows.push({
        text: `${time(event.at)}  ${event.type.replaceAll('.', ' / ')}`,
        kind: 'accent',
      });
      const description = data?.command ?? data?.tool ?? data?.reason ?? data?.error;
      if (description) rows.push(...markdown(oneLine(description), columns));
    }
  } else {
    const messages = detail.messages.filter((message) => message.role === state.role);
    let budget = 60000;
    const selected = [];
    for (const message of messages.slice(-150).reverse()) {
      if (selected.length && message.text.length > budget) break;
      selected.unshift(message);
      budget -= message.text.length;
    }
    if (selected.length < messages.length)
      rows.push(
        {
          text: tr('Older messages are available in the web panel / reviewctl show.'),
          kind: 'muted',
        },
        { text: '' },
      );
    if (!messages.length)
      rows.push(
        {
          text:
            state.role === 'author'
              ? detail.task.ref.kind === 'ticket'
                ? tr(
                    'Discuss the ticket here. /implement starts code changes and the automatic review loop.',
                  )
                : tr('Your author session starts after feedback is published.')
              : tr('Your reviewer will report findings here.'),
          kind: 'muted',
        },
        { text: '' },
        ...markdown(
          tr(
            'Write a message below. Use Tab to switch sessions; drafts stay with their recipient.',
          ),
          columns,
        ),
      );
    for (const message of selected) {
      const user = message.sender === 'user';
      rows.push({
        text: `${user ? tr('❯ YOU') : '● ' + tr(state.role).toUpperCase()}  ${time(message.at)}`,
        kind: user ? 'user' : state.role === 'author' ? 'author' : 'accent',
      });
      rows.push(...markdown(message.text, columns), { text: '' });
    }
    if (state.pending?.key === `${state.selectedId}:${state.role}`)
      rows.push(
        { text: tr('❯ YOU · sending…'), kind: 'user' },
        ...markdown(state.pending.text, columns),
        { text: '' },
      );
    const active = detail.jobs.find(
      (job) => job.role === state.role && ['queued', 'running'].includes(job.status),
    );
    if (active)
      rows.push(
        {
          text: `${tr(state.role).toUpperCase()} · ${active.status === 'queued' ? tr('queued on the service') : 'working'}`,
          kind: 'accent',
        },
        ...markdown(recentActivity(detail, state.locale), columns),
      );
  }
  return rows.flatMap((row) => wrap(row.text, columns).map((text) => ({ ...row, text })));
}
function Lines({ rows, theme }: { rows: Row[]; theme: Theme }) {
  return (
    <>
      {rows.map((row, index) => (
        <Text
          key={index}
          wrap="truncate"
          color={
            row.kind === 'muted'
              ? theme.muted
              : row.kind === 'code'
                ? theme.code
                : row.kind === 'author'
                  ? theme.author
                  : row.kind === 'warning'
                    ? theme.warning
                    : ['heading', 'accent', 'user'].includes(row.kind ?? '')
                      ? theme.accent
                      : theme.foreground
          }
          bold={['heading', 'user', 'accent', 'author'].includes(row.kind ?? '')}
        >
          {row.text || ' '}
        </Text>
      ))}
    </>
  );
}
function Sidebar({ state, height, theme }: { state: ConsoleState; height: number; theme: Theme }) {
  const tr = translator(state.locale);

  const selected = state.tasks.findIndex((task) => task.id === state.selectedId);
  const count = Math.max(1, Math.floor((height - 12) / 4)),
    start = Math.max(0, Math.min(selected - Math.floor(count / 2), state.tasks.length - count));
  return (
    <Box
      width={28}
      flexShrink={0}
      height={height}
      flexDirection="column"
      paddingX={1}
      paddingTop={1}
    >
      <Text color={theme.muted}>
        {tr(' WORKSPACE ')}
        <Text color={theme.accent}>{state.tasks.length}</Text>
      </Text>
      <Text> </Text>
      {state.tasks.slice(start, start + count).map((task) => (
        <Box key={task.id} flexDirection="column" height={4}>
          <Text
            backgroundColor={task.id === state.selectedId ? theme.selected : undefined}
            color={theme.foreground}
            bold={task.id === state.selectedId}
          >
            {clip(`${task.id === state.selectedId ? '›' : ' '} ${task.title}`, 25)}
          </Text>
          <Text color={task.state === 'complete' ? theme.accent : theme.muted}>
            {' '}
            {taskIcon(task)} {tr(labels[task.state])}
          </Text>
          <Text color={theme.muted}>
            {' '}
            {task.id.slice(0, 8)} {task.ref.provider === 'demo' ? tr('· DEMO') : ''}
          </Text>
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text color={theme.muted}>{tr('Ctrl+T choose task')}</Text>
      <Text color={theme.muted}>{tr('Tab switch role')}</Text>
      <Text color={theme.muted}>{tr('/ commands')}</Text>
      <Text> </Text>
      <Text color={theme.accent}>{tr('● Sessions stay on host')}</Text>
      <Text color={theme.muted}>{tr(' Exit safely with Ctrl+Q')}</Text>
    </Box>
  );
}
function overlayRows(model: ConsoleModel, columns: number, height: number): Row[] {
  const tr = model.t;

  const state = model.snapshot(),
    overlay = state.overlay!;
  if (['ticket', 'models', 'notifications', 'language', 'updates'].includes(overlay.kind))
    return planningRows(model, columns, height);
  if (overlay.kind === 'help')
    return markdown(
      tr(
        'KEYBOARD\n\nEnter          Send a message / run a typed command\nTab            Switch author and reviewer (or complete /command)\nCtrl+T         Choose a task\nPgUp / PgDn    Scroll conversation, findings or activity\nShift+Enter    New line (supported terminals)\nCtrl+J         New line on all terminals\nCtrl+A / E     Start / end of line\nCtrl+W         Delete previous word\nCtrl+C         Clear draft, then close the console\nCtrl+Q         Close console; service and agents continue\nEsc            Close a menu or cancel attaching a PR\n\nCOMMANDS\n\n',
      ) + commands.map((command) => command.name.padEnd(12) + tr(command.hint)).join('\n'),
      columns,
    );
  if (overlay.kind === 'attach') {
    const step = overlay.step ?? 0;
    return markdown(
      [
        tr('Connect an existing review'),
        '',
        [tr('1  PR / MR URL'), tr('2  Repository path'), tr('3  Original requirements')]
          .map((label, index) => `${index === step ? '›' : index < step ? '✓' : ' '} ${label}`)
          .join('\n'),
        '',
        [
          tr('Paste a clean HTTPS URL from GitHub, GitLab or Arcanum.'),
          tr('Use an absolute path on the service host. The original working copy is preserved.'),
          tr(
            'Tell both agents what this change should achieve. Paste multiple lines, then press Enter.',
          ),
        ][step],
        '',
        tr('Esc cancels and preserves your current conversation draft.'),
      ].join('\n'),
      columns,
    );
  }
  const tasks = model.taskMatches(),
    count = Math.max(1, Math.floor((height - 3) / 3));
  const start = Math.max(0, Math.min(overlay.index - Math.floor(count / 2), tasks.length - count));
  const rows: Row[] = [
    { text: tr('TASKS · {v0} matches · ↑ / ↓ to choose', { v0: tasks.length }), kind: 'heading' },
    { text: '' },
  ];
  for (let i = start; i < Math.min(tasks.length, start + count); i++)
    rows.push(
      {
        text: `${i === overlay.index ? '›' : ' '} ${clip(tasks[i].title, columns - 2)}`,
        kind: i === overlay.index ? 'accent' : undefined,
      },
      {
        text: `  ${tasks[i].id.slice(0, 8)}  ${tr(labels[tasks[i].state])} · ${tasks[i].ref.provider}`,
        kind: 'muted',
      },
      { text: '' },
    );
  if (!tasks.length)
    rows.push({
      text: state.tasks.length
        ? tr('No tasks match this search.')
        : tr('No tasks yet. Esc, then /demo or /attach.'),
      kind: 'muted',
    });
  return rows;
}
export function TerminalApp({
  model,
  themeName = 'dark',
}: {
  model: ConsoleModel;
  themeName?: 'dark' | 'light';
}) {
  const tr = model.t;

  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const theme = themes[themeName];
  const tall = Math.max(12, rows - 1),
    wide = columns >= 110;
  const compact = rows < 30,
    topHeight = compact ? 1 : 3,
    bottomHeight = compact ? 2 : 3;
  const mainWidth = Math.max(20, columns - (wide ? 30 : 2));
  const textWidth = Math.max(12, mainWidth - 6),
    bodyHeight = Math.max(5, tall - topHeight - bottomHeight);
  const editor = model.editor(),
    layout = editorRows(editor, textWidth - 4);
  const inputRows = Math.min(4, Math.max(1, layout.rows.length));
  const overlay = state.overlay;
  const hiddenComposer =
    overlay?.kind === 'help' ||
    ['notifications', 'language', 'updates'].includes(overlay?.kind ?? '') ||
    (overlay?.kind === 'models' && overlay.step !== 1) ||
    (overlay?.kind === 'ticket' && [3, 5].includes(overlay.step ?? 0));
  const contentHeight = Math.max(
    1,
    bodyHeight -
      2 -
      (compact ? 3 : 4) -
      1 -
      (hiddenComposer ? 0 : inputRows + 2) -
      (state.error || state.notice ? 1 : 0),
  );
  const task = state.detail?.task ?? state.tasks.find((task) => task.id === state.selectedId);
  const active = state.detail?.jobs.find((job) => ['running', 'queued'].includes(job.status));
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active && !state.busy && state.connection !== 'connecting') return;
    const timer = setInterval(() => setFrame((frame) => frame + 1), 140);
    return () => clearInterval(timer);
  }, [!!active, state.busy, state.connection]);
  const menu = model.menu();
  const allRows = useMemo(
    () => contentRows(state, textWidth),
    [
      state.detail,
      state.pending,
      state.role,
      state.view,
      state.locale,
      state.connection,
      textWidth,
      state.tasks.length,
    ],
  );
  const menuHeight = menu.length ? Math.min(6, menu.length) + 2 : 0;
  const available = Math.max(1, contentHeight - menuHeight - 1);
  const pageRows = state.overlay ? overlayRows(model, textWidth, available) : allRows;
  const fromTop = state.view !== 'chat' || state.overlay?.kind === 'help';
  const offset = Math.min(state.scroll, Math.max(0, pageRows.length - available));
  const start =
    state.overlay && state.overlay.kind !== 'help'
      ? 0
      : fromTop
        ? offset
        : Math.max(0, pageRows.length - available - offset);
  const visible = pageRows.slice(start, start + available);
  const scroll = (direction: number) =>
    model.patch({
      scroll: Math.max(
        0,
        Math.min(
          Math.max(0, pageRows.length - available),
          offset + direction * Math.max(1, available - 2),
        ),
      ),
    });
  const input = (value: string, key: Key) => {
    if (key.eventType === 'release') return;
    const current = model.snapshot();
    if (key.ctrl && (value === 'q' || (value === 'd' && !model.editor().text))) {
      exit();
      return;
    }
    if (key.ctrl && value === 'c') {
      if (current.overlay) model.closeOverlay();
      else if (model.editor().text) {
        model.setEditor(emptyEditor());
        model.patch({ notice: tr('Draft cleared. Ctrl+C again closes only this console.') });
      } else exit();
      return;
    }
    if (key.ctrl && value === 't') {
      current.overlay?.kind === 'tasks' ? model.closeOverlay() : model.open('tasks');
      return;
    }
    if (key.escape) {
      if (current.overlay) model.closeOverlay();
      else model.patch({ menuHidden: true, error: undefined });
      return;
    }
    if (
      current.overlay?.kind === 'tasks' &&
      (key.upArrow || key.downArrow || key.pageUp || key.pageDown)
    ) {
      const count = model.taskMatches().length,
        delta = key.upArrow || key.pageUp ? -1 : 1;
      model.patch({
        overlay: {
          ...current.overlay,
          index: Math.max(
            0,
            Math.min(
              count - 1,
              current.overlay.index + delta * (key.pageUp || key.pageDown ? 5 : 1),
            ),
          ),
        },
      });
      return;
    }
    if (key.pageUp || key.pageDown) {
      scroll((key.pageUp ? 1 : -1) * (fromTop ? -1 : 1));
      return;
    }
    if (current.overlay?.kind === 'help') {
      if (key.return) model.closeOverlay();
      return;
    }
    const menu = model.menu();
    const options = choices(model);
    if (options.length && (key.upArrow || key.downArrow)) {
      model.patch({
        overlay: {
          ...current.overlay!,
          index:
            (current.overlay!.index + (key.downArrow ? 1 : options.length - 1)) % options.length,
        },
      });
      return;
    }
    if (menu.length && (key.upArrow || key.downArrow)) {
      model.patch({
        menuIndex: (current.menuIndex + (key.downArrow ? 1 : menu.length - 1)) % menu.length,
      });
      return;
    }
    if (key.tab && !current.overlay) {
      if (menu.length) {
        model.setEditor(insert(emptyEditor(), menu[current.menuIndex % menu.length].name + ' '));
        model.patch({ menuHidden: true });
      } else model.setRole(current.role === 'author' ? 'reviewer' : 'author');
      return;
    }
    if (key.return && !key.shift && !key.meta) {
      if (current.overlay) {
        void model.submitOverlay();
        return;
      }
      const editor = model.editor(),
        text = editor.text.trim();
      if (menu.length && !commands.some((command) => command.name === text)) {
        model.setEditor(insert(emptyEditor(), menu[current.menuIndex % menu.length].name + ' '));
        model.patch({ menuHidden: true });
        return;
      }
      if (!editor.literal && text.startsWith('/') && !text.includes('\n'))
        void model.execute(text).then((result) => {
          if (result === 'exit') exit();
        });
      else void model.send();
      return;
    }
    if (!hiddenComposer) model.setEditor(edit(model.editor(), value, key));
  };
  useInput(input);
  usePaste((text) => model.paste(text));
  if (columns < 50 || rows < 20)
    return (
      <Box width={columns} flexDirection="column">
        <Text color="green">
          {tr('reviewloop ')}
          {VERSION}
        </Text>
        <Text>{tr('Resize to at least 50 × 20.')}</Text>
        <Text>{tr('Ctrl+Q closes this client.')}</Text>
      </Box>
    );
  const editorStart = Math.max(
    0,
    Math.min(layout.cursorRow - inputRows + 1, layout.rows.length - inputRows),
  );
  const spin = ['·', '•', '●', '•'][frame % 4];
  const roleColor = state.role === 'author' ? theme.author : theme.accent;
  return (
    <Box
      width={columns}
      height={tall}
      backgroundColor={theme.background}
      flexDirection="column"
      paddingX={1}
    >
      <Box height={topHeight} paddingX={1} alignItems="center">
        <Text bold color={theme.accent}>
          {tr(' ● reviewloop. ')}
        </Text>
        <Text color={theme.muted}> {VERSION}</Text>
        <Box flexGrow={1} />
        <Text
          color={
            state.connection === 'online'
              ? theme.accent
              : state.connection === 'offline'
                ? theme.error
                : theme.muted
          }
        >
          {state.connection === 'connecting' ? spin : '●'}{' '}
          {state.connection === 'online'
            ? tr('Connected to your service')
            : state.connection === 'offline'
              ? tr('Offline · reconnecting')
              : 'Connecting…'}
        </Text>
      </Box>
      <Box height={bodyHeight}>
        {wide && <Sidebar state={state} height={bodyHeight} theme={theme} />}
        <Box
          width={mainWidth}
          height={bodyHeight}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
          flexDirection="column"
        >
          <Text color={theme.foreground} bold>
            {clip(
              state.overlay
                ? state.overlay.kind === 'tasks'
                  ? tr('Choose a task')
                  : state.overlay.kind === 'attach'
                    ? tr('Attach a review')
                    : state.overlay.kind === 'ticket'
                      ? tr('Start from a ticket')
                      : state.overlay.kind === 'models'
                        ? tr('Agent models')
                        : state.overlay.kind === 'language'
                          ? tr('Language')
                          : state.overlay.kind === 'updates'
                            ? tr('Updates')
                            : state.overlay.kind === 'notifications'
                              ? tr('Telegram notifications')
                              : tr('Keyboard & commands')
                : (task?.title ?? tr('Your review workspace')),
              textWidth,
            )}
          </Text>
          <Text color={theme.muted}>
            {clip(
              state.overlay
                ? tr('Esc to return · your conversation draft is preserved')
                : task
                  ? tr('{v0} · round {v1}/{v2} · {v3} · {v4}{v5}', {
                      v0: tr(labels[task.state]),
                      v1: task.round,
                      v2: task.policy.maxRounds,
                      v3: task.revision?.head.slice(0, 8) ?? 'pending',
                      v4: task.ref.provider.toUpperCase(),
                      v5: task.policy.publication === 'human' ? tr(' · manual publication') : '',
                    })
                  : tr('One host · persistent author and reviewer sessions'),
              textWidth,
            )}
          </Text>
          {!compact && <Text> </Text>}
          <Text color={theme.muted}>
            {state.overlay ? (
              '─'.repeat(textWidth)
            ) : (
              <>
                <Text color={roleColor} bold>
                  {state.role === 'reviewer' ? tr('● REVIEWER') : tr('● AUTHOR')}
                </Text>
                {'  │  '}
                {textWidth < 60
                  ? tr(state.view)
                  : (['chat', 'findings', 'activity', 'context'] as const).map((view) => (
                      <Text
                        key={view}
                        color={state.view === view ? theme.foreground : theme.muted}
                        bold={state.view === view}
                      >
                        {view === state.view ? '› ' : ''}
                        {tr(view)}
                        {'  '}
                      </Text>
                    ))}
              </>
            )}
          </Text>
          <Box flexDirection="column" height={contentHeight} paddingTop={1} overflow="hidden">
            <Lines rows={visible} theme={theme} />
            <Box flexGrow={1} />
            {!!menu.length && (
              <Box flexDirection="column" backgroundColor={theme.panel}>
                <Text color={theme.muted}>{tr('COMMANDS · ↑↓ choose · Tab complete')}</Text>
                {menu
                  .slice(
                    Math.max(0, Math.min(state.menuIndex - 2, menu.length - 6)),
                    Math.max(0, Math.min(state.menuIndex - 2, menu.length - 6)) + 6,
                  )
                  .map((command) => (
                    <Text
                      key={command.name}
                      color={theme.foreground}
                      backgroundColor={
                        command === menu[state.menuIndex % menu.length] ? theme.selected : undefined
                      }
                    >
                      {clip(
                        `${command === menu[state.menuIndex % menu.length] ? '›' : ' '} ${command.name.padEnd(12)} ${tr(command.hint)}`,
                        textWidth,
                      )}
                    </Text>
                  ))}
              </Box>
            )}
          </Box>
          {!hiddenComposer && (
            <Box
              borderStyle="round"
              borderColor={roleColor}
              flexDirection="column"
              height={inputRows + 2}
              paddingX={1}
            >
              {layout.rows.slice(editorStart, editorStart + inputRows).map((line, index) => (
                <Text key={index} color={theme.foreground}>
                  <Text color={roleColor}>{index === 0 ? '❯ ' : '  '}</Text>
                  {line.before}
                  {line.cursor !== undefined && (
                    <Text inverse color={roleColor}>
                      {line.cursor}
                    </Text>
                  )}
                  {line.after}
                  {!editor.text && (
                    <Text color={theme.muted}>
                      {clip(
                        state.overlay
                          ? state.overlay.kind === 'tasks'
                            ? tr('Search tasks…')
                            : state.overlay.kind === 'models' ||
                                (state.overlay.kind === 'ticket' && (state.overlay.step ?? 0) >= 2)
                              ? tr('Filter models…')
                              : state.overlay.kind === 'ticket'
                                ? [
                                    tr('GitHub issue URL or Tracker key'),
                                    tr('Repository path on the service host'),
                                  ][state.overlay.step ?? 0]
                                : [
                                    tr('PR / MR URL'),
                                    tr('Repository path on the service host'),
                                    tr('Original requirements'),
                                  ][state.overlay.step ?? 0]
                          : tr('Message {v0}, or / for commands…', { v0: state.role }),
                        textWidth - 6,
                      )}
                    </Text>
                  )}
                </Text>
              ))}
            </Box>
          )}
          <Text color={theme.muted}>
            {clip(
              state.overlay
                ? state.overlay.kind === 'help'
                  ? tr('Enter / Esc close · PgUp / PgDn scroll')
                  : tr('Enter continue · Esc cancel')
                : `${active || state.busy ? spin + ' ' : ''}${state.pending ? tr('Sending message…') : active ? recentActivity(state.detail, state.locale) : state.role === 'reviewer' ? tr('Private to you and the reviewer') : tr('Separate from the reviewer conversation')}${offset ? tr(' · scrolled') : ''}`,
              textWidth,
            )}
          </Text>
          {(state.error || state.notice) && (
            <Box height={1}>
              <Text color={state.error ? theme.error : theme.accent} wrap="truncate">
                {clip(state.error ?? state.notice, textWidth)}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box height={compact ? 1 : 2} paddingX={1} paddingTop={compact ? 0 : 1}>
        <Text color={theme.muted}>
          {clip(
            columns >= 100
              ? tr(
                  'Enter send  ·  Tab role  ·  Ctrl+T tasks  ·  PgUp/PgDn scroll  ·  Ctrl+J newline  ·  Ctrl+Q quit',
                )
              : tr('Enter send · Tab role · /help · Ctrl+Q quit'),
            columns - 4,
          )}
        </Text>
      </Box>
      <Box height={1} paddingX={1}>
        <Text color={theme.muted}>
          {clip(
            state.connection === 'offline'
              ? (state.connectionError ?? tr('Connection unavailable; drafts preserved.'))
              : state.status
                ? tr(
                    '{v0} active agent · RAM free {v1} GiB · disk free {v2} GiB · service continues after exit',
                    {
                      v0: state.status.activeJobs,
                      v1: state.status.resources.memoryAvailableGiB.toFixed(1),
                      v2: state.status.resources.diskAvailableGiB.toFixed(0),
                    },
                  )
                : tr('Your service and agents continue after closing this console.'),
            columns - 4,
          )}
        </Text>
      </Box>
    </Box>
  );
}
