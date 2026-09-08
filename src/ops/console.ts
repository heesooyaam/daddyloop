import type { Api } from '../terminal/model.js';
export async function consoleUI(
  api: Api,
  options: {
    id?: string;
    role?: 'author' | 'reviewer';
    plain?: boolean;
    theme?: 'dark' | 'light';
  } = {},
) {
  if (
    options.plain ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env.TERM === 'dumb'
  ) {
    const { consoleUI: plain } = await import('./console-plain.js');
    return plain(
      api,
      options.id ? { id: options.id, role: options.role ?? 'reviewer' } : undefined,
    );
  }
  const { runTerminal } = await import('../terminal/run.js');
  return runTerminal(api, options);
}
