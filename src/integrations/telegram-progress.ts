import { randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import type { DaddyJob, Job, ReviewGroup, State } from '../core/types.js';
import { redact } from '../core/security.js';
import { translator, type Locale } from '../i18n/index.js';
import type { TelegramApi } from './telegram.js';
import type { TelegramDestination } from './telegram-delivery.js';
import { TelegramText } from './telegram-text.js';

const statusLabels: Record<State, string> = {
  discussing: 'Waiting for assignment',
  implementing: 'Implementing the task',
  ready_for_review: 'Ready for review',
  submitting: 'Submitting the changes',
  queued: 'Waiting for a worker',
  reviewing: 'Reviewing the changes',
  awaiting_publication: 'Review ready to publish',
  fixing: 'Addressing review feedback',
  awaiting_push: 'Waiting for changes to be pushed',
  awaiting_checks: 'Waiting for CI',
  awaiting_plan_approval: 'Waiting for plan approval',
  needs_input: 'Action needed',
  paused: 'Paused',
  complete: 'Complete',
};

export function taskStatus(state: State, queued: boolean) {
  return queued && state !== 'paused' ? 'Waiting for a worker' : statusLabels[state];
}

const activeStates = new Set<State>([
  'implementing',
  'submitting',
  'queued',
  'reviewing',
  'fixing',
  'awaiting_checks',
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
        label: taskStatus(taskById.get(job.taskId)!.state, false),
        title: taskById.get(job.taskId)!.title,
      })),
  ];
  const preparing = ['pending', 'preparing'].includes(group.workspacePreparation?.state ?? '');
  const activeTask = tasks.find(
    (task) =>
      activeStates.has(task.state) ||
      (task.state === 'ready_for_review' && task.policy.autoPush) ||
      (task.state === 'awaiting_publication' && task.policy.publication === 'auto'),
  );
  const active =
    !group.deletion &&
    !['paused', 'archived'].includes(group.daddyState ?? '') &&
    group.workspacePreparation?.state !== 'error' &&
    (preparing || !!activeTask || turns.length > 0 || workers.length > 0);
  const attention = tasks.find((task) => task.state === 'needs_input');
  const unfinished = tasks.find((task) => task.state !== 'complete');
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
  else if (activeTask) label = statusLabels[activeTask.state];
  else if (
    group.daddyState === 'needs_input' &&
    store.daddyJobs(group.id).at(-1)?.status === 'failed'
  )
    label = 'Agent run failed';
  else if (attention && store.jobs(attention.id).at(-1)?.status === 'failed')
    label = 'Agent run failed';
  else if (group.daddyState === 'needs_input' || attention) label = 'Action needed';
  else if (unfinished) label = statusLabels[unfinished.state];
  else if (tasks.length) label = 'All tasks complete';
  else if (store.daddyJobs(group.id).at(-1)?.status === 'completed') label = 'Request finished';
  return {
    active,
    label,
    running,
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
    if (run.title) text.add(run.title, 'bold').add('\n');
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
  return text.add('\n\n' + t('Server status at {time}', { time: time.format(now) }), 'italic');
}

type StatusRoute = TelegramDestination & { ownerId: number };
type LiveCard = { id: string; route: StatusRoute };

export class TelegramProgress {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private sent = new Map<string, { at: number; signature: string }>();

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
    const groups = new Set([
      ...cards.keys(),
      ...[...jobs, ...coordination].map((job) => job.groupId),
    ]);
    for (const groupId of groups) {
      if (!this.timer) return;
      if (!groupId) continue;
      const key = this.prefix + groupId;
      let card = cards.get(groupId);
      const group = this.store.getGroup(groupId);
      if (!group.orchestrated || group.deletedAt) {
        if (card) this.clearCard(key, card.id);
        continue;
      }
      const route = this.destination(groupId, card?.route);
      if (!route) continue;
      if (
        card &&
        (card.route.ownerId !== route.ownerId ||
          card.route.chatId !== route.chatId ||
          card.route.threadId !== route.threadId)
      ) {
        this.clearCard(key, card.id);
        card = undefined;
      }
      const status = snapshot(this.store, group, jobs, coordination);
      if (!card && !status.active) continue;
      const locale = this.locale();
      const signature = JSON.stringify([locale, group.title, status]);
      const last = card && this.sent.get(card.id);
      const now = Date.now();
      if (last && last.signature === signature && now - last.at < 60000) continue;
      if (!card) {
        card = { id: randomUUID(), route };
        this.store.setSetting(key, card);
      }
      await this.api.send(route, render(this.store, locale, group, status, now), undefined, {
        key: `progress:${card.id}`,
        replace: true,
        final: !status.active,
      });
      if (status.active) this.sent.set(card.id, { at: now, signature });
      else this.clearCard(key, card.id);
    }
  }

  private clearCard(key: string, id: string) {
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    this.sent.delete(id);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
