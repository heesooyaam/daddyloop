import { hostCleanupActions } from '../src/ops/host-cleanup.js';
import { cleanupReportLines } from '../src/core/cleanup-outcomes.js';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import type { SessionRuntime } from '../src/runtime/agent.js';
import { ScheduledCleanup, type CleanupAction } from '../src/ops/scheduled-cleanup.js';
import { cacheScheduleSchema, configSchema } from '../src/ops/config.js';
import { InstructionSources } from '../src/ops/instruction-sources.js';
import { approveCacheTarget, pruneCacheTarget } from '../src/ops/cache-targets.js';
import { buildApp } from '../src/server/app.js';
import { Telegram, TelegramApi } from '../src/integrations/telegram.js';
import { healthy, profiles } from './planning-fixture.js';

const completed = { status: 'completed', summary: 'Ordered operations', checkedHead: '' } as const;

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'daddyloop-scheduled-cache-')));
  const store = new Store(':memory:');
  let now = Date.now();
  let used = 80;
  const runtime = {
    runSession: vi.fn<SessionRuntime['runSession']>().mockResolvedValue(completed),
  };
  return {
    store,
    directory,
    runtime,
    options: {
      allowed: true,
      measure: () => ({ diskUsedPercent: used, diskAvailableGiB: 100 - used }),
      canPlan: () => true,
      runtime,
      profile: () => profiles.daddy,
      directory,
      actions: [] as CleanupAction[],
      clock: () => now,
    },
    setUsage(value: number) {
      used = value;
    },
    advance(minutes: number) {
      now += minutes * 60000;
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('persists the interval across restart and stops cleanup once disk usage reaches the configured threshold', async () => {
  const f = fixture();
  const primary = vi.fn(async () => f.setUsage(80)),
    secondary = vi.fn(async () => {});
  f.options.actions.push(
    { id: 'one', description: 'One', run: primary },
    { id: 'two', description: 'Two', run: secondary },
  );
  const policy = cacheScheduleSchema.parse({ enabled: true, intervalMinutes: 45 });
  const create = () => new ScheduledCleanup(f.store, policy, f.options);
  try {
    await create().tick();
    f.setUsage(85);
    f.advance(44);
    await create().tick();
    expect(primary).not.toHaveBeenCalled();
    f.advance(1);
    const restarted = create();
    await restarted.tick();
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).not.toHaveBeenCalled();
    expect(f.runtime.runSession).not.toHaveBeenCalled();
    expect(restarted.status().lastReport).toMatchObject({
      status: 'cleared',
      before: { diskUsedPercent: 85 },
      after: { diskUsedPercent: 80 },
      actions: [{ id: 'one' }],
    });
  } finally {
    f.close();
  }
});

it.each([true, false])(
  'limits the cleanup skill to a valid operation order (%s)',
  async (valid) => {
    const f = fixture();
    f.setUsage(85);
    const calls: string[] = [];
    for (const id of ['one', 'two', 'three']) {
      f.options.actions.push({
        id,
        description: id,
        run: async () => {
          calls.push(id);
        },
      });
    }
    const skill = await new InstructionSources().import({
      kind: 'text',
      name: 'Scheduled rules',
      text: 'Run two first and preserve three.',
    });
    f.runtime.runSession.mockImplementation(async (input) => {
      expect(input).toMatchObject({ execution: 'sandbox', readOnly: true });
      expect(input.instructions).toContain(skill.text);
      await input.onTool('choose_cleanup_order', { ids: valid ? ['two', 'one'] : ['unknown'] });
      return completed;
    });
    try {
      const scheduler = new ScheduledCleanup(
        f.store,
        cacheScheduleSchema.parse({ enabled: true, skill }),
        f.options,
      );
      await scheduler.tick();
      expect(calls).toEqual(valid ? ['two', 'one'] : []);
      expect(scheduler.status().lastReport?.status).toBe(valid ? 'still_high' : 'failed');
    } finally {
      f.close();
    }
  },
);

it('records an interrupted cleanup without overlapping runs or retrying it immediately on restart', async () => {
  const f = fixture();
  f.setUsage(88);
  const action = vi.fn(async (signal: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  f.options.actions.push({ id: 'slow', description: 'Slow', run: action });
  const open = () =>
    new ScheduledCleanup(f.store, cacheScheduleSchema.parse({ enabled: true }), f.options);
  try {
    const scheduler = open();
    const running = scheduler.tick();
    expect(scheduler.tick()).toBe(running);
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    await scheduler.stop();
    const restarted = open();
    await restarted.tick();
    expect(action).toHaveBeenCalledOnce();
    expect(restarted.status().lastReport?.status).toBe('interrupted');
  } finally {
    f.close();
  }
});

it('requires explicit target approval and protects workspaces, fresh files, links and directories', async () => {
  const f = fixture();
  try {
    const data = join(f.directory, 'data'),
      directory = join(f.directory, 'build-cache');
    mkdirSync(data);
    mkdirSync(directory);
    const old = join(directory, 'build-old'),
      fresh = join(directory, 'build-fresh');
    const unrelated = join(directory, 'source');
    writeFileSync(old, 'old');
    writeFileSync(fresh, 'fresh');
    writeFileSync(unrelated, 'source');
    utimesSync(old, new Date(0), new Date(0));
    symlinkSync(unrelated, join(directory, 'build-link'));
    linkSync(unrelated, join(directory, 'build-hardlink'));
    mkdirSync(join(directory, 'build-directory'));
    const target = { directory, prefix: 'build-', minAgeDays: 7 };
    const run = (protectedPaths: string[] = []) =>
      pruneCacheTarget(target, data, protectedPaths, new AbortController().signal, () => true);
    await expect(run()).rejects.toThrow();
    expect(existsSync(old)).toBe(true);
    await approveCacheTarget(target, data);
    await expect(run([join(directory, 'workspace')])).rejects.toThrow('overlaps protected');
    expect(existsSync(old)).toBe(true);
    await run();
    expect(existsSync(old)).toBe(false);
    for (const name of ['build-fresh', 'build-link', 'build-hardlink', 'build-directory', 'source'])
      expect(existsSync(join(directory, name))).toBe(true);
  } finally {
    f.close();
  }
});

it('cleans under pressure without a session and reports the measured result to Telegram', async () => {
  const f = fixture();
  const cacheDir = join(f.directory, 'cache');
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, '.daddyloop-cache'), 'daddyloop-cache-v1');
  const old = join(cacheDir, 'download-old');
  writeFileSync(old, 'temporary');
  utimesSync(old, new Date(0), new Date(0));
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const sent: string[] = [];
  let bot!: Telegram;
  const telegram = new TelegramApi(
    '123456:abcdefghijklmnopqrstuvwxyz123456',
    async (url, options) => {
      if (String(url).endsWith('/getUpdates'))
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          });
        });
      const { text } = JSON.parse(String(options?.body)) as { text: string };
      if (String(url).endsWith('/sendMessage')) sent.push(text);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  );
  const server = await buildApp({
    dataDir: f.directory,
    store: f.store,
    token: 'fixture',
    startUpdateCheck: false,
    telegramFactory: async (engine) => (bot = new Telegram(engine, telegram, 'fixture_bot')),
    config: configSchema.parse({
      telegram: { enabled: true, tokenFile: '/fixture' },
      cache: {
        auto: true,
        maxAgeDays: 7,
        keepReviewerCopies: 1,
        schedule: { enabled: true, diskPercent: 82 },
      },
    }),
    resourceCheck: () => ({
      ...healthy(),
      ...(existsSync(old)
        ? { diskUsedPercent: 85, diskAvailableGiB: 15 }
        : { diskUsedPercent: 81, diskAvailableGiB: 19 }),
    }),
  });
  try {
    const status = () =>
      server.app.inject({
        url: '/api/cache/schedule',
        headers: { authorization: 'Bearer fixture' },
      });
    await vi.waitFor(async () =>
      expect((await status()).json()).toMatchObject({
        enabled: true,
        diskPercent: 82,
        pausePercent: 90,
        lastReport: { status: 'cleared' },
      }),
    );
    expect(f.store.groups()).toHaveLength(0);
    expect(existsSync(old)).toBe(false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('Disk usage 85.0% → 81.0%. Free space gained 4.00 GiB.');
    const sendCommand = (id: number, user: number, text: string) =>
      bot.handle({
        update_id: id,
        message: { message_id: id, chat: { id: 7, type: 'private' }, from: { id: user }, text },
      });
    await sendCommand(10, 77, '/cleanup off');
    expect((await status()).json().enabled).toBe(true);
    await sendCommand(11, 7, '/cleanup off');
    expect((await status()).json().enabled).toBe(false);
    const file = join(f.directory, 'SKILL.md');
    writeFileSync(file, '---\nname: cleanup-fixture\n---\nChoose review-caches first.');
    const update = (payload: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: '/api/cache/schedule',
        headers: { authorization: 'Bearer fixture' },
        payload,
      });
    expect(
      (await update({ intervalMinutes: 45, diskPercent: 89, skillPath: file })).json(),
    ).toMatchObject({
      enabled: false,
      intervalMinutes: 45,
      diskPercent: 89,
      skill: 'cleanup-fixture',
    });
    expect((await update({ enabled: true, diskPercent: 90 })).statusCode).toBe(422);
    await bot.handle({
      update_id: 12,
      callback_query: {
        id: 'toggle',
        from: { id: 7 },
        data: 'cleanup:on',
        message: { message_id: 99, chat: { type: 'private', id: 7 } },
      },
    });
    expect((await status()).json()).toMatchObject({
      enabled: true,
      intervalMinutes: 45,
      diskPercent: 89,
      skill: 'cleanup-fixture',
    });
    await sendCommand(13, 7, '/cleanup interval 60');
    expect((await status()).json().intervalMinutes).toBe(60);
    expect(() => cacheScheduleSchema.parse({ intervalMinutes: 29 })).toThrow();
    expect(() =>
      configSchema.parse({
        cache: {
          auto: true,
          maxAgeDays: 7,
          keepReviewerCopies: 1,
          schedule: { enabled: true, diskPercent: 90 },
        },
      }),
    ).toThrow('cleanup threshold must be lower');
  } finally {
    await server.app.close();
    f.close();
  }
});

