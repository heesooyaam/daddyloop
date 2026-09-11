import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { moduleCatalogue, checkedModules } from '../modules/catalogue.js';
import { loadConfig, privateWrite, configSchema } from './config.js';
export function registerModuleCommands(program: Command) {
  const modules = program
    .command('modules')
    .description('Installed integrations and agent modules');
  modules.command('list', { isDefault: true }).action(() => {
    const enabled = loadConfig().modules;
    process.stdout.write(
      JSON.stringify(
        moduleCatalogue.map((module) => ({ ...module, enabled: enabled.includes(module.id) })),
        null,
        2,
      ) + '\n',
    );
  });
  modules
    .command('select')
    .description('Choose the modules for an installation')
    .requiredOption('--file <path>', 'write the verified selection to this private file')
    .option('--modules <ids>', 'comma-separated module IDs')
    .option('--from-config <path>', 'reuse a current-format configuration selection')
    .option('--yes', 'use defaults without the interactive picker')
    .action(async (options) => {
      const defaults = moduleCatalogue
        .filter((module) => module.recommended)
        .map((module) => module.id) as string[];
      let selected = defaults;
      if (options.fromConfig && existsSync(options.fromConfig)) {
        const saved = configSchema.parse(JSON.parse(readFileSync(options.fromConfig, 'utf8')));
        if (saved.version !== 3)
          throw new Error('Convert the existing configuration before upgrading this installation.');
        selected = checkedModules(saved.modules);
      }
      if (options.modules !== undefined)
        selected = checkedModules(
          options.modules
            .split(',')
            .map((id: string) => id.trim())
            .filter(Boolean),
        );
      else if (!options.yes && process.stdin.isTTY && process.stdout.isTTY)
        selected = await (
          await import('../terminal/module-picker.js')
        ).pickModules(selected, loadConfig().locale);
      if (
        !moduleCatalogue.some(
          (module) => module.kind === 'agent' && selected.includes(module.id),
        ) ||
        !moduleCatalogue.some(
          (module) => module.kind === 'repository' && selected.includes(module.id),
        )
      )
        throw new Error('Choose at least one agent and one repository module.');
      privateWrite(options.file, JSON.stringify({ modules: selected }) + '\n');
    });
}
