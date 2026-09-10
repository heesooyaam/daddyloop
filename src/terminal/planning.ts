import { localeNames, translator, type Locale } from '../i18n/index.js';
import type { UpdateStatus } from '../core/updates.js';
import type { AgentProfile, Role, TicketSource, Task } from '../core/types.js';
import type { ConsoleModel, Overlay, AgentSettings, Detail } from './model.js';
import { emptyEditor, insert } from './editor.js';
import { oneLine, markdown, type Row } from './text.js';
export const profileText = (profile?: AgentProfile, locale: Locale = 'en') =>
  profile?.model
    ? `${profile.model} / ${profile.effort ?? translator(locale)('default')}`
    : translator(locale)('Codex configuration');
export function choices(model: ConsoleModel): { value: string; label: string }[] {
  const tr = model.t;

  const state = model.snapshot(),
    overlay = state.overlay;
  if (!overlay) return [];
  if (overlay.kind === 'language')
    return Object.entries(localeNames).map(([value, label]) => ({ value, label }));
  if (overlay.kind === 'updates')
    return [
      { value: 'check', label: tr('Check now') },
      {
        value: 'notifications',
        label:
          tr('CLI update notifications') +
          ': ' +
          model.t(state.updates?.notifications === false ? 'Off' : 'On'),
      },
    ];
  if (overlay.kind === 'notifications')
    return [
      { value: 'off', label: 'Off' },
      { value: 'attention', label: tr('Only completion and situations needing my input') },
      { value: 'all', label: tr('All agent replies and review milestones') },
    ];
  if (overlay.kind === 'models' && !overlay.step)
    return (['author', 'reviewer'] as Role[]).map((role) => ({
      value: role,
      label: `${role === 'reviewer' && state.detail?.group && overlay.scope === 'task' ? tr('Shared reviewer') : tr(role)}: ${profileText(overlay.profiles?.[role], state.locale)}`,
    }));
  const modelStep =
    overlay.kind === 'models'
      ? overlay.step === 1
      : overlay.kind === 'ticket' && [2, 4].includes(overlay.step ?? 0);
  if (modelStep) {
    const query = overlay.editor.text.toLowerCase();
    return [
      { value: '', label: tr('Use Codex configuration') },
      ...(state.agentSettings?.models ?? []).map((model) => ({
        value: model.id,
        label: model.name + ' · ' + model.id,
      })),
    ].filter((option) => option.label.toLowerCase().includes(query));
  }
  const effortStep =
    overlay.kind === 'models'
      ? overlay.step === 2
      : overlay.kind === 'ticket' && [3, 5].includes(overlay.step ?? 0);
  if (effortStep) {
    const role = overlay.profileRole ?? ((overlay.step ?? 0) < 4 ? 'author' : 'reviewer');
    const selected = state.agentSettings?.models.find(
      (model) => model.id === overlay.profiles?.[role].model,
    );
    return [
      { value: '', label: tr('Model default') },
      ...(selected?.efforts ?? []).map((effort) => ({ value: effort, label: effort })),
    ];
  }
  return [];
}
export async function openPlanning(model: ConsoleModel, command: string, source?: string) {
  const tr = model.t;

  if (command === '/child' && !model.snapshot().selectedId) {
    model.patch({ error: tr('Choose a parent task first.') });
    return;
  }
  const kind =
    command === '/language'
      ? 'language'
      : command === '/updates'
        ? 'updates'
        : command === '/notifications'
          ? 'notifications'
          : ['/models', '/defaults'].includes(command)
            ? 'models'
            : 'ticket';
  model.open(kind);
  const current = model.snapshot(),
    id = current.overlay!.id;
  model.patch({
    overlay: {
      ...current.overlay!,
      step: 0,
      fields: [],
      parentTaskId: command === '/child' ? current.selectedId : undefined,
      targetTaskId: current.selectedId || undefined,
      scope: command === '/defaults' || !current.selectedId ? 'defaults' : 'task',
      editor: kind === 'ticket' && source ? insert(emptyEditor(), source) : emptyEditor(),
    },
  });
  model.patch({ busy: true });
  try {
    if (kind === 'language') {
      model.patch({
        overlay: { ...model.snapshot().overlay!, index: current.locale === 'en' ? 0 : 1 },
      });
    } else if (kind === 'updates') {
      const updates = await model.request<UpdateStatus>(
        source === 'check' ? '/updates/check' : '/updates',
        source === 'check' ? {} : undefined,
      );
      if (model.snapshot().overlay?.id === id) model.patch({ updates });
    } else if (kind === 'notifications') {
      const result = await model.request<{
        telegram: { enabled: boolean; mode: string };
        paired: boolean;
      }>('/notifications');
      if (model.snapshot().overlay?.id === id)
        model.patch({
          overlay: {
            ...model.snapshot().overlay!,
            paired: result.paired,
            index: !result.telegram.enabled ? 0 : result.telegram.mode === 'all' ? 2 : 1,
          },
        });
    } else {
      const [settings, detail] = await Promise.all([
        model.request<AgentSettings>(source === 'refresh' ? '/agents?refresh=1' : '/agents'),
        current.selectedId &&
        ((kind === 'models' && command !== '/defaults') || command === '/child')
          ? model.request<Detail>(`/tasks/${current.selectedId}`)
          : Promise.resolve(undefined),
      ]);
      if (model.snapshot().overlay?.id !== id) return;
      const overlay = model.snapshot().overlay!;
      model.patch({
        agentSettings: settings,
        overlay: {
          ...overlay,
          profiles:
            kind === 'models' && overlay.scope === 'task'
              ? (detail?.agents ?? settings.defaults)
              : {
                  author: settings.defaults.author,
                  reviewer: overlay.parentTaskId
                    ? (detail?.agents?.reviewer ?? settings.defaults.reviewer)
                    : settings.defaults.reviewer,
                },
        },
        ...(settings.error
          ? {
              notice: tr(
                'Model catalogue unavailable. Use Codex defaults or connect the account first.',
              ),
            }
          : {}),
      });
    }
  } catch (error) {
    if (model.snapshot().overlay?.id === id)
      model.patch({ error: oneLine((error as Error).message) });
  } finally {
    model.patch({ busy: false });
  }
}
async function finishTicket(model: ConsoleModel, overlay: Overlay) {
  const tr = model.t;

  model.patch({ busy: true, error: undefined });
  try {
    const task = await model.request<Task>('/tickets', {
      source: overlay.fields![0],
      repoPath: overlay.fields![1],
      ...(overlay.parentTaskId ? { parentTaskId: overlay.parentTaskId } : {}),
      agents: overlay.profiles,
      publication: 'auto',
      autoPush: true,
    });
    const state = model.snapshot();
    model.patch({ tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)] });
    if (state.overlay?.id === overlay.id) {
      model.select(task.id);
      model.setRole('author');
      model.patch({
        notice: tr(
          'Ticket imported. Discuss it, then /implement starts implementation and automatic review.',
        ),
      });
    }
    void model.refresh();
  } catch (error) {
    model.patch({ error: oneLine((error as Error).message) });
  } finally {
    model.patch({ busy: false });
  }
}
export async function submitPlanning(model: ConsoleModel) {
  const tr = model.t;

  const state = model.snapshot(),
    overlay = state.overlay;
  if (!overlay || state.busy) return;
  const option = choices(model)[overlay.index];
  const advance = (patch: Partial<Overlay>) =>
    model.patch({
      overlay: { ...overlay, editor: emptyEditor(), index: 0, ...patch },
      error: undefined,
    });
  const modelIndex = (role: Role) =>
    Math.max(
      0,
      (state.agentSettings?.models.findIndex(
        (item) => item.id === overlay.profiles?.[role].model,
      ) ?? -1) + 1,
    );
  model.patch({ busy: true });
  try {
    if (overlay.kind === 'language') {
      if (option) await model.changeLanguage(option.value as Locale);
      if (model.snapshot().overlay?.id === overlay.id) model.closeOverlay();
      return;
    }
    if (overlay.kind === 'updates') {
      if (!option) return;
      const updates = await model.request<UpdateStatus>(
        option.value === 'check' ? '/updates/check' : '/updates/notifications',
        option.value === 'check' ? {} : { enabled: state.updates?.notifications === false },
      );
      model.patch({ updates });
      return;
    }
    if (overlay.kind === 'notifications') {
      if (!option) return;
      await model.request('/notifications', {
        enabled: option.value !== 'off',
        mode: option.value === 'all' ? 'all' : 'attention',
      });
      if (model.snapshot().overlay?.id === overlay.id) model.closeOverlay();
      model.patch({
        notice: overlay.paired
          ? tr('Telegram notification preferences saved.')
          : tr('Saved. Run reviewctl telegram setup to pair your private bot chat.'),
      });
      return;
    }
    if (overlay.kind === 'ticket' && (overlay.step ?? 0) < 2) {
      const value = overlay.editor.text.trim();
      if (!value) {
        model.patch({ error: tr('This field is required.') });
        return;
      }
      if (!overlay.step) {
        const result = await model.request<{ source: TicketSource }>('/tickets/preview', {
          source: value,
        });
        if (
          model.snapshot().overlay?.id !== overlay.id ||
          model.editor().text !== overlay.editor.text
        )
          return;
        const path = overlay.parentTaskId ? (state.detail?.task.repoPath ?? '') : '';
        advance({
          step: 1,
          fields: [value],
          source: result.source,
          editor: insert(emptyEditor(), path),
        });
      } else {
        advance({
          step: 2,
          fields: [...(overlay.fields ?? []), value],
          profileRole: 'author',
          index: modelIndex('author'),
        });
      }
      return;
    }
    if (!overlay.profiles) {
      model.patch({ error: tr('Wait for model settings to load.') });
      return;
    }
    if (overlay.kind === 'models' && !overlay.step) {
      if (option)
        advance({
          step: 1,
          profileRole: option.value as Role,
          index: modelIndex(option.value as Role),
        });
      return;
    }
    if (!option) return;
    const role = overlay.profileRole ?? 'author';
    const modelStep =
      overlay.kind === 'models' ? overlay.step === 1 : overlay.step === 2 || overlay.step === 4;
    let profile: AgentProfile;
    if (modelStep) {
      const selected = state.agentSettings?.models.find((model) => model.id === option.value);
      const old = overlay.profiles[role];
      profile = selected
        ? {
            engine: 'codex',
            model: selected.id,
            effort: (old.effort && selected.efforts.includes(old.effort)
              ? old.effort
              : selected.defaultEffort) as AgentProfile['effort'],
          }
        : { engine: 'codex' };
      if (selected) {
        const efforts = ['', ...selected.efforts];
        advance({
          profiles: { ...overlay.profiles, [role]: profile },
          step: (overlay.step ?? 0) + 1,
          index: Math.max(0, efforts.indexOf(profile.effort ?? '')),
        });
        return;
      }
    } else
      profile = {
        ...overlay.profiles[role],
        effort: option.value ? (option.value as AgentProfile['effort']) : undefined,
      };
    const updated = { ...overlay, profiles: { ...overlay.profiles, [role]: profile } };
    if (overlay.kind === 'ticket') {
      if (role === 'author' && !overlay.parentTaskId) {
        advance({
          profiles: updated.profiles,
          step: 4,
          profileRole: 'reviewer',
          index: modelIndex('reviewer'),
        });
        return;
      }
      await finishTicket(model, updated);
      return;
    }
    model.patch({ busy: true });
    if (overlay.scope === 'defaults') {
      const saved = await model.request<{ defaults: AgentSettings['defaults'] }>(
        `/agents/defaults/${role}`,
        profile,
      );
      if (state.agentSettings)
        model.patch({ agentSettings: { ...state.agentSettings, defaults: saved.defaults } });
    } else await model.request(`/tasks/${overlay.targetTaskId}/agents`, { role, profile });
    if (model.snapshot().overlay?.id === overlay.id) model.closeOverlay();
    model.patch({
      notice: tr('{v0} profile saved: {v1}', { v0: role, v1: profileText(profile, state.locale) }),
    });
    void model.refresh();
  } catch (error) {
    model.patch({ error: oneLine((error as Error).message) });
  } finally {
    model.patch({ busy: false });
  }
}
export function planningRows(model: ConsoleModel, columns: number, height: number): Row[] {
  const tr = model.t;

  const state = model.snapshot(),
    overlay = state.overlay!;
  const rows: Row[] = [];
  if (overlay.kind === 'language')
    rows.push(
      { text: tr('Interface language'), kind: 'heading' },
      { text: '' },
      ...markdown(
        tr(
          'This is the interface language. Task and conversation content is kept in its original language.',
        ),
        columns,
      ),
    );
  if (overlay.kind === 'updates') {
    rows.push({ text: model.t('Updates'), kind: 'heading' }, { text: '' });
    if (!state.updates?.checkedAt) rows.push({ text: tr('Not checked yet') });
    for (const tool of state.updates?.tools ?? [])
      rows.push(
        { text: `${tool.name}: ${tool.installed ?? '—'} → ${tool.latest ?? '—'}`, kind: 'accent' },
        {
          text: model.t(
            tool.source === 'bundled'
              ? tr('Bundled with Reviewloop')
              : tool.source === 'missing'
                ? tr('Not installed')
                : tool.source === 'managed'
                  ? tr('Managed by Reviewloop')
                  : tr('External CLI'),
          ),
        },
        {
          text: model.t(
            tool.error
              ? tr('Check failed')
              : !tool.latest
                ? tr('Not checked yet')
                : tool.updateAvailable
                  ? tr('Update available')
                  : tr('Up to date'),
          ),
        },
        ...(tool.supported ? [] : [{ text: tr('Integration not available') }]),
        { text: '' },
      );
  }

  if (overlay.kind === 'notifications')
    rows.push(
      ...markdown(
        tr('TELEGRAM NOTIFICATIONS\n\nChoose which updates reach your private bot chat.\n') +
          (overlay.paired
            ? tr('Bot chat is paired.')
            : tr('Pair the bot on the host with reviewctl telegram setup.')),
        columns,
      ),
      { text: '' },
    );
  if (overlay.kind === 'models')
    rows.push(
      ...markdown(
        tr('{v0}\nAuthor: {v1}\n{v2}: {v3}\n\n{v4}', {
          v0:
            overlay.scope === 'defaults'
              ? tr('DEFAULTS FOR NEW TASKS')
              : tr('MODELS FOR THIS TASK'),
          v1: profileText(overlay.profiles?.author, state.locale),
          v2:
            state.detail?.group && overlay.scope === 'task'
              ? tr('Shared reviewer')
              : tr('Reviewer'),
          v3: profileText(overlay.profiles?.reviewer, state.locale),
          v4: !overlay.step
            ? tr('Choose the role to configure.')
            : overlay.step === 1
              ? tr('Choose a model. Type to filter.')
              : tr('Choose reasoning effort.'),
        }),
        columns,
      ),
      { text: '' },
    );
  if (overlay.kind === 'ticket')
    rows.push(
      ...markdown(
        tr(
          '{v0}\n{v1}\n\n{v2}\n\nAuthor: {v3}\nReviewer: {v4}\n\nDiscussion comes first. /implement starts code changes, PR creation and automatic review publication.',
          {
            v0: overlay.parentTaskId
              ? tr('CHILD TICKET · shared reviewer')
              : tr('NEW TICKET · new review group'),
            v1: overlay.source
              ? overlay.source.key + ': ' + overlay.source.title
              : tr('Paste a GitHub issue URL or a Tracker ticket/key.'),
            v2: [
              tr('1  Issue URL or Tracker key'),
              tr('2  Repository path on the service host'),
              tr('3  Choose the author model'),
              tr('4  Author reasoning effort'),
              tr('5  Choose the shared reviewer model'),
              tr('6  Reviewer reasoning effort'),
            ][overlay.step ?? 0],
            v3: profileText(overlay.profiles?.author, state.locale),
            v4: profileText(overlay.profiles?.reviewer, state.locale),
          },
        ),
        columns,
      ),
      { text: '' },
    );
  if (overlay.kind === 'models' && state.agentSettings?.catalogue)
    rows.push(
      {
        text: tr('Codex CLI {v0} · model/list', {
          v0: state.agentSettings.catalogue.cliVersion ?? '—',
        }),
        kind: 'muted',
      },
      { text: tr('Refresh: /models refresh'), kind: 'muted' },
    );
  const list = choices(model);
  if (list.length && rows.length > height - Math.min(3, list.length)) {
    const compact = rows.filter((row) => row.text.trim());
    rows.splice(
      0,
      rows.length,
      ...compact.slice(0, Math.max(0, height - Math.min(3, list.length))),
    );
  }
  const room = Math.max(1, height - rows.length - 1),
    start = Math.max(0, Math.min(overlay.index - Math.floor(room / 2), list.length - room));
  for (let i = start; i < Math.min(list.length, start + room); i++)
    rows.push({
      text: `${i === overlay.index ? '›' : ' '} ${list[i].label}`,
      kind: i === overlay.index ? 'accent' : undefined,
    });
  return rows.slice(0, height);
}
