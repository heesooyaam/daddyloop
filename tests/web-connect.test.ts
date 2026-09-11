import { it, expect } from 'vitest';
import { tunnelArgs, webConnectionText, webPort } from '../src/ops/web.js';
import { configSchema } from '../src/ops/config.js';
it('prints real user, host and SSH server port, with a separate laptop HTTP port', () => {
  const text = webConnectionText(
    configSchema.parse({ locale: 'ru', port: 5431 }),
    { port: '14317' },
    {
      user: 'alice',
      host: 'dev.example.net',
      connection: '192.0.2.1 45321 192.0.2.2 2222',
    },
  );
  expect(text).toContain('alice@dev.example.net');
  expect(text).toContain('127.0.0.1:14317:127.0.0.1:5431');
  expect(text).toContain('-p 2222');
  expect(text).toContain('http://127.0.0.1:14317');
  expect(text).toContain('daddy web --ssh alice@dev.example.net');
  expect(text).not.toContain('user@server');
});
it('supports SSH aliases and rejects option injection and invalid ports', () => {
  expect(tunnelArgs('work-host', 4317, 4318).at(-1)).toBe('work-host');
  for (const host of ['-oProxyCommand=x', 'x; echo bad', '$(whoami)', 'a\nb'])
    expect(() => tunnelArgs(host, 4317, 4317)).toThrow();
  for (const port of ['0', '-1', '65536', '1.5', 'junk'])
    expect(() => webPort(port, 4317)).toThrow();
});
