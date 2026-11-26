import { githubBackoff } from '../providers/github-quota.js';
import { randomUUID } from 'node:crypto';
import { workerSlots } from '../core/worker-pool.js';
import { autoMergeSettings, githubActivityStatus } from '../core/auto-merge.js';
import type { Store } from '../core/store.js';
import type { DaddyJob, Job, ReviewGroup, State } from '../core/types.js';
import { redact } from '../core/security.js';
import { clipTitle } from '../core/session-title.js';
import { translator, type Locale } from '../i18n/index.js';
import type { TelegramApi } from './telegram.js';
import type { TelegramDestination } from './telegram-delivery.js';
import { TelegramText } from './telegram-text.js';
import {
  activityStatus,
  draftSyncPending,
  waitingForDaddy,
  outstandingActivity,
  taskActivity,
  taskReference,
} from '../core/task-activity.js';

const activeStates = new Set<State>([
  'implementing',
  'submitting',
  'queued',
  'reviewing',
  'fixing',
  'awaiting_checks',
  'awaiting_merge',
  'ready_for_review',
  'awaiting_publication',
  'awaiting_push',
]);

function snapshot(store: Store, group: ReviewGroup, jobs: Job[], coordination: DaddyJob[]) {
  const tasks = store.tasks(group.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const workers = jobs.filter((job) => taskById.get(job.taskId)?.generation === job.generation);
  const turns = coordination.filter(
    (job) => job.groupId === group.id && job.generation === group.generation,
  );
  const running = [
    ...turns
      .filter((job) => job.status === 'running')
      .map((job) => ({
        id: job.id,
        subject: group.id,
        startedAt: job.startedAt,
        engine: job.profile.engine,
        label: job.trigger === 'resources' ? 'Checking server resources' : 'Handling your request',
        title: undefined,
      })),
    ...workers
      .filter((job) => job.status === 'running')
      .map((job) => ({
        id: job.id,
        subject: job.taskId,
        startedAt: job.startedAt,
        engine: job.profile?.engine,
        label: activityStatus({ task: taskById.get(job.taskId)!, job }),
        title: taskById.get(job.taskId)!.title,
      })),
  ];
  const preparing = ['pending', 'preparing'].includes(group.workspacePreparation?.state ?? '');
  const activeTask = tasks.find((task) => activeStates.has(task.state));
  const active =
    !group.deletion &&
    !['paused', 'archived'].includes(group.daddyState ?? '') &&
    group.workspacePreparation?.state !== 'error' &&
    (preparing || !!activeTask || turns.length > 0 || workers.length > 0);
  const attention = tasks.find(
    (task) =>
      task.state === 'needs_input' && task.reason !== draftSyncPending && !waitingForDaddy(task),
  );
  const outstanding = taskActivity(
    [...tasks].reverse(),
    workers,
    (task, job) =>
      githubActivityStatus(
        task,
        autoMergeSettings(store, group, task),
        githubBackoff(store, task.ref),
        job,
      ),
    workerSlots(store, group),
  ).filter(outstandingActivity);
  let label = 'No work in progress';
  if (group.deletion) label = 'Saving results and removing session copies';
  else if (group.daddyState === 'paused') label = 'Paused';
  else if (active && group.resourceWait) label = 'Waiting for server resources';
  else if (group.workspacePreparation?.state === 'error')
    label = 'Could not prepare the session copy';
  else if (preparing) label = 'Preparing the session copy';
  else if (running.length) label = 'Work in progress';
  else if (turns.length) label = 'Request saved. Waiting to start.';
  else if (workers.length) label = 'Waiting for a worker';
  else if (activeTask)
    label = activityStatus(outstanding.find(({ task }) => task.id === activeTask.id)!);
  else if (
    group.daddyState === 'needs_input' &&
    store.daddyJobs(group.id).at(-1)?.status === 'failed'
  )
    label = 'Agent run failed';
  else if (attention && store.jobs(attention.id).at(-1)?.status === 'failed')
    label = 'Agent run failed';
  else if (group.daddyState === 'needs_input' || attention) label = 'Action needed';
  else if (outstanding[0]) label = activityStatus(outstanding[0]);
  else if (tasks.length) label = 'All tasks complete';
  else if (store.daddyJobs(group.id).at(-1)?.status === 'completed') label = 'Request finished';
  return {
    active,
    label,
    running,
    tasks: outstanding.map((item) => ({
      id: taskReference(item.task),
      title: clipTitle(item.task.title, 80),
      label: activityStatus(item),
    })),
    attention: attention?.title,
    resources: label === 'Waiting for server resources' ? group.resourceWait?.reasons : undefined,
  };
}

function lastAgentEvent(store: Store, subject: string, runId: string) {
  return store.db
    .prepare(
      `SELECT at FROM events WHERE task_id=? AND run_id=?
       AND type IN ('session.attached','daddy.session_attached','runtime.item','daddy.runtime.item',
                    'runtime.text','daddy.runtime.text','runtime.usage','daddy.runtime.usage',
                    'tool.started','daddy.tool.started')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(subject, runId)?.at as string | undefined;
}

function render(
  store: Store,
  locale: Locale,
  group: ReviewGroup,
  status: ReturnType<typeof snapshot>,
  now: number,
) {
  const t = translator(locale);
  const time = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const text = new TelegramText().add(group.title, 'bold').add('\n' + t(status.label));
  if (status.resources?.length)
    text.add('\n' + status.resources.map((reason) => t(reason)).join('\n'));
  if (status.attention && ['Action needed', 'Agent run failed'].includes(status.label))
    text.add('\n' + status.attention);
  for (const run of status.running.slice(0, 4)) {
    const engine =
      run.engine === 'codex' ? 'Codex' : run.engine === 'claude' ? 'Claude' : run.engine;
    const elapsed = run.startedAt
      ? Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 60000))
      : 0;
    text.add('\n\n');
    if (run.title) text.add(clipTitle(run.title, 100), 'bold').add('\n');
    text.add(
      [engine, t(run.label), elapsed && t('{minutes} min elapsed', { minutes: elapsed })]
        .filter(Boolean)
        .join(' · '),
    );
    const event = lastAgentEvent(store, run.subject, run.id);
    text.add(
      '\n' +
        t(
          event ? 'Last agent activity · {time}' : 'No agent activity received yet',
          event ? { time: time.format(new Date(event)) } : undefined,
        ),
    );
  }
  if (status.tasks.length) {
    text.add('\n\n').add(t('Unfinished tasks · {count}', { count: status.tasks.length }), 'bold');
    for (const task of status.tasks.slice(0, 5))
      text
        .add('\n')
        .add(task.id, 'code')
        .add(' ' + task.title + ' · ' + t(task.label));
    const rest = status.tasks.slice(5, 100);
    if (rest.length) text.add('\n' + rest.map((task) => task.id).join(' '));
  }
  text
    .add('\n\n')
    .add('/task', 'bot_command')
    .add(' · ')
    .add('/queue', 'bot_command')
    .add(' · ')
    .add('/workers', 'bot_command');
  return text.add('\n\n' + t('Server status at {time}', { time: time.format(now) }), 'italic');
}

type StatusRoute = TelegramDestination & { ownerId: number };
type LiveCard = { id: string; route: StatusRoute };
const topicCardKey = (key: string, route: StatusRoute) =>
  `${key}:${route.ownerId}:${route.chatId}:${route.threadId}`;

export class TelegramProgress {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private sent = new Map<string, { cardId: string; at: number; signature: string }>();

  constructor(
    private store: Store,
    private api: TelegramApi,
    private prefix: string,
    private locale: () => Locale,
    private destination: (groupId: string, previous?: StatusRoute) => StatusRoute | undefined,
  ) {}

  card(group: ReviewGroup) {
    return render(
      this.store,
      this.locale(),
      group,
      snapshot(this.store, group, this.store.activeJobs(), this.store.activeDaddyJobs()),
      Date.now(),
    );
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.refresh()
        .catch((error) => {
          try {
            this.store.event('_system', 'telegram.progress_failed', {
              error: redact(String(error)),
            });
          } catch {
            // Retry the refresh on the next tick if SQLite is temporarily unavailable.
          }
        })
        .finally(() => {
          this.pending = undefined;
        });
    }, 5000);
    this.timer.unref();
  }

  private async refresh() {
    const jobs = this.store.activeJobs();
    const coordination = this.store.activeDaddyJobs();
    const cards = new Map(
      this.store.db
        .prepare('SELECT key,value FROM settings WHERE key GLOB ?')
        .all(this.prefix + '*')
        .map((row) => [
          String(row.key).slice(this.prefix.length),
          JSON.parse(String(row.value)) as LiveCard,
        ]),
    );
    const groups = this.store.groups().filter((group) => group.orchestrated && !group.deletedAt);
    const groupIds = new Set(groups.map((group) => group.id));
    for (const [suffix, card] of cards)
      if (!groupIds.has(suffix.split(':', 1)[0])) this.clearCard(this.prefix + suffix, card.id);
    for (const group of groups) {
      if (!this.timer) return;
      await this.update(group, snapshot(this.store, group, jobs, coordination));
    }
  }

  async update(
    group: ReviewGroup,
    status = snapshot(this.store, group, this.store.activeJobs(), this.store.activeDaddyJobs()),
  ) {
    const groupKey = this.prefix + group.id;
    const previous = this.store.setting<LiveCard>(groupKey);
    const route = this.destination(group.id, previous?.route);
    if (!route) {
      this.sent.delete(group.id);
      return;
    }
    const topic = route.threadId !== undefined;
    if (previous?.route.threadId !== undefined) {
      // Older releases kept just the most recent card. Retain its ID by topic.
      this.store.transaction(() => {
        const previousKey = topicCardKey(groupKey, previous.route);
        if (!this.store.setting<LiveCard>(previousKey))
          this.store.setSetting(previousKey, previous);
        this.clearCard(groupKey, previous.id);
      });
    } else if (topic && previous) this.clearCard(groupKey, previous.id);
    const key = topic ? topicCardKey(groupKey, route) : groupKey;
    let card = this.store.setting<LiveCard>(key);
    if (card && (card.route.ownerId !== route.ownerId || card.route.chatId !== route.chatId)) {
      this.clearCard(key, card.id);
      card = undefined;
    }
    if (!card && !topic && !status.active) return;
    const locale = this.locale();
    const signature = JSON.stringify([locale, group.title, status]);
    const last = this.sent.get(group.id);
    const now = Date.now();
    if (
      last &&
      last.cardId === card?.id &&
      last.signature === signature &&
      (!status.active || now - last.at < 60000)
    )
      return;
    if (!card) {
      card = { id: randomUUID(), route };
      this.store.setSetting(key, card);
    }
    const current = { cardId: card.id, at: now, signature };
    this.sent.set(group.id, current);
    try {
      await this.api.send(route, render(this.store, locale, group, status, now), undefined, {
        key: `progress:${card.id}`,
        replace: true,
        final: topic || !status.active,
        pin: topic,
        pinWarning: topic
          ? translator(locale)(
              'Could not pin the session status. Give the bot permission to pin messages.',
            )
          : undefined,
        groupId: group.id,
        sessionRoute: true,
      });
    } catch (error) {
      if (this.sent.get(group.id) === current) this.sent.delete(group.id);
      throw error;
    }
    if (!topic && !status.active && this.sent.get(group.id) === current)
      this.clearCard(key, card.id);
  }

  private clearCard(key: string, id: string) {
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    const groupId = key.slice(this.prefix.length).split(':', 1)[0];
    if (this.sent.get(groupId)?.cardId === id) this.sent.delete(groupId);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
