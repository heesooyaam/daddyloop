import { it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  installCodexPackage,
  latestCodexPackage,
  type CodexPackage,
} from '../src/ops/codex-package.js';
function archive(unsafe = false) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-codex-package-test-'));
  const triple =
    process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
  const prefix = `package/vendor/${triple}`;
  mkdirSync(join(dir, prefix, 'bin'), { recursive: true });
  writeFileSync(join(dir, prefix, 'bin/codex'), '#!/bin/sh\necho codex-cli 2.0.0\n');
  writeFileSync(
    join(dir, prefix, 'codex-package.json'),
    JSON.stringify({ entrypoint: 'bin/codex' }),
  );
  execFileSync('tar', [
    '-czf',
    join(dir, 'package.tgz'),
    ...(unsafe ? ['--transform=s,bin/codex,../escape,'] : []),
    '-C',
    dir,
    'package',
  ]);
  const bytes = readFileSync(join(dir, 'package.tgz'));
  const pkg: CodexPackage = {
    version: '2.0.0',
    platform: `linux-${process.arch}`,
    url: `https://registry.npmjs.org/@openai/codex/-/codex-2.0.0-linux-${process.arch}.tgz`,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
  return { dir, bytes, pkg, close: () => rmSync(dir, { recursive: true, force: true }) };
}
it('installs verified bytes into immutable directories and removes compressed downloads', async () => {
  const f = archive();
  try {
    const root = join(f.dir, 'managed'),
      resourceCheck = vi.fn();
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(f.bytes));
    const first = await installCodexPackage(
      f.pkg,
      root,
      new AbortController().signal,
      resourceCheck,
      fetcher,
    );
    const second = await installCodexPackage(
      f.pkg,
      root,
      new AbortController().signal,
      resourceCheck,
      fetcher,
    );
    expect(first).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toContain('codex-cli 2.0.0');
    expect(readdirSync(root).filter((entry) => entry.startsWith('.download-'))).toEqual([]);
    expect(resourceCheck.mock.calls.length).toBeGreaterThan(1);
    expect(fetcher.mock.calls[0][0]).toBe(f.pkg.url);
  } finally {
    f.close();
  }
});
it.each(['checksum', 'path', 'url', 'disk'])(
  'rejects %s hazards without modifying another installation',
  async (failure) => {
    const f = archive(failure === 'path');
    try {
      const root = join(f.dir, 'managed');
      mkdirSync(root);
      writeFileSync(join(root, 'existing'), 'preserved');
      const pkg = { ...f.pkg };
      if (failure === 'checksum') pkg.integrity = 'sha512-' + 'A'.repeat(86) + '==';
      if (failure === 'url') pkg.url = 'https://attacker.example/code.tgz';
      await expect(
        installCodexPackage(
          pkg,
          root,
          new AbortController().signal,
          () => {
            if (failure === 'disk') throw new Error('low disk');
          },
          async () => new Response(f.bytes),
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(root, 'existing'), 'utf8')).toBe('preserved');
      expect(readdirSync(root)).toEqual(['existing']);
      expect(existsSync(join(f.dir, 'escape'))).toBe(false);
    } finally {
      f.close();
    }
  },
);
it('pins latest to its matching official platform package and rejects changed dependency layouts', async () => {
  const f = archive();
  try {
    let malicious = false;
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/latest')
              ? {
                  name: '@openai/codex',
                  version: '2.0.0',
                  optionalDependencies: {
                    [`@openai/codex-linux-${process.arch}`]: malicious
                      ? 'npm:other@2.0.0'
                      : `npm:@openai/codex@2.0.0-linux-${process.arch}`,
                  },
                }
              : {
                  name: '@openai/codex',
                  version: `2.0.0-linux-${process.arch}`,
                  dist: { tarball: f.pkg.url, integrity: f.pkg.integrity },
                },
          ),
        ),
    );
    expect(await latestCodexPackage(new AbortController().signal, fetcher)).toEqual(f.pkg);
    malicious = true;
    await expect(latestCodexPackage(new AbortController().signal, fetcher)).rejects.toThrow(
      'layout',
    );
  } finally {
    f.close();
  }
});
