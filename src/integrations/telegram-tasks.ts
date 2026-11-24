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
  outstandingActivity,
  profileText,
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

export function parseTaskInput(args: string, engine: string) {
  if (!args) return;
  if (!args.startsWith('--')) return { requirements: args };
  const separator = /(?:^|\s)--\s+/.exec(args);
  if (!separator) return;
  const requirements = args.slice(separator.index + separator[0].length).trim();
  if (!requirements) return;
  try {
    const { values } = parseArgs({
      args: args.slice(0, separator.index).trim().split(/\s+/).filter(Boolean),
      options: {
        worker: { type: 'string' },
        engine: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
    });
    if (values.worker && !/^[1-8]$/.test(values.worker)) return;
    if (!values.model && (values.engine || values.effort)) return;
    const workerRequest: WorkerRequest = {
      slot: values.worker ? Number(values.worker) : undefined,
      profile: values.model
        ? { engine: values.engine ?? engine, model: values.model, effort: values.effort }
        : undefined,
    };
    return { requirements, workerRequest };
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

function taskButton(task: Task) {
  return { text: taskReference(task), callback_data: `dad:task:${task.id}` };
}

export function queueButtons(groupId: string, locale: Locale) {
  const t = translator(locale);
  return [
    { text: t('Task queue'), callback_data: `dad:queue:${groupId}` },
    { text: t('Workers'), callback_data: `dad:workers:${groupId}` },
  ];
}

export function queueCard(locale: Locale, groupId: string, activity: TaskActivity[]): TelegramCard {
  const t = translator(locale);
  const text = new TelegramText().add(t('Task queue'), 'bold');
  const tasks = activity.filter(outstandingActivity);
  const buttons: NonNullable<TelegramCard['buttons']> = [];
  if (!tasks.length) text.add('\n\n' + t('No unfinished tasks.'));
  for (const item of tasks) {
    const { task } = item;
    text
      .add('\n\n')
      .add(taskReference(task), 'code')
      .add('  ' + clipTitle(task.title, 90))
      .add('\n' + t(activityStatus(item)));
    if (task.workerRequest?.slot)
      text.add(' · ' + t('Worker {number}', { number: task.workerRequest.slot }));
    if (task.workerRequest?.profile) text.add(' · ' + profileText(task.workerRequest.profile));
  }
  for (let start = 0; start < Math.min(tasks.length, 9); start += 3)
    buttons.push(tasks.slice(start, start + 3).map(({ task }) => taskButton(task)));
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
): TelegramCard {
  const t = translator(locale);
  const { task } = item;
  const worker = slot?.number ?? task.workerRequest?.slot;
  const profile = slot ? task.agents?.worker : task.workerRequest?.profile;
  const text = new TelegramText()
    .add(taskReference(task), 'code')
    .add('  ' + task.title, 'bold')
    .add('\n' + t(activityStatus(item)));
  if (worker !== undefined) text.add('\n' + t('Worker {number}', { number: worker }));
  if (profile) text.add('\n' + profileText(profile));
  if (task.reason) text.add('\n\n' + clipTitle(t(redact(task.reason)), 1000));
  if (task.state === 'complete' && task.ref.kind === 'ticket' && task.summary)
    text.add('\n\n').markdown(redact(task.summary));
  const url = safeLink(task.ref.url);
  if (url && task.ref.kind !== 'ticket') text.add('\n\n').add('PR', 'text_link', { url });
  const buttons = [queueButtons(task.groupId!, locale)];
  if (merge) {
    text.add('\n\n' + t('Auto-merge GitHub PRs') + ' · ' + t(merge.enabled ? 'On' : 'Off'));
    if (merge.result && (merge.enabled || merge.result.state !== 'waiting'))
      text.add('\n' + t(merge.result.message));
    buttons.unshift(
      (['inherit', 'on', 'off'] as const).map((mode) => ({
        text:
          (merge.mode === mode ? '✓ ' : '') +
          t(mode === 'inherit' ? 'Session default' : mode === 'on' ? 'On' : 'Off'),
        callback_data: `dad:tm:${task.id}:${mode}`,
      })),
    );
  }
  if (task.state === 'needs_input' && task.ref.kind !== 'ticket' && task.revision)
    buttons.unshift([
      { text: t('Verify merge'), callback_data: `dad:merge:${task.id}:${task.generation}` },
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
