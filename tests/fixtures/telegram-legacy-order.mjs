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
const sources = new Set(git('ls-tree', '-r', '--name-only', release, 'src').trim().split('\n'));
const suffix = '?telegram-released';
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith(suffix) && specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL);
      const path = url.href.slice(root.href.length);
      const source = [path, path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx')].find(
        (candidate) => sources.has(candidate),
      );
      if (source) return { url: new URL(source, root).href + suffix, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(suffix)) return next(url, context);
    const path = url.slice(root.href.length, -suffix.length);
    const source = git('show', release + ':' + path);
    return {
      format: 'module',
      shortCircuit: true,
      source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
    };
  },
});
const { Store } = await import(new URL('src/core/store.ts', root).href + suffix);
const { Telegram, TelegramApi } = await import(
  new URL('src/integrations/telegram.ts', root).href + suffix
);
const { Engine } = await import(new URL('src/core/engine.ts', root).href + suffix);
const group = '1b951e45-19d6-4890-93f7-7e5d90962624';
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
    const engine =
      scenario === 'task'
        ? new Engine(store, () => {
            throw new Error('Offline fixture');
          })
        : { store };
    if (scenario === 'task')
      store.saveGroup({
        ...store.getGroup(group),
        generation: 1,
        daddyState: 'active',
        daddy: engine.defaultAgents().daddy,
      });
    const createTask = (_groupId, input) =>
      engine.createTicket({
        id: '9f8677ba-776e-4a81-ba88-364099269ea4',
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
    bot.configure({ daddy: { engine, group: () => store.getGroup(group), createTask } });
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
    const menu = async () => {
      const chat = { id: topic.chatId, type: 'supergroup' };
      const from = { id: 7, first_name: 'Owner' };
      const update_id = nextUpdate++;
      const message = { message_id: update_id - 2, chat, message_thread_id: topic.threadId };
      const command =
        scenario === 'text language'
          ? '/language ru'
          : scenario === 'task'
            ? '/task Legacy task'
            : '/status';
      await bot.handle(
        scenario === 'language' || scenario === 'two languages'
          ? {
              update_id,
              callback_query: { id: 'language-' + update_id, data: 'language:ru', from, message },
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
      if (menuFirst) {
        await menu();
        clock += gap;
      }
      await reply('B', 'Reply B', 'final');
      if (!menuFirst || scenario === 'two languages') {
        clock += gap;
        await menu();
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

async function replay(path, acknowledgedReply) {
  const { Store: CurrentStore } = await import('../../src/core/store.ts');
  const { TelegramDelivery } = await import('../../src/integrations/telegram-delivery.ts');
  const store = new CurrentStore(path);
  const actions = [];
  const delivery = new TelegramDelivery(
    store,
    {
      async call(method, body) {
        if (body.chat_id === -10042 && method === 'sendMessage')
          actions.push(
            /Reply ([ABC])$/.exec(body.text)?.[1] ??
              (body.text.includes('Legacy task')
                ? '/task'
                : body.text === 'Язык изменён.'
                  ? '/language'
                  : body.reply_markup?.inline_keyboard?.[0]?.some(({ callback_data }) =>
                        callback_data?.startsWith('language:'),
                      )
                    ? 'language:ru'
                    : '/status'),
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
  ]) {
    for (const menuFirst of [true, false]) {
      const path = join(directory, scenario + '-' + menuFirst + '.sqlite');
      const legacy = await run(path, menuFirst, 0, scenario);
      const event = scenario === 'task' ? 'ticket.imported' : 'preferences.changed';
      const eventSlot = legacy.events.findIndex(({ type }) => type === event);
      const replySlot = legacy.events.findLastIndex(({ type }) => type === 'daddy.message');
      assert.ok(eventSlot >= 0 && replySlot >= 0);
      assert.equal(eventSlot < replySlot, menuFirst);
      assert.deepEqual(await replay(path), menuFirst ? [label, 'B'] : ['B', label]);
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
