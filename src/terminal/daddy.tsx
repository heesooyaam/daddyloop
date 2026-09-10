import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { DaddyClient, type DaddyApi } from '../client/daddy.js';
import type { AgentProfiles, Project } from '../core/types.js';
import type { ModelOption } from '../core/agents.js';
import { translator, type Locale } from '../i18n/index.js';
import { edit, emptyEditor, insert, editorRows, type Editor } from './editor.js';
import { clip, markdown, oneLine, type Row } from './text.js';
import type { UpdateStatus } from '../core/updates.js';
import { VERSION } from '../version.js';

type MenuKind =
  | 'sessions'
  | 'projects'
  | 'discover'
  | 'pool'
  | 'help'
  | 'updates'
  | 'notifications'
  | 'model-role'
  | 'model'
  | 'effort';
type MenuState = {
  kind: MenuKind;
  index: number;
  query: string;
  items?: { name: string; path: string }[];
  models?: ModelOption[];
  role?: 'reviewer' | 'author';
  model?: ModelOption;
  message?: string;
  updates?: UpdateStatus;
};
const commands = [
  '/new',
  '/sessions',
  '/projects',
  '/pool',
  '/models',
  '/notifications',
  '/updates',
  '/language',
  '/tasks',
  '/chat',
  '/pause',
  '/resume',
  '/refresh',
  '/help',
  '/quit',
];
export function DaddyTerminal({
  model,
  preferred,
  theme = 'dark',
}: {
  model: DaddyClient;
  preferred?: Locale;
  theme?: 'dark' | 'light';
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot),
    { exit } = useApp(),
    { columns, rows } = useWindowSize();
  const [locale, setLocale] = useState<Locale>(preferred ?? 'en'),
    [menu, setMenu] = useState<MenuState>(),
    [view, setView] = useState<'chat' | 'tasks'>('chat'),
    [scroll, setScroll] = useState(0),
    [emptyDraft, setEmptyDraft] = useState(''),
    [frame, setFrame] = useState(0);
  const editors = useRef(new Map<string, Editor>()),
    key = state.selected || '_new',
    t = translator(locale);
  useEffect(() => {
    if (!preferred && state.status?.preferences) setLocale(state.status.preferences.locale);
  }, [state.status?.preferences?.version]);
  useEffect(() => {
    if (!state.board?.daddyBusy && !state.busy) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 160);
    return () => clearInterval(timer);
  }, [state.board?.daddyBusy, state.busy]);
  useEffect(() => setScroll(0), [state.selected, view, menu?.kind]);
  const colors =
    theme === 'light'
      ? {
          bg: '#f8faf3',
          panel: '#eef2e4',
          ink: '#33412d',
          muted: '#7c8f6b',
          accent: '#607e40',
          line: '#c3d1b2',
          selected: '#dce8c9',
          error: '#a86446',
        }
      : {
          bg: '#10160f',
          panel: '#182016',
          ink: '#dce7d2',
          muted: '#7c8b6d',
          accent: '#c4d998',
          line: '#394631',
          selected: '#304025',
          error: '#e3b393',
        };
  const text = state.selected ? (state.drafts[state.selected] ?? '') : emptyDraft;
  let editor = editors.current.get(key) ?? emptyEditor();
  if (editor.text !== text) {
    editor = insert(emptyEditor(), text);
    editors.current.set(key, editor);
  }
  const setEditor = (next: Editor) => {
    if (!next.text) next.literal = false;
    editors.current.set(key, next);
    if (state.selected) model.draft(next.text);
    else setEmptyDraft(next.text);
  };
  const sidebar = columns >= 104 ? 27 : 0,
    width = Math.max(20, columns - sidebar - 6),
    height = Math.max(5, rows - 14);
  const open = (kind: MenuKind, message?: string) =>
    setMenu({ kind, index: 0, query: '', message });
  const options = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'sessions')
      return state.sessions
        .filter((group) => group.title.toLowerCase().includes(menu.query.toLowerCase()))
        .map((group) => ({
          id: group.id,
          label: group.title,
          detail: `${group.project?.name ?? ''} · ${group.complete}/${group.total}`,
        }));
    if (menu.kind === 'projects')
      return [
        ...state.projects
          .filter((project) => project.name.toLowerCase().includes(menu.query.toLowerCase()))
          .map((project) => ({
            id: project.id,
            label: project.name,
            detail: project.scope || project.repoPath,
          })),
        { id: 'discover', label: t('Find projects on the server'), detail: '' },
      ];
    if (menu.kind === 'discover')
      return (menu.items ?? [])
        .filter((item) => item.name.toLowerCase().includes(menu.query.toLowerCase()))
        .map((item) => ({ id: item.path, label: item.name, detail: item.path }));
    if (menu.kind === 'pool')
      return [1, 2, 3, 4, 5, 6, 7, 8].map((limit) => ({
        id: String(limit),
        label: `${limit} ${t('writers')}`,
        detail: limit === state.board?.writers.limit ? '✓' : '',
      }));
    if (menu.kind === 'notifications')
      return [
        { id: 'attention', label: t('Only important updates'), detail: '' },
        { id: 'all', label: t('All updates'), detail: '' },
        { id: 'off', label: t('Mute notifications'), detail: '' },
      ];
    if (menu.kind === 'model-role')
      return [
        {
          id: 'reviewer',
          label: 'Daddy',
          detail: state.board?.group.reviewer.model ?? t('Codex configuration'),
        },
        {
          id: 'author',
          label: t('New writers'),
          detail: state.board?.group.writer?.model ?? t('Codex configuration'),
        },
      ];
    if (menu.kind === 'model')
      return (menu.models ?? [])
        .filter((model) => model.id.toLowerCase().includes(menu.query.toLowerCase()))
        .map((model) => ({ id: model.id, label: model.name, detail: model.id }));
    if (menu.kind === 'effort')
      return (menu.model?.efforts ?? []).map((effort) => ({
        id: effort,
        label: effort,
        detail: effort === menu.model?.defaultEffort ? t('Default') : '',
      }));
    return [];
  }, [menu, state.projects, state.sessions, state.board, locale]);
  const choose = async () => {
    if (!menu) return;
    const item = options[menu.index % Math.max(1, options.length)];
    if (!item) return;
    try {
      if (menu.kind === 'sessions') {
        await model.select(item.id);
        setMenu(undefined);
      } else if (menu.kind === 'projects') {
        if (item.id === 'discover') {
          const items = await model.api<{ name: string; path: string }[]>('/projects/suggestions');
          setMenu({ ...menu, kind: 'discover', items, index: 0, query: '' });
        } else {
          await model.create(item.id, menu.message);
          setMenu(undefined);
          setEmptyDraft('');
        }
      } else if (menu.kind === 'discover') {
        await model.api<Project>('/projects', { name: item.label, path: item.id });
        await model.refresh();
        setMenu({ ...menu, kind: 'projects', query: '', index: 0 });
      } else if (menu.kind === 'pool') {
        await model.action('settings', { writerLimit: Number(item.id) });
        if (!model.snapshot().error) setMenu(undefined);
      } else if (menu.kind === 'notifications') {
        await model.api('/notifications', {
          enabled: item.id !== 'off',
          mode: item.id === 'all' ? 'all' : 'attention',
        });
        setMenu(undefined);
      } else if (menu.kind === 'model-role') {
        const result = await model.api<{ models: ModelOption[]; error?: string }>(
          '/agents?refresh=1',
        );
        if (result.error) throw new Error(result.error);
        setMenu({
          kind: 'model',
          index: 0,
          query: '',
          models: result.models,
          role: item.id as 'author' | 'reviewer',
        });
      } else if (menu.kind === 'model') {
        const selected = menu.models?.find((model) => model.id === item.id);
        if (selected) setMenu({ ...menu, kind: 'effort', model: selected, index: 0, query: '' });
      } else if (menu.kind === 'effort' && state.board && menu.role && menu.model) {
        const profiles: AgentProfiles = {
          reviewer: state.board.group.reviewer,
          author: state.board.group.writer ?? { engine: 'codex' },
        };
        profiles[menu.role] = { engine: 'codex', model: menu.model.id, effort: item.id };
        await model.action('settings', { profiles });
        if (!model.snapshot().error) setMenu(undefined);
      }
    } catch (error) {
      model.error((error as Error).message);
    }
  };
  const execute = async (value: string) => {
    const [name, ...rest] = value.trim().split(/\s+/),
      argument = rest.join(' ');
    setEditor(emptyEditor());
    if (name === '/quit') {
      exit();
      return;
    }
    if (name === '/new' || name === '/projects') {
      open('projects', argument || undefined);
      return;
    }
    if (name === '/sessions') {
      open('sessions');
      return;
    }
    if (name === '/help') {
      open('help');
      return;
    }
    if (name === '/tasks') {
      setView('tasks');
      return;
    }
    if (name === '/chat') {
      setView('chat');
      return;
    }
    if (name === '/refresh') {
      await model.refresh();
      return;
    }
    if (name === '/language') {
      const next = argument === 'ru' ? 'ru' : argument === 'en' ? 'en' : undefined;
      if (!next) throw new Error('Use /language en or /language ru');
      await model.api('/preferences', { locale: next });
      setLocale(next);
      return;
    }
    if (name === '/updates') {
      const updates = await model.api<UpdateStatus>('/updates/check', {});
      setMenu({ kind: 'updates', index: 0, query: '', updates });
      return;
    }
    if (name === '/notifications') {
      open('notifications');
      return;
    }
    if (!state.selected) throw new Error(t('Start a Daddy session first.'));
    if (name === '/pool') {
      if (argument) await model.action('settings', { writerLimit: Number(argument) });
      else open('pool');
      return;
    }
    if (name === '/models') {
      open('model-role');
      return;
    }
    if (name === '/pause' || name === '/resume') {
      await model.action(name === '/pause' ? 'pause' : 'resume');
      return;
    }
    throw new Error(t('Use /help to see the Daddy commands.'));
  };
  const content: Row[] = [];
  if (menu) {
    const headings: Record<MenuKind, string> = {
      sessions: 'Sessions',
      projects: 'Choose a project',
      discover: 'Projects on this server',
      pool: 'Writer pool',
      help: 'Daddyloop commands',
      updates: 'CLI updates',
      notifications: 'Notifications',
      'model-role': 'Choose a role',
      model: 'Choose a model',
      effort: 'Reasoning effort',
    };
    content.push({ text: t(headings[menu.kind]), kind: 'heading' }, { text: '' });
    if (menu.kind === 'help')
      content.push(
        ...markdown(
          t(
            'Talk to Daddy in plain language. Paste goals or ticket links; he handles the writers.',
          ) +
            '\n\n' +
            commands.join('  ') +
            '\n\n' +
            t(
              'Ctrl+N new session · Ctrl+T sessions · Tab chat/tasks · PgUp/PgDn scroll · Ctrl+Q exit',
            ) +
            '\n\n' +
            t(
              'Register folders with daddy projects add <path> --name <name>, or use Projects on the website.',
            ),
          width,
        ),
      );
    else if (menu.kind === 'updates') {
      for (const tool of menu.updates?.tools ?? [])
        content.push(
          {
            text: `${tool.name}: ${tool.installed ?? '—'} → ${tool.latest ?? '—'}`,
            kind: 'accent',
          },
          { text: tool.error ?? t(tool.updateAvailable ? 'Update available' : 'Up to date') },
          { text: '' },
        );
      content.push(
        ...markdown(
          t(
            'Install or roll back Codex from /updates in Telegram, or use daddy runtime update --yes.',
          ),
          width,
        ),
      );
    } else {
      if (menu.query) content.push({ text: '⌕ ' + menu.query }, { text: '' });
      const start = Math.max(0, menu.index - Math.floor((height - 3) / 3));
      for (const [index, item] of options.entries())
        if (index >= start && content.length < height - 2) {
          content.push({
            text: (index === menu.index ? '› ' : '  ') + item.label,
            kind: index === menu.index ? 'accent' : undefined,
          });
          if (item.detail) content.push({ text: '  ' + item.detail });
          content.push({ text: '' });
        }
      content.push({ text: t('↑ ↓ choose · Enter confirm · Esc back') });
    }
  } else if (!state.board) {
    content.push(
      { text: t('You bring the idea. Daddy takes it from here.'), kind: 'heading' },
      { text: '' },
      ...markdown(
        t(
          'Choose a project and talk to one agent. Daddy turns the goal into tasks, manages a pool of writers and reviews their work.',
        ),
        width,
      ),
      { text: '' },
      { text: '/new      ' + t('Start a session') },
      { text: '/projects ' + t('Choose a project') },
      { text: '/help     ' + t('Commands and shortcuts') },
    );
  } else if (view === 'tasks') {
    content.push(
      {
        text: t('Writer pool') + `: ${state.board.writers.active}/${state.board.writers.limit}`,
        kind: 'heading',
      },
      { text: t('Daddy decides what can run in parallel.') },
      { text: '' },
    );
    for (const task of state.board.tasks)
      content.push(
        ...markdown(
          `${task.state === 'complete' ? '✓' : task.running ? '◌' : '·'} **${task.title}**\n${task.state} · ${task.id.slice(0, 8)}${task.dependsOn.length ? ' · ' + t('Prerequisites: {count}', { count: task.dependsOn.length }) : ''}`,
          width,
        ),
        { text: '' },
      );
    if (!state.board.tasks.length)
      content.push(
        ...markdown(
          t('Daddy will put the plan and work items here as you discuss the goal.'),
          width,
        ),
      );
  } else {
    if (!state.board.messages.length)
      content.push(
        { text: 'Daddy', kind: 'heading' },
        ...markdown(
          t('Send me the goal. I will take care of the writers, reviews and follow-through.'),
          width,
        ),
        { text: '' },
      );
    for (const message of state.board.messages.slice(-60))
      content.push(
        {
          text:
            (message.sender === 'user'
              ? t('You')
              : message.sender === 'system'
                ? 'Daddyloop'
                : 'Daddy') +
            '  ' +
            new Date(message.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
          kind: 'heading',
        },
        ...markdown(message.text, width),
        { text: '' },
      );
    if (state.board.daddyBusy)
      content.push({
        text: ['·', '•', '●', '•'][frame % 4] + ' ' + t('Daddy is working'),
        kind: 'accent',
      });
  }
  const offset = Math.min(scroll, Math.max(0, content.length - height)),
    from = menu || view === 'tasks' ? offset : Math.max(0, content.length - height - offset),
    visible = content.slice(from, from + height);
  useInput((input, keyInfo) => {
    if (keyInfo.eventType === 'release') return;
    if (keyInfo.ctrl && input === 'q') {
      exit();
      return;
    }
    if (keyInfo.ctrl && input === 'c') {
      if (menu) setMenu(undefined);
      else if (editor.text) setEditor(emptyEditor());
      else exit();
      return;
    }
    if (keyInfo.ctrl && input === 'n') {
      open('projects');
      return;
    }
    if (keyInfo.ctrl && input === 't') {
      open('sessions');
      return;
    }
    if (keyInfo.escape) {
      setMenu(undefined);
      return;
    }
    if (menu && options.length && (keyInfo.upArrow || keyInfo.downArrow)) {
      setMenu({
        ...menu,
        index: (menu.index + (keyInfo.downArrow ? 1 : options.length - 1)) % options.length,
      });
      return;
    }
    if (keyInfo.pageUp || keyInfo.pageDown) {
      setScroll((value) =>
        Math.max(
          0,
          Math.min(
            Math.max(0, content.length - height),
            value + (keyInfo.pageUp ? 1 : -1) * Math.max(3, height - 3),
          ),
        ),
      );
      return;
    }
    if (keyInfo.tab && !menu) {
      const found = commands.find(
        (command) => editor.text.startsWith('/') && command.startsWith(editor.text),
      );
      if (found) setEditor(insert(emptyEditor(), found + ' '));
      else setView(view === 'chat' ? 'tasks' : 'chat');
      return;
    }
    if (menu) {
      if (keyInfo.return) {
        if (menu.kind === 'help' || menu.kind === 'updates') setMenu(undefined);
        else void choose();
        return;
      }
      if (['sessions', 'projects', 'discover', 'model'].includes(menu.kind)) {
        const query = edit(insert(emptyEditor(), menu.query), input, keyInfo).text;
        setMenu({ ...menu, query, index: 0 });
      }
      return;
    }
    if (keyInfo.return && !keyInfo.shift && !keyInfo.meta) {
      if (editor.text.startsWith('/') && !editor.literal && !editor.text.includes('\n'))
        void execute(editor.text).catch((error) => model.error(error.message));
      else if (!state.selected) {
        open('projects', editor.text.trim() || undefined);
      } else void model.send();
      return;
    }
    setEditor(edit(editor, input, keyInfo));
  });
  usePaste((value) => {
    if (menu) {
      setMenu({ ...menu, query: menu.query + value.replace(/[\r\n]/g, ' '), index: 0 });
      return;
    }
    setEditor({ ...insert(editor, value), literal: true });
  });
  const editorLayout = editorRows(editor, width - 2),
    editorLines = editorLayout.rows.slice(
      Math.max(0, editorLayout.cursorRow - 2),
      Math.max(0, editorLayout.cursorRow - 2) + 3,
    );
  if (columns < 45 || rows < 18)
    return (
      <Box flexDirection="column">
        <Text color={colors.accent}>daddyloop {VERSION}</Text>
        <Text>{t('Resize to at least 50 × 20.')}</Text>
        <Text>{t('Ctrl+Q closes this client.')}</Text>
      </Box>
    );
  return (
    <Box
      width={columns}
      height={rows}
      backgroundColor={colors.bg}
      flexDirection="column"
      paddingX={1}
    >
      <Box height={3} alignItems="center" paddingX={1}>
        <Text bold color={colors.accent}>
          {' '}
          ● daddyloop.{' '}
        </Text>
        <Text color={colors.muted}>{VERSION}</Text>
        <Box flexGrow={1} />
        <Text color={colors.muted}>
          {t(state.connected ? '● Sessions stay on host' : 'Connecting to server')}
        </Text>
      </Box>
      <Box flexGrow={1} minHeight={0}>
        {!!sidebar && (
          <Box
            width={sidebar}
            flexDirection="column"
            paddingX={1}
            borderStyle="single"
            borderTop={false}
            borderLeft={false}
            borderBottom={false}
            borderColor={colors.line}
          >
            <Text color={colors.muted}>{t('YOUR SESSIONS')}</Text>
            <Text> </Text>
            {state.sessions.slice(0, Math.max(1, Math.floor((rows - 13) / 3))).map((group) => (
              <Box key={group.id} flexDirection="column" height={3}>
                <Text
                  color={group.id === state.selected ? colors.accent : colors.ink}
                  bold={group.id === state.selected}
                >
                  {clip((group.id === state.selected ? '› ' : '  ') + group.title, sidebar - 3)}
                </Text>
                <Text color={colors.muted}>
                  {' '}
                  {clip(
                    `${group.complete}/${group.total} · ${group.project?.name ?? ''}`,
                    sidebar - 5,
                  )}
                </Text>
              </Box>
            ))}
            <Box flexGrow={1} />
            <Text color={colors.muted}>Ctrl+N {t('new')}</Text>
            <Text color={colors.muted}>Ctrl+T {t('sessions')}</Text>
            <Text> </Text>
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1} paddingX={1} minWidth={0}>
          <Box height={2}>
            <Text bold color={colors.ink}>
              {clip(state.board?.group.title ?? t('What are we building?'), width - 8)}
            </Text>
            <Box flexGrow={1} />
            <Text color={colors.muted}>{view === 'chat' ? 'Daddy' : t('Tasks')}</Text>
          </Box>
          <Box height={height} flexDirection="column" overflow="hidden">
            {visible.map((row, index) => (
              <Text
                key={index}
                color={
                  row.kind === 'heading'
                    ? colors.ink
                    : row.kind === 'accent'
                      ? colors.accent
                      : row.kind === 'code'
                        ? colors.accent
                        : colors.muted
                }
                bold={row.kind === 'heading'}
              >
                {clip(row.text, width)}
              </Text>
            ))}
          </Box>
          <Box flexGrow={1} />
          {state.error && <Text color={colors.error}>{clip(oneLine(t(state.error)), width)}</Text>}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={colors.line}
            paddingX={1}
            minHeight={5}
          >
            {editorLines.length ? (
              editorLines.map((line, index) => (
                <Text key={index} color={colors.ink}>
                  {line.before}
                  {line.cursor !== undefined && (
                    <Text color={colors.bg} backgroundColor={colors.accent}>
                      {line.cursor}
                    </Text>
                  )}
                  {line.after}
                </Text>
              ))
            ) : (
              <Text color={colors.muted}>{t('A goal, a ticket link, or a question…')}</Text>
            )}
            <Box flexGrow={1} />
            <Text color={colors.muted}>
              {state.busy
                ? '…'
                : state.board
                  ? t('Writers: {active} / {limit}', state.board.writers)
                  : t('Start a Daddy session first.')}
            </Text>
          </Box>
          <Box height={1}>
            <Text color={colors.muted}>
              {clip(t('Enter send · Ctrl+J newline · /help · Ctrl+Q exit'), width)}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
export async function runDaddyTerminal(
  api: DaddyApi,
  options: { id?: string; locale?: Locale; theme?: 'dark' | 'light' } = {},
) {
  const model = new DaddyClient(api, options.id),
    instance = render(
      <DaddyTerminal model={model} preferred={options.locale} theme={options.theme} />,
      {
        alternateScreen: true,
        interactive: true,
        exitOnCtrlC: false,
        maxFps: 20,
        patchConsole: false,
      },
    );
  const stop = () => instance.unmount();
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  model.start();
  try {
    await instance.waitUntilExit();
  } finally {
    model.stop();
    instance.cleanup();
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
  process.stdout.write(
    translator(model.snapshot().status?.preferences.locale ?? options.locale ?? 'en')(
      'Daddyloop console closed. Work continues on the server.',
    ) + '\n',
  );
}
