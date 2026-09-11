import { createInterface } from 'node:readline/promises';
import type { DaddyApi, DaddySession } from '../client/daddy.js';
import { DaddyClient } from '../client/daddy.js';
import { translator, type Locale } from '../i18n/index.js';
import type { UsageView } from '../core/usage.js';
import { usageLines } from '../client/usage.js';
import { safeText } from '../terminal/text.js';
export async function runDaddyPlain(api: DaddyApi, options: { id?: string; locale?: Locale } = {}) {
  const t = translator(options.locale ?? 'en');
  if (!process.stdin.isTTY) {
    process.stdout.write(t('Run daddy in a terminal, or use daddy --help for commands.') + '\n');
    return;
  }
  const model = new DaddyClient(api, options.id);
  await model.refresh();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const seen = new Set<string>();
  const unsubscribe = model.subscribe(() => {
    for (const message of model.snapshot().board?.messages ?? [])
      if (message.sender !== 'user' && !seen.has(message.id)) {
        seen.add(message.id);
        process.stdout.write('\nDaddy: ' + safeText(message.text) + '\n');
        rl.prompt(true);
      }
  });
  model.start();
  process.stdout.write('daddyloop · /new, /sessions, /pool, /repo, /limits, /quit\n');
  try {
    for await (const line of rl) {
      const input = line.trim();
      if (input === '/quit') break;
      if (input === '/limits') {
        const usage = await api<UsageView>('/usage?refresh=1');
        process.stdout.write(usageLines(usage, options.locale ?? 'en').join('\n') + '\n');
      } else if (input === '/sessions') {
        await model.refresh();
        for (const group of model.snapshot().sessions)
          process.stdout.write(`${group.id.slice(0, 8)}  ${group.title}\n`);
      } else if (input.startsWith('/use ')) {
        const matches = (await api<DaddySession[]>('/daddy/sessions')).filter((group) =>
          group.id.startsWith(input.slice(5)),
        );
        if (matches.length === 1) await model.select(matches[0].id);
      } else if (input.startsWith('/new ')) {
        const name = input.slice(5),
          workspace = model
            .snapshot()
            .workspaces.find(
              (workspace) => workspace.name === name || workspace.id.startsWith(name),
            );
        if (workspace) await model.create(workspace.id);
        else process.stdout.write(t('Choose a registered workspace.') + '\n');
      } else if (input === '/repo' || input.startsWith('/repo ')) {
        const path = input.slice(5).trim();
        model.repository(path && path !== 'default' ? { path } : undefined);
        process.stdout.write(
          path && path !== 'default' ? safeText(path) + '\n' : t('Using workspace defaults') + '\n',
        );
      } else if (input.startsWith('/pool '))
        await model.action('settings', { workerLimit: Number(input.slice(6)) });
      else if (input === '/pool') {
        const pool = model.snapshot().board?.workers;
        if (pool)
          process.stdout.write(
            t(
              pool.pending
                ? 'Pool: {limit} → {target}. Changes apply in the background.'
                : 'Pool: {limit}. Occupied by tasks: {occupied}.',
              pool,
            ) + '\n',
          );
      } else {
        model.draft(line);
        await model.send();
      }
      const value = model.snapshot();
      if (value.error) process.stdout.write(value.error + '\n');
      rl.setPrompt('daddy> ');
      rl.prompt();
    }
  } finally {
    unsubscribe();
    rl.close();
    model.stop();
  }
}
