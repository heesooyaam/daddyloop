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
const { Daddy } = await import(pinned('src/core/daddy.ts'));
const group = '1b951e45-19d6-4890-93f7-7e5d90962624';
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

async function run(path, menuFirst, gap = 0, scenario = 'status') {
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
    store.setSetting('telegram.group', { chatId: topic.chatId, ownerId: topic.ownerId });
    store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    store.db
      .prepare('INSERT INTO telegram_topics VALUES(?,?,?)')
      .run('7:-10042:' + group, group, JSON.stringify(topic));
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, init) => {
      const method = new URL(url).pathname.split('/').at(-1);
      const body = JSON.parse(init.body);
      if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
      assert.ok(['sendMessage', 'editMessageText'].includes(method));
      sent.push({ chat: body.chat_id, text: body.text });
      const limited =
        body.chat_id === 7 ||
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
    const needsEngine = ['task', 'worker'].includes(kind) || kind in sessionActions;
    const engine = needsEngine
      ? new Engine(store, () => {
          throw new Error('Offline fixture');
        })
      : { store };
    if (needsEngine)
      store.saveGroup({
        ...store.getGroup(group),
        generation: 1,
        daddyState: kind.startsWith('resume') ? 'paused' : 'active',
        workspace: { name: 'Fixture', provider: 'github' },
        workerLimit: 1,
        daddy: engine.defaultAgents().daddy,
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
      group: () => store.getGroup(group),
      createTask,
      catalogue: { validate: async () => {} },
      running: new Map(),
      maintenance: new Map(),
      ...(!needsEngine && { board: () => ({ group: store.getGroup(group) }) }),
    });
    if (kind === 'preset')
      new InstructionPresets(store).save({
        name: 'Legacy preset',
        instructions: { daddy: {}, worker: { prompt: 'Recovered preset' } },
      });
    if (kind === 'task merge')
      createTask(group, { requestId: 'fixture-task', requirements: 'Task to merge' });
    if (scenario.startsWith('mixed ')) store.setSetting('telegram.currentDaddy', group);
    bot.configure({ daddy });
    const reply = async (id, text, phase) => {
      store.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(
        id,
        group,
        JSON.stringify({
          id,
          taskId: group,
          text,
          phase,
          sender: 'agent',
          runId: 'turn',
          at: new Date().toISOString(),
        }),
      );
      const event = store.event(group, 'daddy.message', { messageId: id }, 'turn');
      bot.workspace.onEvent(event);
      await bot.workspace.pending;
    };
    let nextUpdate = 17;
    const menu = async (privateChat = false, action = kind) => {
      const chat = privateChat
        ? { id: 7, type: 'private' }
        : { id: topic.chatId, type: 'supergroup' };
      const from = { id: 7, first_name: 'Owner' };
      const update_id = nextUpdate++;
      const message = {
        message_id: update_id - 2,
        chat,
        message_thread_id: privateChat ? undefined : topic.threadId,
      };
      const command =
        scenario === 'text language'
          ? '/language ru'
          : scenario === 'task'
            ? '/task Legacy task'
            : kind === 'rename'
              ? '/rename Recovered title'
              : kind === 'worker'
                ? '/worker 1 example max'
                : (sessionActions[action]?.[0] ?? '/status');
      const data =
        scenario === 'language' || scenario === 'two languages'
          ? 'language:ru'
          : command.startsWith('dad:')
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
      await api.send(7, 'Other chat triggers 429', undefined, { key: 'flood' });
      const mixedRoutes = scenario.startsWith('mixed ') && !mixedSettings;
      const twoCards = mixedRoutes || mixedSettings || scenario.startsWith('two ');
      if (menuFirst || twoCards) {
        await menu(mixedRoutes && menuFirst, mixedSettings && !menuFirst ? 'pool' : kind);
        clock += gap;
      }
      await reply('B', 'Reply B', 'final');
      if (twoCards || !menuFirst) {
        clock += gap;
        await menu(mixedRoutes && !menuFirst, mixedSettings && menuFirst ? 'pool' : kind);
      }
      assert.deepEqual(sent, [
        { chat: topic.chatId, text: '👨‍💻 [daddy]\n\nReply A' },
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
  const reply = /Reply ([ABC])$/.exec(body.text)?.[1];
  if (reply) return reply;
  if (body.text.includes('Legacy task')) return '/task';
  if (body.text.includes('Recovered title')) return '/rename';
  if (body.text.includes('example')) return '/worker';
  if (body.text === 'Язык изменён.') return '/language';
  if (has('language:ru')) return 'language:ru';
  if (selected('dad:pool:' + group + ':2')) return 'pool';
  if (has('dad:resume:' + group)) return 'pause';
  if (has('dad:pause:' + group)) return 'resume';
  if (body.text.includes('Recovered instructions')) return 'instructions';
  if (body.text.includes('Recovered preset')) return 'preset';
  if (has('dad:sm:' + group + ':off')) return 'session merge';
  if (selected('dad:tm:' + taskId + ':on')) return 'task merge';
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
          actions.push((body.chat_id === 7 ? 'private ' : '') + sentLabel(body));
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
  assert.deepEqual(await replay(bFirst), ['B', 'language:ru']);
  const twoMenus = join(directory, 'two-languages.sqlite');
  await run(twoMenus, true, 0, 'two languages');
  assert.deepEqual(await replay(twoMenus), ['language:ru', 'B', 'language:ru']);
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
    for (const privateFirst of [true, false]) {
      const path = join(directory, 'mixed-' + command + '-' + privateFirst + '.sqlite');
      const legacy = await run(path, privateFirst, 0, 'mixed ' + command);
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
  for (const [scenario, [, event]] of Object.entries(sessionActions)) {
    if (
      process.env.DADDYLOOP_LEGACY_ORDER_CASE &&
      process.env.DADDYLOOP_LEGACY_ORDER_CASE !== scenario
    )
      continue;
    for (const menuFirst of [true, false]) {
      const path = join(directory, scenario + '-' + menuFirst + '.sqlite');
      const legacy = await run(path, menuFirst, 0, scenario);
      const eventSlot = legacy.events.findIndex(({ type }) => type === event);
      const replySlot = legacy.events.findLastIndex(({ type }) => type === 'daddy.message');
      assert.ok(eventSlot >= 0 && replySlot >= 0, scenario + ': command did not record its effect');
      assert.equal(eventSlot < replySlot, menuFirst);
      const label = scenario.replace(/ button$/, '');
      const cards = legacy.settings.filter(
        ({ value }) => value.options && !value.options.key && value.destination.chatId === -10042,
      );
      assert.equal(cards.length, 1);
      assert.equal(cards[0].value.attempts, 0);
      assert.deepEqual(await replay(path), menuFirst ? [label, 'B'] : ['B', label], scenario);
    }
  }
  if (
    !process.env.DADDYLOOP_LEGACY_ORDER_CASE ||
    process.env.DADDYLOOP_LEGACY_ORDER_CASE === 'mixed settings'
  ) {
    for (const instructionsFirst of [true, false]) {
      const path = join(directory, 'mixed-settings-' + instructionsFirst + '.sqlite');
      const legacy = await run(path, instructionsFirst, 0, 'mixed settings');
      assert.deepEqual(
        legacy.events.map(({ type }) => type),
        ['daddy.message', 'daddy.settings', 'daddy.message', 'daddy.settings'],
      );
      assert.deepEqual(
        await replay(path),
        instructionsFirst ? ['instructions', 'B', 'pool'] : ['pool', 'B', 'instructions'],
      );
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
          ['B', 'language:ru'],
        ],
        attemptedThirdReplay: ['C', '/status'],
        repeatedLanguageReplay: ['language:ru', 'B', 'language:ru'],
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
