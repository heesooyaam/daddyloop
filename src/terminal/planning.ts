import type { AgentProfile, Role, TicketSource, Task } from '../core/types.js';
import type { ConsoleModel, Overlay, AgentSettings, Detail } from './model.js';
import { emptyEditor, insert } from './editor.js';
import { oneLine, markdown, type Row } from './text.js';
export const profileText = (profile?: AgentProfile) =>
  profile?.model ? `${profile.model} / ${profile.effort ?? 'default'}` : 'Codex configuration';
export function choices(model: ConsoleModel): { value: string; label: string }[] {
  const state = model.snapshot(),
    overlay = state.overlay;
  if (!overlay) return [];
  if (overlay.kind === 'notifications')
    return [
      { value: 'off', label: 'Off' },
      { value: 'attention', label: 'Only completion and situations needing my input' },
      { value: 'all', label: 'All agent replies and review milestones' },
    ];
  if (overlay.kind === 'models' && !overlay.step)
    return (['author', 'reviewer'] as Role[]).map((role) => ({
      value: role,
      label: `${role === 'reviewer' && state.detail?.group && overlay.scope === 'task' ? 'Shared reviewer' : role}: ${profileText(overlay.profiles?.[role])}`,
    }));
  const modelStep =
    overlay.kind === 'models'
      ? overlay.step === 1
      : overlay.kind === 'ticket' && [2, 4].includes(overlay.step ?? 0);
  if (modelStep) {
    const query = overlay.editor.text.toLowerCase();
    return [
      { value: '', label: 'Use Codex configuration' },
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
      { value: '', label: 'Model default' },
      ...(selected?.efforts ?? []).map((effort) => ({ value: effort, label: effort })),
    ];
  }
  return [];
}
export async function openPlanning(model: ConsoleModel, command: string, source?: string) {
  if (command === '/child' && !model.snapshot().selectedId) {
    model.patch({ error: 'Choose a parent task first.' });
    return;
  }
  const kind =
    command === '/notifications'
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
      editor: source ? insert(emptyEditor(), source) : emptyEditor(),
    },
  });
  model.patch({ busy: true });
  try {
    if (kind === 'notifications') {
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
        model.request<AgentSettings>('/agents'),
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
              notice:
                'Model catalogue unavailable. Use Codex defaults or connect the account first.',
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
        notice:
          'Ticket imported. Discuss it, then /implement starts implementation and automatic review.',
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
    if (overlay.kind === 'notifications') {
      if (!option) return;
      await model.request('/notifications', {
        enabled: option.value !== 'off',
        mode: option.value === 'all' ? 'all' : 'attention',
      });
      if (model.snapshot().overlay?.id === overlay.id) model.closeOverlay();
      model.patch({
        notice: overlay.paired
          ? 'Telegram notification preferences saved.'
          : 'Saved. Run reviewctl telegram setup to pair your private bot chat.',
      });
      return;
    }
    if (overlay.kind === 'ticket' && (overlay.step ?? 0) < 2) {
      const value = overlay.editor.text.trim();
      if (!value) {
        model.patch({ error: 'This field is required.' });
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
      model.patch({ error: 'Wait for model settings to load.' });
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
    model.patch({ notice: `${role} profile saved: ${profileText(profile)}` });
    void model.refresh();
  } catch (error) {
    model.patch({ error: oneLine((error as Error).message) });
  } finally {
    model.patch({ busy: false });
  }
}
export function planningRows(model: ConsoleModel, columns: number, height: number): Row[] {
  const state = model.snapshot(),
    overlay = state.overlay!;
  const rows: Row[] = [];
  if (overlay.kind === 'notifications')
    rows.push(
      ...markdown(
        'TELEGRAM NOTIFICATIONS\n\nChoose which updates reach your private bot chat.\n' +
          (overlay.paired
            ? 'Bot chat is paired.'
            : 'Pair the bot on the host with reviewctl telegram setup.'),
        columns,
      ),
      { text: '' },
    );
  if (overlay.kind === 'models')
    rows.push(
      ...markdown(
        `${overlay.scope === 'defaults' ? 'DEFAULTS FOR NEW TASKS' : 'MODELS FOR THIS TASK'}\nAuthor: ${profileText(overlay.profiles?.author)}\n${state.detail?.group && overlay.scope === 'task' ? 'Shared reviewer' : 'Reviewer'}: ${profileText(overlay.profiles?.reviewer)}\n\n${!overlay.step ? 'Choose the role to configure.' : overlay.step === 1 ? 'Choose a model. Type to filter.' : 'Choose reasoning effort.'}`,
        columns,
      ),
      { text: '' },
    );
  if (overlay.kind === 'ticket')
    rows.push(
      ...markdown(
        `${overlay.parentTaskId ? 'CHILD TICKET · shared reviewer' : 'NEW TICKET · new review group'}\n${overlay.source ? overlay.source.key + ': ' + overlay.source.title : 'Paste a GitHub issue URL or a Tracker ticket/key.'}\n\n${['1  Issue URL or Tracker key', '2  Repository path on the service host', '3  Choose the author model', '4  Author reasoning effort', '5  Choose the shared reviewer model', '6  Reviewer reasoning effort'][overlay.step ?? 0]}\n\nAuthor: ${profileText(overlay.profiles?.author)}\nReviewer: ${profileText(overlay.profiles?.reviewer)}\n\nDiscussion comes first. /implement starts code changes, PR creation and automatic review publication.`,
        columns,
      ),
      { text: '' },
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
