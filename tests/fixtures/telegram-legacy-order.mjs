// Offline reproduction: node --import tsx tests/fixtures/telegram-legacy-order.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const release = '4a9d338a1d6f9a533e54063cdd10e5c195374f21';
const root = new URL('../../', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' });
const suffix = '?telegram-released=';
const replayRevision = process.env.DADDYLOOP_LEGACY_REPLAY_HEAD;
const revisions = [release, ...(replayRevision ? [replayRevision] : [])];
const sources = new Map(
  revisions.map((revision) => [
    revision,
    new Set(git('ls-tree', '-r', '--name-only', revision, 'src').trim().split('\n')),
  ]),
);
const pinned = (path, revision = release) => new URL(path, root).href + suffix + revision;
const hook = registerHooks({
  resolve(specifier, context, next) {
    const revision = context.parentURL?.split(suffix)[1];
    if (revision && specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL);
      const path = url.href.slice(root.href.length);
      const source = [path, path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx')].find(
        (candidate) => sources.get(revision)?.has(candidate),
      );
      if (source) return { url: pinned(source, revision), shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const [filename, revision] = url.split(suffix);
    if (!sources.has(revision)) return next(url, context);
    const path = filename.slice(root.href.length);
    const source = git('show', revision + ':' + path);
    return {
      format: 'module',
      shortCircuit: true,
      source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
    };
  },
});
const { Store } = await import(pinned('src/core/store.ts'));
const { Telegram, TelegramApi } = await import(pinned('src/integrations/telegram.ts'));
const { Engine } = await import(pinned('src/core/engine.ts'));
const { InstructionPresets } = await import(pinned('src/core/instruction-presets.ts'));
const { setLocale } = await import(pinned('src/core/preferences.ts'));
const { Daddy } = await import(pinned('src/core/daddy.ts'));
const group = '1b951e45-19d6-4890-93f7-7e5d90962624';
const secondGroup = 'a6c192a2-19d6-4890-93f7-7e5d90962624';
const taskId = '9f8677ba-776e-4a81-ba88-364099269ea4';
const sessionActions = {
  pool: ['/pool 2', 'daddy.settings'],
  'pool button': ['dad:pool:' + group + ':2', 'daddy.settings'],
  pause: ['/pause', 'daddy.paused'],
  'pause button': ['dad:pause:' + group, 'daddy.paused'],
  resume: ['/resume', 'daddy.resumed'],
  'resume button': ['dad:resume:' + group, 'daddy.resumed'],
  instructions: ['/instructions worker Recovered instructions', 'daddy.settings'],
  preset: ['/preset Legacy preset', 'daddy.settings'],
  'session merge': ['dad:sm:' + group + ':on', 'daddy.settings'],
  'task merge': ['dad:tm:' + taskId + ':on', 'automerge.setting'],
};
const views = {
  pool: ['/pool', (daddy) => daddy.settings(group, { workerLimit: 2 })],
  instructions: [
    '/instructions',
    (daddy) =>
      daddy.settings(group, {
        instructions: { daddy: {}, worker: { prompt: 'Recovered instructions' } },
      }),
  ],
  'session merge': ['dad:settings:' + group, (daddy) => daddy.settings(group, { autoMerge: true })],
  'task merge': ['dad:task:' + taskId, (daddy) => daddy.taskAutoMerge(group, taskId, 'on')],
  pause: [
    'dad:open:' + group,
    async (daddy) => {
      await daddy.resume(group);
      await daddy.pause(group);
    },
  ],
  resume: [
    'dad:open:' + group,
    async (daddy) => {
      await daddy.pause(group);
      await daddy.resume(group);
    },
  ],
  language: ['language:show', (_daddy, store) => setLocale(store, 'ru')],
};
const at = 1_750_000_000_000;
const NativeDate = Date;
let clock = at;

function snapshot(path) {
  // Open a fresh connection after the released writer has closed its WAL.
  const old = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = old
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        old
          .prepare('SELECT rowid AS slot,* FROM "' + name + '" ORDER BY rowid')
          .all()
          .map((row) => {
            if (name !== 'settings' || !row.key.startsWith('telegram.delivery:')) return row;
            const delivery = JSON.parse(row.value);
            // This is all the normalization: the release generates a random
            // record ID and, for a keyless menu, a random hashed storage key.
            delivery.id = '<random delivery UUID>';
            if (!delivery.options.key) row.key = 'telegram.delivery:<random menu hash>';
            return { ...row, value: delivery };
          }),
      ]),
    );
  } finally {
    old.close();
  }
}

