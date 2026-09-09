import { render } from 'ink';
import { TerminalApp } from './app.js';
import { ConsoleModel, type Api } from './model.js';
import { translator, type Locale } from '../i18n/index.js';
export async function runTerminal(
  api: Api,
  options: {
    id?: string;
    role?: 'author' | 'reviewer';
    theme?: 'dark' | 'light';
    locale?: Locale;
  } = {},
) {
  const model = new ConsoleModel(api, options);
  const instance = render(<TerminalApp model={model} themeName={options.theme} />, {
    alternateScreen: true,
    interactive: true,
    exitOnCtrlC: false,
    maxFps: 20,
    patchConsole: false,
  });
  const stop = () => instance.unmount();
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  model.start();
  try {
    await instance.waitUntilExit();
  } finally {
    model.stop();
    instance.cleanup();
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
  process.stdout.write(
    translator(model.snapshot().locale)(
      'Reviewloop console closed. The service and agents continue running.',
    ) + '\n',
  );
}
