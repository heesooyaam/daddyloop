import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig, defaultDataDir } from '../config.js';
import { createBackup, inspectBackup, restoreBackup } from './snapshot.js';
const size = (value: string) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1024)
    throw new Error('Use --max-gib between 0 and 1024');
  return number;
};
export function registerBackupCommands(program: Command) {
  const print = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const backup = program
    .command('backup')
    .description('Portable snapshots of sessions, results and working files');
  backup
    .command('create')
    .argument('<archive>', 'new .tar.gz file outside the data directory')
    .option('--max-gib <size>', 'maximum uncompressed snapshot size', size, 20)
    .action(async (path, options) => {
      const config = loadConfig();
      print(
        await createBackup(
          program.opts().dataDir ?? defaultDataDir(config),
          resolve(path),
          config,
          options.maxGib,
        ),
      );
    });
  backup
    .command('inspect')
    .argument('<archive>')
    .option('--max-gib <size>', 'maximum uncompressed snapshot size', size, 20)
    .action(async (path, options) =>
      print(await inspectBackup(resolve(path), options.maxGib, loadConfig().resources.minDiskGiB)),
    );
  backup
    .command('restore')
    .argument('<archive>')
    .requiredOption('--to <directory>', 'new data directory; never overwrite existing data')
    .option(
      '--map <name=path>',
      'existing workspace on this host; repeat for multiple workspaces',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--max-gib <size>', 'maximum uncompressed snapshot size', size, 20)
    .action(async (path, options) => {
      const mappings: Record<string, string> = {};
      for (const item of options.map) {
        const index = item.indexOf('=');
        if (index < 1 || !item.slice(index + 1))
          throw new Error('Use --map Work=/absolute/repository');
        mappings[item.slice(0, index)] = item.slice(index + 1);
      }
      print(
        await restoreBackup(
          resolve(path),
          resolve(options.to),
          mappings,
          options.maxGib,
          loadConfig().resources.minDiskGiB,
        ),
      );
    });
}