async function run(path, menuFirst, gap = 0, scenario = 'status', options = {}) {
  const {
    privateChat = false,
    extraSession = false,
    browse,
    web = false,
    anchored = false,
    attempted = false,
    languageAlreadySelected = false,
    recordedState = false,
    oldCard = false,
    extraConfirmation = false,
    competitor,
    finish,
    nextTurn,
    promote,
    extraMenu = false,
    menuBetweenTurns = false,
    poolSize = 2,
    crossCommand,
    delayedConfirmation = false,
    splitRoute = false,
  } = options;
  const mixedSettings = scenario === 'mixed settings';
  const kind = mixedSettings
    ? 'instructions'
    : scenario.replace(/^(?:two|mixed) (rename|worker)$/, '$1');
  clock = at;
  const store = new Store(path);
  const sent = [];
  try {
    const topic = { chatId: -10042, threadId: 17, ownerId: 7, groupId: group, title: 'Session' };
    store.saveGroup({ id: group, title: topic.title, orchestrated: true });
    store.setSetting('telegram.pairing', { chatId: 7, userId: 7, ownerLabel: 'Owner' });
    if (!privateChat)
      store.setSetting('telegram.group', { chatId: topic.chatId, ownerId: topic.ownerId });
    if (privateChat) store.setSetting('telegram.currentDaddy', group);
    if (extraSession)
      store.saveGroup({
        id: secondGroup,
        title: 'Idle',
        orchestrated: true,
      });
    store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    store.db
      .prepare('INSERT INTO telegram_topics VALUES(?,?,?)')
      .run('7:-10042:' + group, group, JSON.stringify(topic));
    if (competitor)
      store.db
        .prepare('INSERT INTO telegram_topics VALUES(?,?,?)')
        .run(
          '7:-10042:' + secondGroup,
          secondGroup,
          JSON.stringify({ ...topic, threadId: 18, groupId: secondGroup }),
        );
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, init) => {
      const method = new URL(url).pathname.split('/').at(-1);
      const body = JSON.parse(init.body);
      if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
      assert.ok(['sendMessage', 'editMessageText'].includes(method));
      sent.push({ chat: body.chat_id, text: body.text });
      const limited =
        body.text === 'Other chat triggers 429' ||
        (attempted && sent.length === 2) ||
        (scenario === 'third' && body.text.endsWith('Reply C')) ||
        (scenario.endsWith('delayed') && sent.length === 1);
      if (limited)
        return Response.json({
          ok: false,
          error_code: 429,
          description: 'Flood wait',
          parameters: { retry_after: 10 },
        });
      return Response.json({ ok: true, result: { message_id: 101 } });
    });
    const bot = new Telegram({ store }, api, 'offline_fixture');
    // The task path writes through the released Engine without starting workers
    // or asking a repository provider to describe a working copy.
    const needsEngine =
      !!crossCommand || ['task', 'worker'].includes(kind) || kind in sessionActions;
    const engine = needsEngine
      ? new Engine(store, () => {
          throw new Error('Offline fixture');
        })
      : { store };
    if (needsEngine)
      store.saveGroup({
        ...store.getGroup(group),
        generation: 1,
        daddyState: (browse ? browse === 'pause' : kind.startsWith('resume')) ? 'paused' : 'active',
        workspace: { name: 'Fixture', provider: 'github' },
        workerLimit: 1,
        daddy: engine.defaultAgents().daddy,
        ...(browse === 'pool' && { requestedWorkerLimit: 2 }),
      });
    const createTask = (_groupId, input) =>
      engine.createTicket({
        id: taskId,
        groupId: group,
        groupGeneration: 1,
        createdByAction: input.requestId,
        repoPath: directory,
        repository: { baseHead: 'a'.repeat(40) },
        startImplementation: true,
        ref: {
          kind: 'ticket',
          provider: 'github',
          host: 'github.com',
          repo: 'fixture/offline',
          number: 0,
        },
        source: {
          kind: 'local',
          title: input.requirements,
          body: input.requirements,
          url: 'https://github.com/fixture/offline',
        },
      });
    const daddy = Object.assign(Object.create(Daddy.prototype), {
      engine,
      group: (id = group) => store.getGroup(id),
      createTask,
      catalogue: { validate: async () => {} },
      running: new Map(),
      maintenance: new Map(),
      ...(!needsEngine && { board: (id = group) => ({ group: store.getGroup(id) }) }),
    });
    if (kind === 'preset')
      new InstructionPresets(store).save({
        name: 'Legacy preset',
        instructions: { daddy: {}, worker: { prompt: 'Recovered preset' } },
      });
    if (kind === 'task merge')
      createTask(group, { requestId: 'fixture-task', requirements: 'Task to merge' });
    if (browse === 'instructions') {
      store.saveGroup({
        ...store.getGroup(group),
        instructions: { daddy: {}, worker: { prompt: 'Recovered instructions' } },
      });
    }
    if (browse === 'session merge') store.setSetting('autoMerge.session:' + group, true);
    if (browse === 'task merge') store.setSetting('autoMerge.mode:' + taskId, 'on');
    if (browse === 'language' || languageAlreadySelected)
      store.setSetting('preferences', { locale: 'ru', version: 0 });
    if (competitor && needsEngine)
      store.saveGroup({ ...store.getGroup(group), id: secondGroup, title: 'Idle' });
    if (recordedState) {
      clock -= 1;
      if (kind === 'pool') await daddy.settings(group, { workerLimit: 1 });
      if (kind === 'session merge') await daddy.settings(group, { autoMerge: false });
      if (kind === 'task merge') daddy.taskAutoMerge(group, taskId, 'off');
      if (kind === 'language') setLocale(store, 'en');
      clock += 1;
    }
    if (splitRoute || scenario.startsWith('mixed '))
      store.setSetting('telegram.currentDaddy', group);
    bot.configure({ daddy });
    const notify = async (event) => {
      bot.workspace.onEvent(event);
      await bot.workspace.pending;
    };
    const reply = async (id, text, phase, runId = 'turn') => {
      store.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(
        id,
        group,
        JSON.stringify({
          id,
          taskId: group,
          text,
          phase,
          sender: 'agent',
          runId,
          at: new Date().toISOString(),
        }),
      );
      await notify(store.event(group, 'daddy.message', { messageId: id }, runId));
    };
    let nextUpdate = 17;
    const menu = async (privateChat = false, action = kind, thread = topic.threadId) => {
      const chat = privateChat
        ? { id: 7, type: 'private' }
        : { id: topic.chatId, type: 'supergroup' };
      const from = { id: 7, first_name: 'Owner' };
      const update_id = nextUpdate++;
      const message = {
        message_id: update_id - 2,
        chat,
        message_thread_id: privateChat ? undefined : thread,
      };
      const commands = {
        rename: '/rename Recovered title',
        worker: '/worker 1 example max',
        task: '/task Legacy task',
        'text language': '/language ru',
        pool: '/pool ' + poolSize,
      };
      const command =
        action === 'browse'
          ? views[browse ?? kind][0]
          : (commands[action] ?? sessionActions[action]?.[0] ?? '/status');
      const data =
        action === kind && (scenario === 'language' || scenario === 'two languages')
          ? 'language:ru'
          : !command.startsWith('/')
            ? command
            : undefined;
      await bot.handle(
        data
          ? {
              update_id,
              callback_query: { id: 'button-' + update_id, data, from, message },
            }
          : { update_id, message: { ...message, from, text: command } },
      );
      // Same persisted cursor write as the released getUpdates loop.
      store.transaction(() => {
        store.setSetting('telegram.offset', nextUpdate);
        store.setSetting('telegram.offsetAt', Date.now());
      });
    };
    await reply('A', 'Reply A', 'progress');
    clock += 1;
    if (scenario === 'third') {
      await reply('B', 'Reply B', 'progress');
      await reply('C', 'Reply C', 'final');
      await menu();
      assert.equal(sent.length, 3);
    } else if (scenario.startsWith('duplicate')) {
      if (scenario.endsWith('acknowledged'))
        await api.send(7, 'Other chat triggers 429', undefined, { key: 'flood' });
      await reply('B', 'Reply A', 'progress');
      if (!scenario.includes('tail')) await reply('C', 'Reply C', 'final');
      assert.equal(sent.length, scenario.endsWith('acknowledged') ? 2 : 1);
    } else {
      if (!attempted) await api.send(7, 'Other chat triggers 429', undefined, { key: 'flood' });
      const mixedRoutes = scenario.startsWith('mixed ') && !mixedSettings;
      const twoCards = mixedRoutes || mixedSettings || scenario.startsWith('two ');
      if (nextTurn) {
        if (nextTurn !== 'last') await reply('C', 'Reply C', 'progress', 'next');
        if (menuBetweenTurns) await menu(privateChat);
        await reply('B', 'Reply B', promote ? 'progress' : 'final');
        if (promote) {
          assert.equal(store.finishDaddyReply(group, 'Reply B', 'turn').id, 'B');
          await notify(store.events(group).at(-1));
        }
        clock += gap;
        if (nextTurn === 'last') await reply('C', 'Reply C', 'progress', 'next');
        if (nextTurn === 'overlap') await reply('D', 'Reply D', 'final', 'next');
        if (extraMenu && !menuBetweenTurns) await menu(privateChat);
      } else if (crossCommand) {
        const web = async () => {
          if (kind === 'rename') daddy.rename(group, 'Recovered title');
          if (kind === 'worker')
            await daddy.configureWorker(group, 1, {
              engine: 'codex',
              model: 'example',
              effort: 'max',
            });
          if (kind === 'preset') await daddy.settings(group, {});
          if (kind === 'text language') setLocale(store, 'ru');
          if (kind === 'pool') await daddy.settings(group, { workerLimit: 2 });
        };
        if (delayedConfirmation) {
          // Advance the clock after the handler writes its event, at Bot API enqueue.
          const send = api.send.bind(api);
          api.send = (...args) => {
            api.send = send;
            clock++;
            return send(...args);
          };
          await menu(privateChat);
          await menu(privateChat || splitRoute, crossCommand);
          await reply('B', 'Reply B', 'final');
          await web();
        } else {
          await web();
          await menu(privateChat || splitRoute, crossCommand);
          await reply('B', 'Reply B', 'final');
          await menu(privateChat);
        }
      } else if (finish) {
        const runId = finish === 'next run' ? 'next' : 'turn';
        await reply('B', 'Reply B', 'progress', runId);
        clock++;
        await menu(privateChat);
        clock++;
        const result = store.finishDaddyReply(
          group,
          finish === 'new reply' ? 'Reply C' : 'Reply B',
          runId,
        );
        assert.equal(result.id === 'B', finish !== 'new reply');
        await notify(store.events(group).at(-1));
      } else if (extraConfirmation === 'straddling') {
        daddy.rename(group, 'Recovered title');
        await reply('B', 'Reply B', 'final');
        await menu(privateChat);
      } else if (extraConfirmation) {
        if (!menuFirst) await reply('B', 'Reply B', 'final');
        await menu(privateChat);
        if (kind === 'rename') daddy.rename(group, 'Recovered title');
        if (kind === 'worker')
          await daddy.configureWorker(group, 1, {
            engine: 'codex',
            model: 'example',
            effort: 'max',
          });
        if (kind === 'preset')
          await daddy.settings(group, { instructions: store.getGroup(group).instructions });
        if (kind === 'text language') setLocale(store, 'ru');
        if (menuFirst) await reply('B', 'Reply B', 'final');
      } else if (competitor) {
        if (competitor === 'first') await menu(false, kind, 18);
        await menu(true);
        await reply('B', 'Reply B', 'final');
        await menu();
        if (competitor === 'last') await menu(false, kind, 18);
      } else if (oldCard) {
        await menu(privateChat, 'browse');
        clock += gap;
        await reply('B', 'Reply B', 'final');
        await menu(privateChat);
      } else if (browse) {
        if (menuFirst) await menu(privateChat, 'browse');
        if (anchored) await menu(privateChat, 'rename');
        await reply('B', 'Reply B', 'final');
        if (!menuFirst) await menu(privateChat, 'browse');
        if (web) await views[browse][1](daddy, store);
      } else {
        if (menuFirst || twoCards) {
          await menu(
            privateChat || (mixedRoutes && menuFirst),
            mixedSettings && !menuFirst ? 'pool' : kind,
          );
          clock += gap;
        }
        await reply('B', 'Reply B', 'final');
        if (twoCards || !menuFirst) {
          clock += gap;
          if (anchored) await menu(privateChat, 'rename');
          await menu(
            privateChat || (mixedRoutes && !menuFirst),
            mixedSettings && menuFirst ? 'pool' : kind,
          );
        }
      }
      if (attempted) assert.equal(sent.length, 2);
      else
        assert.deepEqual(sent, [
          { chat: privateChat ? 7 : topic.chatId, text: '👨‍💻 [daddy]\n\nReply A' },
          { chat: 7, text: 'Other chat triggers 429' },
        ]);
    }
    await bot.stop();
  } finally {
    store.close();
  }
  return snapshot(path);
}

