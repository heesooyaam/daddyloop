import type { Api } from '../terminal/model.js';
import type { Locale } from '../i18n/index.js';
export async function consoleUI(
  api: Api,
  options: {
    id?: string;
    role?: 'author' | 'reviewer';
    plain?: boolean;
    theme?: 'dark' | 'light';
    locale?: Locale;
  } = {},
) {
  if (
    options.plain ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env.TERM === 'dumb'
  ) {
    const { runDaddyPlain } = await import('./daddy-plain.js');
    return runDaddyPlain(api, options);
  }
  const { runDaddyTerminal } = await import('../terminal/daddy.js');
  return runDaddyTerminal(api, options);
}
