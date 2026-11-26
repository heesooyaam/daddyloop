import { parseArgs } from 'node:util';
import { redact } from '../core/security.js';
import { clipTitle } from '../core/session-title.js';
import {
  sameAgentProfile,
  type AgentProfile,
  type Task,
  type WorkerRequest,
  type WorkerSlot,
} from '../core/types.js';
import {
  activityStatus,
  activityReason,
  mergeabilityStatus,
  waitingForMergeability,
  outstandingActivity,
  profileText,
  queueDetail,
  taskReference,
  type TaskActivity,
} from '../core/task-activity.js';
import { translator, type Locale } from '../i18n/index.js';
import { safeLink, TelegramText, type TelegramCard } from './telegram-text.js';

export const taskCommands = /^\/(task|queue|workers|worker)(?:\s+([\s\S]+))?$/;
export const taskReferenceId = (text: string) =>
  /^(?:DADDY-([a-f0-9]{8})|([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))$/i
    .exec(text)
    ?.slice(1)
    .find(Boolean)
    ?.toLowerCase();

export function parseTaskInput(args: string, engine: string, architectEngine = engine) {
  if (!args) return;
  if (!args.startsWith('--')) return { requirements: args };
  const separator = /(?:^|\s)--\s+/.exec(args);
  if (!separator) {
    const single = /^--(no-plan|plan)\s+(?!-)([\s\S]+)$/.exec(args);
    return single && single[2].trim()
      ? { requirements: single[2].trim(), validatePlan: single[1] === 'plan' }
      : undefined;
  }
  const requirements = args.slice(separator.index + separator[0].length).trim();
  if (!requirements) return;
  try {
    const { values } = parseArgs({
      args: args.slice(0, separator.index).trim().split(/\s+/).filter(Boolean),
      options: {
        plan: { type: 'boolean' },
        'no-plan': { type: 'boolean' },
        'architect-model': { type: 'string' },
        'architect-engine': { type: 'string' },
        'architect-effort': { type: 'string' },
        worker: { type: 'string' },
        engine: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
    });
    if ((values.plan || values['architect-model']) && values['no-plan']) return;
    if (!values['architect-model'] && (values['architect-engine'] || values['architect-effort']))
      return;
    if (values.worker && !/^[1-8]$/.test(values.worker)) return;
    if (!values.model && (values.engine || values.effort)) return;
    const workerRequest: WorkerRequest = {
      slot: values.worker ? Number(values.worker) : undefined,
      profile: values.model
        ? { engine: values.engine ?? engine, model: values.model, effort: values.effort }
        : undefined,
    };
    return {
      requirements,
      workerRequest,
      validatePlan: values['no-plan'] ? false : values.plan,
      architectProfile: values['architect-model']
        ? {
            engine: values['architect-engine'] ?? architectEngine,
            model: values['architect-model'],
            effort: values['architect-effort'],
          }
        : undefined,
    };
  } catch {
    return;
  }
}

export function parseWorkerInput(args: string) {
  try {
    const { positionals, values } = parseArgs({
      args: args.split(/\s+/),
      options: { engine: { type: 'string' }, force: { type: 'boolean' } },
      allowPositionals: true,
    });
    const [slot, model, effort] = positionals;
    if (positionals.length > 3 || !slot || !/^[1-8]$/.test(slot) || !model) return;
    return { number: Number(slot), model, effort, engine: values.engine, force: values.force };
  } catch {
    return;
  }
}

function taskButton(task: Task, page = 0) {
  return {
    text: taskReference(task),
    callback_data: `dad:task:${task.id}${page ? `:${page}` : ''}`,
  };
}

export function queueButtons(groupId: string, locale: Locale, page = 0) {
  const t = translator(locale);
  return [
    { text: t('Task queue'), callback_data: `dad:queue:${groupId}${page ? `:${page}` : ''}` },
    { text: t('Workers'), callback_data: `dad:workers:${groupId}` },
  ];
}

function queueStatus(item: TaskActivity) {
  const { task, job, assignedWorker, mergeStatus } = item;
  const label = activityStatus(item);
  if (label === 'Task discussion in progress') return { label };
  const detail = queueDetail(task);
  if (mergeStatus) {
    if (label.startsWith(mergeabilityStatus + ' · ')) return { label, detail };
    if (label.startsWith('Waiting for GitHub API quota until '))
      return { label: 'Waiting for GitHub quota', detail: label };
    if (label.includes(' · retry at ')) return { label, detail };
    if (label === 'Draft PR: mark it ready for review on GitHub')
      return { label: 'Action needed', detail: label };
    if (label !== 'Checking GitHub auto-merge' && label !== 'Merged on GitHub')
      return { label: 'GitHub auto-merge', detail: label };
    return { label };
  }
  if (task.state === 'needs_input') {
    if (label === 'Checking the GitHub draft') return { label };
    if (label === 'Waiting for your answer') return { label, detail };
    return { label: 'Action needed', detail: label === 'Action needed' ? detail : label };
  }
  if (task.state === 'paused') return { label: 'Paused' };
  if (task.state === 'fixing' && task.fixingMergeConflict) {
    if (job?.status === 'running') return { label: 'Merge conflict', detail: label };
    return {
      label: assignedWorker === undefined ? 'Waiting for a worker' : 'Waiting to start',
      detail: label,
    };
  }
  if (label === 'Assigned worker is waiting to start') return { label: 'Waiting to start' };
  return { label, detail };
}

function elapsedMinutes(startedAt: string | undefined, now: number) {
  const minutes = Math.floor((now - Date.parse(startedAt ?? '')) / 60_000);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : undefined;
}

function taskRunLine(t: ReturnType<typeof translator>, item: TaskActivity, now: number) {
  const { task, job, assignedWorker } = item;
  const running = job?.status === 'running';
  const reviewing = running && job.role === 'reviewer';
  const requestedWorker = task.workerRequest?.slot;
  const parts = [];
  if (reviewing) parts.push(t('Shared reviewer'));
  else if (assignedWorker !== undefined)
    parts.push(t('Worker {number}', { number: assignedWorker }));
  else if (running) parts.push(t('Worker'));
  else if (requestedWorker !== undefined)
    parts.push(t('Requested worker {number}', { number: requestedWorker }));
  const minutes = running ? elapsedMinutes(job.startedAt, now) : undefined;
  if (minutes !== undefined)
    parts.push(minutes ? t('{minutes} min elapsed', { minutes }) : t('<1 min elapsed'));
  if (reviewing && assignedWorker !== undefined)
    parts.push(t('Author worker {number}', { number: assignedWorker }));
  else if (running && requestedWorker !== undefined && assignedWorker === undefined)
    parts.push(t('Requested author worker {number}', { number: requestedWorker }));
  return parts.join(' · ');
}

export function queueCard(
  locale: Locale,
  groupId: string,
  activity: TaskActivity[],
  {
    page: requestedPage = 0,
    now = Date.now(),
    readFirstStarts,
  }: {
    page?: number;
    now?: number;
    readFirstStarts?: (taskIds: string[]) => ReadonlyMap<string, string>;
  } = {},
): TelegramCard {
  const t = translator(locale);
  const tasks = activity.filter(outstandingActivity);
  const pageSize = 9;
  const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
  const firstStarts = readFirstStarts?.(visible.map(({ task }) => task.id));
  const text = new TelegramText().add(t('Task queue'), 'bold');
  if (pageCount > 1) text.add(` · ${page + 1}/${pageCount}`);
  const buttons: NonNullable<TelegramCard['buttons']> = [];
  if (!tasks.length) text.add('\n\n' + t('No unfinished tasks.'));
  for (const item of visible) {
    const { task } = item;
    const { label, detail } = queueStatus(item);
    const status = t(label);
    const run = taskRunLine(t, item, now);
    const taskMinutes = elapsedMinutes(firstStarts?.get(task.id), now);
    text
      .add('\n\n')
      .add(clipTitle(task.title.replace(/\s+/g, ' ').trim(), 90), 'bold')
      .add('\n')
      .add(taskReference(task), 'code')
      .add(' · ' + status);
    if (taskMinutes !== undefined)
      text.add(
        ' · ' +
          (taskMinutes
            ? t('{minutes} min since work began', { minutes: taskMinutes })
            : t('<1 min since work began')),
      );
    if (run) text.add('\n' + run);
    const line = detail ? t(redact(detail)).replace(/\s+/g, ' ').trim() : '';
    if (line && line !== status)
      text.add('\n').add(line.length > 140 ? clipTitle(line, 139) + '…' : line, 'italic');
  }
  for (let start = 0; start < visible.length; start += 3)
    buttons.push(visible.slice(start, start + 3).map(({ task }) => taskButton(task, page)));
  const pages = [];
  if (page > 0)
    pages.push({ text: t('Previous page'), callback_data: `dad:queue:${groupId}:${page - 1}` });
  if (page + 1 < pageCount)
    pages.push({ text: t('Next page'), callback_data: `dad:queue:${groupId}:${page + 1}` });
  if (pages.length) buttons.push(pages);
  buttons.push([{ text: t('Back'), callback_data: `dad:open:${groupId}` }]);
  return { ...text, buttons };
}

export function workersCard(
  locale: Locale,
  groupId: string,
  slots: WorkerSlot[],
  activity: TaskActivity[],
  defaultProfile: AgentProfile,
): TelegramCard {
  const t = translator(locale);
  const text = new TelegramText().add(t('Workers'), 'bold');
  for (const slot of slots) {
    const item = activity.find(({ task }) => task.id === slot.taskId);
    const configured = slot.profile ?? defaultProfile;
    const profile =
      item?.job?.role === 'author'
        ? (item.job.profile ?? item.task.agents?.worker ?? configured)
        : (item?.task.agents?.worker ?? configured);
    text
      .add('\n\n')
      .add(t('Worker {number}', { number: slot.number }), 'bold')
      .add(' · ' + profileText(profile));
    if (item)
      text
        .add('\n')
        .add(taskReference(item.task), 'code')
        .add('  ' + clipTitle(item.task.title, 90))
        .add('\n' + t(activityStatus(item)));
    else text.add('\n' + t('Free'));
    if (!sameAgentProfile(profile, configured))
      text.add('\n' + t('Next task · {profile}', { profile: profileText(configured) }));
  }
  text.add('\n\n' + t('Change a model with /worker NUMBER MODEL [EFFORT].'));
  return { ...text, buttons: [[{ text: t('Back'), callback_data: `dad:open:${groupId}` }]] };
}

export function taskCard(
  locale: Locale,
  item: TaskActivity,
  slot?: WorkerSlot,
  merge?: ReturnType<typeof import('../core/auto-merge.js').autoMergeSettings>,
  queuePage = 0,
): TelegramCard {
  const t = translator(locale);
  const { task, job } = item;
  const { label, detail } = queueStatus(item);
  const status = t(label);
  const run = taskRunLine(t, item, Date.now());
  const profile =
    job?.status === 'running'
      ? (job.profile ?? (job.role === 'author' ? task.agents?.worker : undefined))
      : slot
        ? task.agents?.worker
        : task.workerRequest?.profile;
  const text = new TelegramText()
    .add(taskReference(task), 'code')
    .add('  ' + task.title, 'bold')
    .add('\n' + status);
  if (run) text.add('\n' + run);
  if (profile) text.add('\n' + profileText(profile));
  const showReason =
    waitingForMergeability(task) ||
    (job?.status !== 'running' && !item.mergeStatus) ||
    (task.state === 'needs_input' &&
      (queueDetail(task) !== undefined || activityStatus({ task }) !== 'Action needed')) ||
    (task.state === 'fixing' && task.fixingMergeConflict);
  const explanations = new Set(
    [detail, showReason ? activityReason(task) : undefined].map((value) =>
      value ? t(redact(value)).trim() : '',
    ),
  );
  for (const explanation of explanations)
    if (explanation && explanation !== status) text.add('\n\n' + clipTitle(explanation, 1000));
  if (task.state === 'complete' && task.ref.kind === 'ticket' && task.summary)
    text.add('\n\n').markdown(redact(task.summary));
  const url = safeLink(task.ref.url);
  if (url && task.ref.kind !== 'ticket') text.add('\n\n').add('PR', 'text_link', { url });
  const buttons = [queueButtons(task.groupId!, locale, queuePage)];
  if (
    task.ref.kind === 'ticket' &&
    task.state !== 'complete' &&
    (task.planning || task.state === 'discussing')
  )
    buttons.push([{ text: t('Architect'), callback_data: `dad:arch-task:${task.id}` }]);
  if (merge) {
    text.add('\n\n' + t('Auto-merge GitHub PRs') + ' · ' + t(merge.enabled ? 'On' : 'Off'));
    if (merge.result && (merge.enabled || merge.result.state !== 'waiting'))
      text.add('\n' + t(merge.result.message));
    buttons.unshift(
      (['inherit', 'on', 'off'] as const).map((mode) => ({
        text:
          (merge.mode === mode ? '✓ ' : '') +
          t(mode === 'inherit' ? 'Session default' : mode === 'on' ? 'On' : 'Off'),
        callback_data: `dad:tm:${task.id}:${mode}${queuePage ? `:${queuePage}` : ''}`,
      })),
    );
  }
  if (task.state === 'needs_input' && task.ref.kind !== 'ticket' && task.revision)
    buttons.unshift([
      {
        text: t('Verify merge'),
        callback_data: queuePage
          ? `dad:vm:${task.id}:${task.generation.toString(36)}:${queuePage.toString(36)}`
          : `dad:merge:${task.id}:${task.generation}`,
      },
    ]);
  return { ...text, buttons };
}

export function queuedTaskCard(locale: Locale, task: Task): TelegramCard {
  return {
    ...new TelegramText()
      .add(translator(locale)('Task queued'), 'bold')
      .add('\n')
      .add(taskReference(task), 'code')
      .add('  ' + task.title),
    buttons: [[taskButton(task)], queueButtons(task.groupId!, locale)],
  };
}