function sentLabel(body) {
  const buttons = body.reply_markup?.inline_keyboard?.flat() ?? [];
  const has = (callback) => buttons.some(({ callback_data }) => callback_data === callback);
  const selected = (callback) =>
    buttons.some(({ text, callback_data }) => callback_data === callback && text.startsWith('✓ '));
  const reply = /Reply ([ABCD])$/.exec(body.text)?.[1];
  if (reply) return reply;
  if (body.text.includes('Legacy task')) return '/task';
  if (/^(Session renamed|Сессия переименована):/.test(body.text)) return '/rename';
  if (body.text.includes('example')) return '/worker';
  if (body.text === 'Язык изменён.') return '/language';
  if (has('language:ru')) return selected('language:ru') ? 'language:ru' : 'language:en';
  if (selected('dad:pool:' + group + ':2')) return 'pool';
  for (const size of [1, 3, 4, 6, 8])
    if (selected('dad:pool:' + group + ':' + size)) return 'pool:' + size;
  const poolTarget = body.text.match(/(?:^|\n)(?:Pool|Пул): [1-8] → ([1-8])\./)?.[1];
  if (poolTarget) return 'pool:' + poolTarget;
  if (has('dad:resume:' + group)) return 'pause';
  if (has('dad:pause:' + group)) return 'resume';
  if (/^(Instructions for this session|Инструкции этой сессии)/.test(body.text))
    return body.text.includes('Recovered instructions') ? 'instructions' : 'instructions:old';
  if (body.text.includes('Recovered preset')) return 'preset';
  if (has('dad:sm:' + group + ':off')) return 'session merge';
  if (has('dad:sm:' + group + ':on')) return 'session merge:off';
  if (selected('dad:tm:' + taskId + ':on')) return 'task merge';
  if (has('dad:tm:' + taskId + ':on')) return 'task merge:old';
  return '/status';
}

