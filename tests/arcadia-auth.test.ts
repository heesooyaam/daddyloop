import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credential } from '../src/core/security.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { loadConfig, saveConfig } from '../src/ops/config.js';

const originalHome = process.env.HOME;
const originalArcToken = process.env.ARC_TOKEN;
const originalArcOauthToken = process.env.ARC_OAUTH_TOKEN;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalArcToken === undefined) delete process.env.ARC_TOKEN;
  else process.env.ARC_TOKEN = originalArcToken;
  if (originalArcOauthToken === undefined) delete process.env.ARC_OAUTH_TOKEN;
  else process.env.ARC_OAUTH_TOKEN = originalArcOauthToken;
});

describe('Arcadia host authentication', () => {
  it('uses the standard Arc token file without requiring a copied daddyloop credential', () => {
    const home = mkdtempSync(join(tmpdir(), 'daddyloop-arc-auth-'));
    try {
      mkdirSync(join(home, '.arc'));
      writeFileSync(join(home, '.arc/token'), 'fixture-native-arc-token\n', { mode: 0o600 });
      process.env.HOME = home;
      delete process.env.ARC_TOKEN;
      delete process.env.ARC_OAUTH_TOKEN;
      expect(credential('arcadia', 'a.yandex-team.ru')).toBe('fixture-native-arc-token');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports the missing Arcanum CLI before attempting a review request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daddyloop-missing-arcanum-'));
    const original = loadConfig();
    try {
      process.env.ARC_TOKEN = 'fixture-arc-token-for-missing-cli';
      const next = structuredClone(original);
      next.arcadia.arcanumCli = join(directory, 'arcanum-cli');
      saveConfig(next);
      await expect(new ArcBridge().api(['repo', 'list'])).rejects.toMatchObject({
        code: 'arcanum_cli_missing',
        statusCode: 422,
      });
    } finally {
      saveConfig(original);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
