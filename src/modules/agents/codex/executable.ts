import type { Executable } from '../../../runtime/executable.js';
export const codexExecutable = (value?: Executable): string =>
  (typeof value === 'function' ? value() : value) ?? 'codex';