async function replay(path, acknowledgedReply, includePrivate = false) {
  const { Store: CurrentStore } = await import(
    replayRevision ? pinned('src/core/store.ts', replayRevision) : '../../src/core/store.ts'
  );
  const { TelegramDelivery } = await import(
    replayRevision
      ? pinned('src/integrations/telegram-delivery.ts', replayRevision)
      : '../../src/integrations/telegram-delivery.ts'
  );
  const store = new CurrentStore(path);
  const actions = [];
  const delivery = new TelegramDelivery(
    store,
    {
      async call(method, body) {
        if (
          method === 'sendMessage' &&
          (body.chat_id === -10042 ||
            (includePrivate && body.chat_id === 7 && body.text !== 'Other chat triggers 429'))
        )
          actions.push(
            (body.chat_id === 7 ? 'private ' : body.message_thread_id === 18 ? '18 ' : '') +
              sentLabel(body),
          );
        return { message_id: 102 + actions.length };
      },
    },
    'offline_fixture:local',
    () => clock,
  );
  try {
    await delivery.flush();
    assert.deepEqual(actions, []);
    clock += 10_000;
    await delivery.flush();
    if (acknowledgedReply) {
      const receipt = store.db
        .prepare(
          `SELECT value FROM settings WHERE key GLOB 'telegram.delivery:*'
        AND json_extract(value,'$.options.key')=?`,
        )
        .get('dialog:' + acknowledgedReply);
      assert.equal(JSON.parse(receipt.value).messages[0].id, 101);
    }
    return actions;
  } finally {
    await delivery.stop();
    store.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), 'telegram-release-order-'));
