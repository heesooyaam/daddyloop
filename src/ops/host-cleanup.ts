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

const unitProperties = [
  'LoadState',
  'Type',
  'RemainAfterExit',
  'ActiveState',
  'InvocationID',
  'Result',
  'ConditionResult',
  'ConditionTimestampMonotonic',
  'ExecMainStartTimestampMonotonic',
  'ExecMainExitTimestampMonotonic',
  'ExecMainCode',
  'ExecMainStatus',
].join(',');

async function inspectUnit(unit: string, signal: AbortSignal, run: typeof execute) {
  const output = await run(
    systemctl,
    ['show', '--all', '--property=' + unitProperties, unit],
    signal,
  );
  const properties: Record<string, string | undefined> = Object.fromEntries(
    output.split('\n').map((line) => line.split('=', 2)),
  );
  return properties;
}

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
      const before = await inspectUnit(unit, signal, run);
      if (
        before.LoadState !== 'loaded' ||
        before.Type !== 'oneshot' ||
        before.RemainAfterExit !== 'no'
      )
        throw new Error(
          'Expected an installed oneshot cleanup unit with RemainAfterExit=no: ' + unit,
        );
      signal.throwIfAborted();
      if (!shouldContinue()) return { skipped: true, unitResult: 'threshold' };
      await run('/usr/bin/sudo', ['-n', systemctl, 'start', unit], signal);
      const after = await inspectUnit(unit, signal, run);
      const invocation = after.InvocationID ?? '';
      const validInvocation = /^[0-9a-f]{32}$/.test(invocation) && invocation !== '0'.repeat(32);
      const newInvocation = validInvocation && invocation !== before.InvocationID;
      if (
        (after.ConditionResult === 'no' &&
          Number(after.ConditionTimestampMonotonic) > Number(before.ConditionTimestampMonotonic)) ||
        (newInvocation && after.Result === 'exec-condition')
      ) {
        return { skipped: true, unitResult: 'condition' };
      }
      const start = Number(after.ExecMainStartTimestampMonotonic);
      const joined =
        before.ActiveState === 'activating' && before.InvocationID === after.InvocationID;
      // A skipped start can return zero and retain the previous process status. An unloaded
      // oneshot can also show ExecMainStatus=0 without ever having run.
      if (
        !validInvocation ||
        (!joined &&
          (after.InvocationID === before.InvocationID ||
            !(start > Number(before.ExecMainStartTimestampMonotonic)))) ||
        !(start > 0 && Number(after.ExecMainExitTimestampMonotonic) >= start) ||
        after.ActiveState !== 'inactive' ||
        after.ConditionResult !== 'yes' ||
        after.Result !== 'success' ||
        after.ExecMainCode !== '1'
      ) {
        throw new Error('systemd did not retain a confirmed execution result for this cleanup.');
      }
      if (after.ExecMainStatus === '75') return { skipped: true, unitResult: 'busy' };
      if (after.ExecMainStatus !== '0')
        throw new Error('Host cache maintenance exited with status ' + after.ExecMainStatus);
      return { unitResult: 'completed' };
    },
  }));
}
