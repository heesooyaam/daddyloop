import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CleanupAction } from './scheduled-cleanup.js';

const exec = promisify(execFile);
const systemctl = '/usr/bin/systemctl';
const execute = async (file: string, args: string[], signal: AbortSignal) => {
  const result = await exec(file, args, {
    signal,
    cwd: '/',
    maxBuffer: 16384,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  return result.stdout.trim();
};

// Only the host operator can register actions through the service environment.
// The model selects IDs. It never supplies unit names or command arguments.
export function hostCleanupActions(units: string | undefined, run = execute): CleanupAction[] {
  if (!units?.trim()) return [];
  const names = [...new Set(units.trim().split(/[\s,]+/))];
  if (
    names.length > 8 ||
    names.some((name) => !/^daddyloop-cleanup-[a-z0-9][a-z0-9-]{0,48}\.service$/.test(name))
  )
    throw new Error(
      'DADDYLOOP_CLEANUP_UNITS must list up to eight daddyloop-cleanup-<name>.service units',
    );
  return names.map((unit) => ({
    id: unit.slice(0, -'.service'.length),
    description: 'Host-approved native cache maintenance through ' + unit,
    async run(signal, shouldContinue) {
      const info = await run(
        systemctl,
        ['show', '--property=LoadState,Type,RemainAfterExit', unit],
        signal,
      );
      const properties = new Set(info.split('\n'));
      if (
        !properties.has('LoadState=loaded') ||
        !properties.has('Type=oneshot') ||
        !properties.has('RemainAfterExit=no')
      )
        throw new Error(
          'Expected an installed oneshot cleanup unit with RemainAfterExit=no: ' + unit,
        );
      signal.throwIfAborted();
      if (!shouldContinue()) return { skipped: true };
      await run('/usr/bin/sudo', ['-n', systemctl, 'start', unit], signal);
      // An operator can use SuccessExitStatus=75 for a cache locked by another job.
      const status = await run(
        systemctl,
        ['show', '--property=ExecMainStatus', '--value', unit],
        signal,
      );
      if (status === '75') return { skipped: true };
      if (status !== '0') throw new Error('Host cache maintenance exited with status ' + status);
    },
  }));
}