try {
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  };
  const menuFirst = join(directory, 'menu-then-b.sqlite');
  const replyFirst = join(directory, 'b-then-menu.sqlite');
  const menuThenB = await run(menuFirst, true);
  const bThenMenu = await run(replyFirst, false);
  assert.deepEqual(menuThenB, bThenMenu);
  const persistedMenus = menuThenB.settings.filter(({ key }) =>
    key.startsWith('telegram.delivery:<random menu hash>'),
  );
  assert.equal(persistedMenus.length, 1);
  const menu = persistedMenus[0];
  const turn = menuThenB.settings.find(({ value }) => value.options?.key === 'turn:turn');
  const notice = menuThenB.notifications.find(({ id }) => id.endsWith(':B:final'));
  assert.equal(menu.value.attempts, 0);
  assert.equal(menu.value.createdAt, NativeDate.parse(notice.at));
  assert.equal(turn.value.options.notificationId, notice.id);
  assert.equal(turn.value.createdAt, at);
  assert.ok(turn.slot < menu.slot);
  assert.deepEqual(await replay(menuFirst), ['/status', 'B']);
  clock = at + 1;
  assert.deepEqual(await replay(replyFirst), ['/status', 'B']);
  const earlierMenu = join(directory, 'earlier-menu.sqlite');
  await run(earlierMenu, true, 1);
  assert.deepEqual(await replay(earlierMenu), ['/status', 'B']);
  const laterMenu = join(directory, 'later-menu.sqlite');
  await run(laterMenu, false, 1);
  assert.deepEqual(await replay(laterMenu), ['B', '/status']);
  const wanted = process.env.DADDYLOOP_LEGACY_ORDER_CASE;
  if (!wanted) {
    const languageFirst = join(directory, 'language-then-b.sqlite');
    const bFirst = join(directory, 'b-then-language.sqlite');
    const languageThenB = await run(languageFirst, true, 0, 'language');
    const bThenLanguage = await run(bFirst, false, 0, 'language');
    assert.deepEqual(
      languageThenB.events.map(({ type }) => type),
      ['daddy.message', 'preferences.changed', 'daddy.message'],
    );
    assert.deepEqual(
      bThenLanguage.events.map(({ type }) => type),
      ['daddy.message', 'daddy.message', 'preferences.changed'],
    );
    assert.deepEqual(await replay(languageFirst), ['language:ru', 'B']);
    clock = at + 1;
    assert.deepEqual(await replay(bFirst), ['language:ru', 'B']);
    const twoMenus = join(directory, 'two-languages.sqlite');
    await run(twoMenus, true, 0, 'two languages', { anchored: true });
    assert.deepEqual(await replay(twoMenus), ['language:ru', 'B', '/rename', 'language:ru']);
  }
  for (const [scenario, label] of [
    ['text language', '/language'],
    ['task', '/task'],
    ['rename', '/rename'],
    ['worker', '/worker'],
  ]) {
    if (
      process.env.DADDYLOOP_LEGACY_ORDER_CASE &&
      process.env.DADDYLOOP_LEGACY_ORDER_CASE !== scenario
    )
      continue;
    for (const menuFirst of [true, false]) {
      const path = join(directory, scenario + '-' + menuFirst + '.sqlite');
      const legacy = await run(path, menuFirst, 0, scenario);
      const event = {
        task: 'ticket.imported',
        'text language': 'preferences.changed',
        rename: 'daddy.renamed',
        worker: 'daddy.worker_configured',
      }[scenario];
      const eventSlot = legacy.events.findIndex(({ type }) => type === event);
      const replySlot = legacy.events.findLastIndex(({ type }) => type === 'daddy.message');
      assert.ok(eventSlot >= 0 && replySlot >= 0);
      assert.equal(eventSlot < replySlot, menuFirst);
      assert.deepEqual(
        await replay(path),
        menuFirst ? [label, 'B'] : ['B', label],
        `${label}, ${menuFirst ? 'command first' : 'reply first'}: respect the released event order`,
      );
    }
  }
  for (const [command, event] of [
    ['rename', 'daddy.renamed'],
    ['worker', 'daddy.worker_configured'],
  ]) {
    if (
      process.env.DADDYLOOP_LEGACY_ORDER_CASE &&
      process.env.DADDYLOOP_LEGACY_ORDER_CASE !== command
    )
      continue;
    const path = join(directory, 'two-' + command + '.sqlite');
    const legacy = await run(path, true, 0, 'two ' + command);
    assert.deepEqual(
      legacy.events.map(({ type }) => type),
      ['daddy.message', event, 'daddy.message', event],
    );
    assert.deepEqual(
      await replay(path),
      ['/' + command, 'B', '/' + command],
      command + ': two identical confirmations must surround the reply',
    );
  }
  for (const [command, event] of [
    ['rename', 'daddy.renamed'],
    ['worker', 'daddy.worker_configured'],
  ]) {
    if (
      process.env.DADDYLOOP_LEGACY_ORDER_CASE &&
      process.env.DADDYLOOP_LEGACY_ORDER_CASE !== 'mixed ' + command
    )
      continue;
    for (const extraSession of [false, true]) {
      for (const privateFirst of [true, false]) {
        const path = join(
          directory,
          'mixed-' + command + '-' + privateFirst + '-' + extraSession + '.sqlite',
        );
        const legacy = await run(path, privateFirst, 0, 'mixed ' + command, { extraSession });
        assert.deepEqual(
          legacy.events.map(({ type }) => type),
          ['daddy.message', event, 'daddy.message', event],
        );
        const label = '/' + command;
        assert.deepEqual(
          await replay(path, undefined, true),
          privateFirst ? ['private ' + label, 'B', label] : [label, 'B', 'private ' + label],
          command + ': confirmations in different chats must surround the reply',
        );
      }
    }
  }
  for (const [scenario, [, event]] of Object.entries(sessionActions)) {
    if (
      process.env.DADDYLOOP_LEGACY_ORDER_CASE &&
      process.env.DADDYLOOP_LEGACY_ORDER_CASE !== scenario
    )
      continue;
    for (const menuFirst of [true, false]) {
      const path = join(directory, scenario + '-' + menuFirst + '.sqlite');
      const anchored = scenario !== 'preset' && !menuFirst;
      const legacy = await run(path, menuFirst, 0, scenario, { anchored });
      const eventSlot = legacy.events.findIndex(({ type }) => type === event);
      const replySlot = legacy.events.findLastIndex(({ type }) => type === 'daddy.message');
      assert.ok(eventSlot >= 0 && replySlot >= 0, scenario + ': command did not record its effect');
      assert.equal(eventSlot < replySlot, menuFirst);
      const label = scenario.replace(/ button$/, '');
      const cards = legacy.settings.filter(
        ({ value }) => value.options && !value.options.key && value.destination.chatId === -10042,
      );
      assert.equal(cards.length, anchored ? 2 : 1);
      assert.equal(cards[0].value.attempts, 0);
      assert.deepEqual(
        await replay(path),
        menuFirst ? [label, 'B'] : anchored ? ['B', '/rename', label] : ['B', label],
        scenario,
      );
    }
  }
  if (
    !process.env.DADDYLOOP_LEGACY_ORDER_CASE ||
    process.env.DADDYLOOP_LEGACY_ORDER_CASE === 'mixed settings'
  ) {
    for (const instructionsFirst of [true, false]) {
      const path = join(directory, 'mixed-settings-' + instructionsFirst + '.sqlite');
      const legacy = await run(path, instructionsFirst, 0, 'mixed settings', { anchored: true });
      assert.deepEqual(
        legacy.events.map(({ type }) => type),
        ['daddy.message', 'daddy.settings', 'daddy.message', 'daddy.renamed', 'daddy.settings'],
      );
      assert.deepEqual(
        await replay(path),
        instructionsFirst
          ? ['instructions', 'B', '/rename', 'pool']
          : ['pool', 'B', '/rename', 'instructions'],
      );
    }
  }
  if (!wanted || wanted === 'private sessions') {
    for (const extraSession of [false, true]) {
      for (const scenario of ['rename', 'worker', 'task', ...Object.keys(sessionActions)]) {
        for (const menuFirst of [true, false]) {
          const path = join(
            directory,
            'private-' + scenario + '-' + extraSession + '-' + menuFirst,
          );
          const anchored = !menuFirst && scenario in sessionActions && scenario !== 'preset';
          await run(path, menuFirst, 0, scenario, { privateChat: true, extraSession, anchored });
          const label =
            'private ' +
            (['rename', 'worker', 'task'].includes(scenario)
              ? '/' + scenario
              : scenario.replace(/ button$/, ''));
          assert.deepEqual(
            await replay(path, undefined, true),
            menuFirst
              ? [label, 'private B']
              : anchored
                ? ['private B', 'private /rename', label]
                : ['private B', label],
            scenario + ' extra session=' + extraSession,
          );
        }
      }
    }
  }
  if (!wanted || wanted === 'browse pool') {
    for (const browse of Object.keys(views)) {
      const scenario = browse === 'language' ? 'status' : browse;
      const label = browse === 'language' ? 'language:ru' : browse;
      const path = (name) => join(directory, browse + '-' + name + '.sqlite');
      const view = { browse, web: true };
      await run(path('anchored'), true, 0, scenario, { ...view, anchored: true });
      assert.deepEqual(await replay(path('anchored')), [label, '/rename', 'B']);
      if (['pause', 'resume', 'task merge'].includes(browse)) continue;
      const viewFirst = await run(path('view-first'), true, 0, scenario, view);
      const replyFirst = await run(path('view-last'), false, 0, scenario, view);
      assert.deepEqual(viewFirst, replyFirst);
      assert.equal(Object.keys(viewFirst).length, 18);
      for (const name of ['view-first', 'view-last']) {
        clock = at + 1;
        assert.deepEqual(await replay(path(name)), [label, 'B']);
      }
      if (browse === 'pool') {
        const change = await run(path('real-change'), false, 0, 'pool');
        assert.deepEqual(change, replyFirst);
        assert.deepEqual(await replay(path('real-change')), ['pool', 'B']);
        await run(path('attempted'), true, 0, 'pool', { ...view, attempted: true });
        assert.deepEqual(await replay(path('attempted')), ['pool', 'B']);
      }
      if (browse === 'language') {
        const change = await run(path('real-change'), false, 0, 'language', {
          languageAlreadySelected: true,
        });
        assert.deepEqual(change, replyFirst);
        assert.deepEqual(await replay(path('real-change')), ['language:ru', 'B']);
      }
    }
  }
  if (!wanted || wanted === 'recorded state') {
    const cases = [
      ['pool', 'pool', 'pool:1'],
      ['session merge', 'session merge', 'session merge:off'],
      ['task merge', 'task merge', 'task merge:old'],
      ['language', 'language:ru', 'language:en'],
    ];
    for (const [scenario, label, old] of cases) {
      for (const privateChat of [false, true]) {
        for (const extraSession of [false, true]) {
          const route = privateChat ? 'private ' : '';
          for (const menuFirst of [false, true]) {
            const path = join(
              directory,
              'state-' + [scenario, privateChat, extraSession, menuFirst].join('-'),
            );
            await run(path, menuFirst, 0, scenario, {
              privateChat,
              extraSession,
              recordedState: true,
            });
            assert.deepEqual(
              await replay(path, 'A', true),
              (menuFirst ? [label, 'B'] : ['B', label]).map((x) => route + x),
              scenario,
            );
          }
          const path = join(
            directory,
            'view-transition-' + [scenario, privateChat, extraSession].join('-'),
          );
          await run(path, false, 0, scenario, {
            privateChat,
            extraSession,
            recordedState: true,
            oldCard: true,
          });
          assert.deepEqual(
            await replay(path, 'A', true),
            [old, 'B', label].map((x) => route + x),
            scenario,
          );
        }
      }
    }
    for (const [scenario, old] of [
      ['pause', 'resume'],
      ['resume', 'pause'],
      ['instructions', 'instructions:old'],
    ]) {
      const path = join(directory, 'view-transition-' + scenario);
      await run(path, false, 0, scenario, { oldCard: true });
      assert.deepEqual(await replay(path, 'A'), [old, 'B', scenario]);
    }
  }
  if (!wanted || wanted === 'multiple confirmations') {
    for (const [scenario, label] of [
      ['rename', '/rename'],
      ['worker', '/worker'],
      ['preset', 'preset'],
      ['text language', '/language'],
    ]) {
      for (const menuFirst of [false, true]) {
        const path = join(directory, 'confirmations-' + scenario + menuFirst);
        await run(path, menuFirst, 0, scenario, { extraConfirmation: true });
        assert.deepEqual(
          await replay(path, 'A'),
          menuFirst ? [label, 'B'] : ['B', label],
          scenario,
        );
      }
    }
    const ambiguous = join(directory, 'confirmations-straddling');
    await run(ambiguous, false, 0, 'rename', { extraConfirmation: 'straddling' });
    assert.deepEqual(await replay(ambiguous, 'A'), ['/rename', 'B']);
    for (const kind of ['rename', 'worker']) {
      const label = '/' + kind;
      for (const competitor of ['first', 'last']) {
        const path = join(directory, 'competing-' + kind + competitor);
        await run(path, false, 0, 'mixed ' + kind, { extraSession: true, competitor });
        const primary = ['private ' + label, 'B', label];
        assert.deepEqual(
          await replay(path, 'A', true),
          competitor === 'first' ? ['18 ' + label, ...primary] : [...primary, '18 ' + label],
        );
      }
    }
  }
  if (!wanted || wanted === 'promotion') {
    for (const privateChat of [false, true]) {
      for (const [scenario, label] of [
        ['status', '/status'],
        ['rename', '/rename'],
        ['pool', 'pool'],
      ]) {
        for (const finish of ['same reply', 'new reply', 'next run']) {
          const path = join(directory, 'promotion-' + [privateChat, scenario, finish].join('-'));
          await run(path, false, 0, scenario, { privateChat, finish });
          const expected = finish === 'new reply' ? ['B', label, 'C'] : ['B', label];
          assert.deepEqual(
            await replay(path, 'A', true),
            expected.map((x) => (privateChat ? 'private ' + x : x)),
            finish,
          );
        }
      }
    }
  }
  if (!wanted || wanted === 'earlier observations') {
    for (const privateChat of [false, true]) {
      const route = privateChat ? 'private ' : '';
      for (const [scenario, old, current] of [
        ['pool', 'pool:1', 'pool'],
        ['pause', 'resume', 'pause'],
        ['resume', 'pause', 'resume'],
        ['instructions', 'instructions:old', 'instructions'],
        ['session merge', 'session merge:off', 'session merge'],
        ['task merge', 'task merge:old', 'task merge'],
      ]) {
        for (const gap of [0, 1]) {
          const path = join(directory, 'earlier-' + [scenario, gap, privateChat].join('-'));
          await run(path, false, gap, scenario, { privateChat, oldCard: true });
          assert.deepEqual(
            await replay(path, 'A', true),
            [old, 'B', current].map((x) => route + x),
            scenario,
          );
        }
      }
      for (let poolSize = 1; poolSize <= 8; poolSize++) {
        const path = join(directory, 'pool-size-' + [poolSize, privateChat].join('-'));
        await run(path, false, 0, 'pool', { poolSize, privateChat, recordedState: true });
        const card = poolSize === 2 ? 'pool' : 'pool:' + poolSize;
        const expected = poolSize === 1 ? [card, 'B'] : ['B', card];
        assert.deepEqual(
          await replay(path, 'A', true),
          expected.map((x) => route + x),
          card,
        );
      }
    }
  }
  if (!wanted || wanted === 'mixed confirmations') {
    for (const privateChat of [false, true]) {
      const route = privateChat ? 'private ' : '';
      for (const [scenario, crossCommand, label, crossLabel] of [
        ['rename', 'worker', '/rename', '/worker'],
        ['worker', 'rename', '/worker', '/rename'],
        ['rename', 'task', '/rename', '/task'],
        ['worker', 'task', '/worker', '/task'],
        ['preset', 'task', 'preset', '/task'],
        ['text language', 'task', '/language', '/task'],
      ]) {
        const path = join(
          directory,
          'mixed-confirmation-' + [scenario, crossCommand, privateChat].join('-'),
        );
        await run(path, false, 0, scenario, { crossCommand, privateChat });
        assert.deepEqual(
          await replay(path, 'A', true),
          [crossLabel, 'B', label].map((x) => route + x),
        );
        if (crossCommand === 'task' && ['/rename', '/worker'].includes(label)) {
          await run(path + '-delayed', false, 0, scenario, {
            crossCommand,
            privateChat,
            delayedConfirmation: true,
          });
          assert.deepEqual(
            await replay(path + '-delayed', 'A', true),
            [label, crossLabel, 'B'].map((x) => route + x),
          );
        }
      }
    }
  }
  if (!wanted || wanted === 'mixed confirmations') {
    const mixedRoutes = join(directory, 'mixed-confirmation-private-topic');
    await run(mixedRoutes, false, 0, 'rename', { crossCommand: 'worker', splitRoute: true });
    assert.deepEqual(await replay(mixedRoutes, 'A', true), ['private /worker', 'B', '/rename']);
    for (const privateChat of [false, true]) {
      const path = join(directory, 'state-return-' + privateChat);
      await run(path, false, 0, 'pool', {
        crossCommand: 'task',
        poolSize: 1,
        recordedState: true,
        privateChat,
      });
      assert.deepEqual(
        await replay(path, 'A', true),
        ['/task', 'B', 'pool:1'].map((x) => (privateChat ? 'private ' + x : x)),
      );
    }
  }
  if (!wanted || wanted === 'across runs') {
    for (const privateChat of [false, true]) {
      const overlapping = join(directory, 'across-turns-overlap-' + privateChat);
      await run(overlapping, false, 0, 'status', { nextTurn: 'overlap', privateChat });
      assert.deepEqual(
        await replay(overlapping, 'A', true),
        ['C', 'B', 'D'].map((x) => (privateChat ? 'private ' + x : x)),
      );
      const reversed = join(directory, 'across-turns-reversed-' + privateChat);
      const between = reversed + '-between';
      const reversedOptions = { nextTurn: 'first', privateChat, extraMenu: true };
      const afterBoth = await run(reversed, false, 0, 'status', reversedOptions);
      const betweenReplies = await run(between, false, 0, 'status', {
        ...reversedOptions,
        menuBetweenTurns: true,
      });
      // C's own row proves that C precedes the menu and B. The overwritten
      // turn row leaves the relative order of B and this menu ambiguous.
      assert.deepEqual(afterBoth, betweenReplies);
      for (const path of [reversed, between]) {
        clock = at + 1;
        assert.deepEqual(
          await replay(path, 'A', true),
          ['C', '/status', 'B'].map((x) => (privateChat ? 'private ' + x : x)),
        );
      }
      for (const promote of [false, true]) {
        for (const gap of [0, 1]) {
          for (const scenario of ['no menu', 'rename', 'status']) {
            const path = join(
              directory,
              'across-turns-' + [privateChat, promote, gap, scenario].join('-'),
            );
            await run(path, false, gap, scenario, {
              nextTurn: 'last',
              promote,
              privateChat,
              extraMenu: scenario !== 'no menu',
            });
            const expected = scenario === 'no menu' ? ['B', 'C'] : ['B', 'C', '/' + scenario];
            assert.deepEqual(
              await replay(path, 'A', true),
              expected.map((x) => (privateChat ? 'private ' + x : x)),
              scenario,
            );
          }
        }
      }
    }
  }
  const third = join(directory, 'c-then-menu.sqlite');
  await run(third, false, 0, 'third');
  assert.deepEqual(await replay(third), ['C', '/status']);
  const duplicateAcknowledged = join(directory, 'duplicate-acknowledged.sqlite');
  await run(duplicateAcknowledged, false, 0, 'duplicate acknowledged');
  assert.deepEqual(await replay(duplicateAcknowledged, 'A'), ['A', 'C']);
  const duplicateDelayed = join(directory, 'duplicate-delayed.sqlite');
  await run(duplicateDelayed, false, 0, 'duplicate delayed');
  assert.deepEqual(await replay(duplicateDelayed), ['A', 'A', 'C']);
  const tailAcknowledged = join(directory, 'duplicate-tail-acknowledged.sqlite');
  await run(tailAcknowledged, false, 0, 'duplicate tail acknowledged');
  assert.deepEqual(await replay(tailAcknowledged, 'A'), ['A']);
  const tailDelayed = join(directory, 'duplicate-tail-delayed.sqlite');
  await run(tailDelayed, false, 0, 'duplicate tail delayed');
  assert.deepEqual(await replay(tailDelayed), ['A', 'A']);
  console.log(
    JSON.stringify(
      {
        release,
        histories: [
          'A acknowledged → other chat 429 → /status → B',
          'A acknowledged → other chat 429 → B → /status',
        ],
        legacyRows: {
          turn: { slot: turn.slot, createdAt: turn.value.createdAt, proposed: notice.id },
          menu: { slot: menu.slot, createdAt: menu.value.createdAt, attempts: menu.value.attempts },
          notificationB: { slot: notice.slot, at: notice.at },
        },
        tiedReplay: ['/status', 'B'],
        distinctReplay: [
          ['/status', 'B'],
          ['B', '/status'],
        ],
        normalizedSnapshotSha256: createHash('sha256')
          .update(JSON.stringify(menuThenB))
          .digest('hex'),
        tablesCompared: Object.keys(menuThenB),
        languageReplay: [
          ['language:ru', 'B'],
          ['language:ru', 'B'],
        ],
        attemptedThirdReplay: ['C', '/status'],
        repeatedLanguageReplay: ['language:ru', 'B', '/rename', 'language:ru'],
        textLanguageReplay: [
          ['/language', 'B'],
          ['B', '/language'],
        ],
        taskReplay: [
          ['/task', 'B'],
          ['B', '/task'],
        ],
        renameReplay: [
          ['/rename', 'B'],
          ['B', '/rename'],
        ],
        workerReplay: [
          ['/worker', 'B'],
          ['B', '/worker'],
        ],
        duplicateReplay: [
          ['A', 'C'],
          ['A', 'A', 'C'],
        ],
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.Date = NativeDate;
  hook.deregister();
  rmSync(directory, { recursive: true, force: true });
}
