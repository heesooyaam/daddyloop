import { accessSync, constants, realpathSync, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
export type Executable = string | (() => string | undefined) | undefined;
export const selectedExecutable = (value: Executable): string =>
  (typeof value === 'function' ? value() : value) ?? 'codex';
export function executablePath(command: string): string | undefined {
  for (const candidate of command.includes('/')
    ? [resolve(command)]
    : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, command))) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
}
export function bundledRoot() {
  const root = resolve(dirname(process.execPath), '../..');
  return existsSync(join(root, 'release.json')) ? root : undefined;
}
export function requireExecutable(value: string) {
  if (!isAbsolute(value)) throw new Error('Use an absolute executable path on the service host');
  const path = executablePath(value);
  if (!path) throw new Error('The executable does not exist or is not executable');
  // Keep the launcher path: native CLI updaters may replace its symlink target.
  return resolve(value);
}
export const versionNumber = (text: string) =>
  text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] } : undefined;
  };
  const left = parse(candidate),
    right = parse(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++)
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i];
  return !left.prerelease && !!right.prerelease;
}