it('reports decreasing host space and a failed operation for pre-upgrade reports', () => {
  const lines = cleanupReportLines('ru', {
    id: '1',
    startedAt: 0,
    finishedAt: 1,
    status: 'failed',
    before: { diskAvailableGiB: 241.18, diskUsedPercent: 84 },
    after: { diskAvailableGiB: 235.26, diskUsedPercent: 84.4 },
    actions: [{ id: 'review-caches', error: 'Error: Cache maintenance is already running' }],
  });
  expect(lines.join(' ')).toContain('меньше на 5.92 ГиБ');
  expect(lines.join(' ')).toContain('Другая уборка уже выполнялась');
});
const unloaded = {
  LoadState: 'loaded',
  RemainAfterExit: 'no',
  Type: 'oneshot',
  ActiveState: 'inactive',
  InvocationID: '',
  Result: 'success',
  ConditionResult: 'no',
  ConditionTimestampMonotonic: '0',
  ExecMainCode: '0',
  ExecMainStatus: '0',
  ExecMainStartTimestampMonotonic: '0',
  ExecMainExitTimestampMonotonic: '0',
};
const completedUnit = {
  ...unloaded,
  InvocationID: 'a'.repeat(32),
  ConditionResult: 'yes',
  ConditionTimestampMonotonic: '11',
  ExecMainStartTimestampMonotonic: '12',
  ExecMainExitTimestampMonotonic: '13',
  ExecMainCode: '1',
};
function unitRun(before: typeof unloaded, after: typeof unloaded) {
  const show = (state: typeof unloaded) =>
    Object.entries(state)
      .map(([k, v]) => k + '=' + v)
      .join('\n');
  return vi
    .fn(async (_exe: string, args: string[]): Promise<string> =>
      args[0] === 'show' ? show(before) : '',
    )
    .mockResolvedValueOnce(show(before))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(show(after));
}
it('only starts an allowed oneshot and rechecks the threshold after inspection', async () => {
  const unit = 'daddyloop-cleanup-example.service',
    signal = new AbortController().signal;
  const run = unitRun(unloaded, completedUnit);
  expect(hostCleanupActions(undefined, run)).toEqual([]);
  expect(() => hostCleanupActions('ssh.service', run)).toThrow();
  expect(await hostCleanupActions(unit, run)[0].run(signal, () => false)).toMatchObject({
    skipped: true,
    unitResult: 'threshold',
  });
  expect(run).toHaveBeenCalledTimes(1);
  const wrong = unitRun({ ...unloaded, Type: 'simple' }, unloaded);
  await expect(hostCleanupActions(unit, wrong)[0].run(signal, () => true)).rejects.toThrow(
    /oneshot/,
  );
  expect(wrong).toHaveBeenCalledTimes(1);
});
it.each([
  ['success', unloaded, completedUnit, 'completed'],
  ['busy', unloaded, { ...completedUnit, ExecMainStatus: '75' }, 'busy'],
  [
    'joined',
    { ...completedUnit, ActiveState: 'activating', ExecMainExitTimestampMonotonic: '0' },
    completedUnit,
    'completed',
  ],
  [
    'unmet condition after a prior success',
    completedUnit,
    { ...completedUnit, ConditionResult: 'no', ConditionTimestampMonotonic: '31' },
    'condition',
  ],
  [
    'ExecCondition skipped',
    unloaded,
    { ...unloaded, InvocationID: 'c'.repeat(32), Result: 'exec-condition' },
    'condition',
  ],
  ['no execution metadata', unloaded, unloaded, 'unconfirmed'],
  ['stale success', completedUnit, completedUnit, 'unconfirmed'],
  [
    'incomplete execution',
    unloaded,
    { ...completedUnit, ExecMainExitTimestampMonotonic: '0' },
    'unconfirmed',
  ],
] as const)('verifies the systemd receipt for %s', async (_, before, after, outcome) => {
  const unit = 'daddyloop-cleanup-example.service',
    signal = new AbortController().signal,
    run = unitRun(before, after);
  const result = hostCleanupActions(unit, run)[0].run(signal, () => true);
  if (outcome === 'unconfirmed') await expect(result).rejects.toThrow(/confirmed execution/);
  else await expect(result).resolves.toMatchObject({ unitResult: outcome });
  expect(run).toHaveBeenCalledWith(
    '/usr/bin/sudo',
    ['-n', '/usr/bin/systemctl', 'start', unit],
    signal,
  );
});
it('shows a verified per-service space change and does not mark legacy starts as completed', async () => {
  const f = fixture();
  try {
    f.options.actions.push({
      id: 'daddyloop-cleanup-one',
      description: 'Test',
      async run() {
        f.setUsage(82);
        return { unitResult: 'completed' };
      },
    });
    f.setUsage(92);
    const scheduler = new ScheduledCleanup(
      f.store,
      cacheScheduleSchema.parse({ enabled: true, diskPercent: 83 }),
      f.options,
    );
    await scheduler.tick();
    const r = scheduler.status().lastReport!;
    expect(r.actions).toEqual([
      { id: 'daddyloop-cleanup-one', unitResult: 'completed', freeSpaceChangeGiB: 10 },
    ]);
    expect(cleanupReportLines('ru', r).join(' ')).toContain('+10.00 ГиБ');
    expect(
      cleanupReportLines('ru', { ...r, actions: [{ id: 'daddyloop-cleanup-one' }] }).join(' '),
    ).toContain('нет подтверждения');
  } finally {
    f.close();
  }
});
