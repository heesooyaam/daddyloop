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

async function run(path, menuFirst, gap = 0) {
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
      assert.equal(method, 'sendMessage');
      sent.push({ chat: body.chat_id, text: body.text });
      return body.chat_id === 7
        ? Response.json({
            ok: false,
            error_code: 429,
            description: 'Flood wait',
            parameters: { retry_after: 10 },
          })
        : Response.json({ ok: true, result: { message_id: 101 } });
    });
    const bot = new Telegram({ store }, api, 'offline_fixture');
    // The workspace only reads this session; no workers or real provider run.
    bot.configure({ daddy: { engine: { store }, group: () => store.getGroup(group) } });
    const reply = async (id, text, phase) => {
      store.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(
        id,
        group,
        JSON.stringify({
          id,
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
    const menu = async () => {
      await bot.handle({
        update_id: 17,
        message: {
          message_id: 15,
          text: '/status',
          chat: { id: topic.chatId, type: 'supergroup' },
          from: { id: 7, first_name: 'Owner' },
          message_thread_id: topic.threadId,
        },
      });
      // Same persisted cursor write as the released getUpdates loop.
      store.transaction(() => {
        store.setSetting('telegram.offset', 18);
        store.setSetting('telegram.offsetAt', Date.now());
      });
    };
    await reply('A', 'Reply A', 'progress');
    clock += 1;
    await api.send(7, 'Other chat triggers 429', undefined, { key: 'flood' });
    if (menuFirst) {
      await menu();
      clock += gap;
    }
    await reply('B', 'Reply B', 'final');
    if (!menuFirst) {
      clock += gap;
      await menu();
    }
    await bot.stop();
    assert.deepEqual(sent, [
      { chat: topic.chatId, text: '👨‍💻 [daddy]\n\nReply A' },
      { chat: 7, text: 'Other chat triggers 429' },
    ]);
  } finally {
    store.close();
  }
  return snapshot(path);
}

async function replay(path) {
  const { Store: CurrentStore } = await import('../../src/core/store.ts');
  const { TelegramDelivery } = await import('../../src/integrations/telegram-delivery.ts');
  const store = new CurrentStore(path);
  const actions = [];
  const delivery = new TelegramDelivery(
    store,
    {
      async call(method, body) {
        if (body.chat_id === -10042 && method === 'sendMessage')
          actions.push(body.text.endsWith('Reply B') ? 'B' : '/status');
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
