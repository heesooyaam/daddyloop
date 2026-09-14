import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installClaudePackage, latestClaudePackage } from '../src/modules/agents/claude/package.js';
import { packageMetadata } from '../src/modules/agents/cli.js';
it('resolves only the exact official native Claude package and rejects inconsistent metadata', async () => {
  const platform = `linux-${process.arch}`,
    name = `@anthropic-ai/claude-code-${platform}`;
  const binary = {
    name,
    version: '2.1.270',
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/claude-code-${platform}-2.1.270.tgz`,
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    },
  };
  let wrong = false;
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/latest')
            ? {
                name: '@anthropic-ai/claude-code',
                version: '2.1.270',
                optionalDependencies: { [name]: wrong ? '2.1.269' : '2.1.270' },
              }
            : binary,
        ),
      ),
  );
  const signal = new AbortController().signal;
  expect(await latestClaudePackage(signal, fetcher)).toMatchObject({
    version: '2.1.270',
    platform,
    url: binary.dist.tarball,
  });
  wrong = true;
  await expect(latestClaudePackage(signal, fetcher)).rejects.toThrow('layout');
  await expect(
    packageMetadata(name, 'latest', signal, async () => new Response('x'.repeat(300000))),
  ).rejects.toThrow('too large');
});
it('installs checksum-verified Claude bytes in a private immutable directory and rejects untrusted packages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-claude-package-'));
  try {
    mkdirSync(join(dir, 'package'));
    writeFileSync(join(dir, 'package/claude'), '#!/bin/sh\necho 2.1.270\n');
    execFileSync('tar', ['-czf', join(dir, 'fixture.tgz'), '-C', dir, 'package']);
    const bytes = readFileSync(join(dir, 'fixture.tgz')),
      root = join(dir, 'managed'),
      signal = new AbortController().signal;
    const name = `claude-code-linux-${process.arch}`;
    const pkg = {
      version: '2.1.270',
      platform: `linux-${process.arch}`,
      url: `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-2.1.270.tgz`,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    };
    const fetcher = vi.fn(async () => new Response(bytes));
    const installed = await installClaudePackage(pkg, root, signal, () => {}, fetcher);
    expect(installed.startsWith(root + '/')).toBe(true);
    expect(installed.endsWith('/bin/claude')).toBe(true);
    expect(execFileSync(installed, { encoding: 'utf8' }).trim()).toBe('2.1.270');
    expect(readdirSync(root).some((name) => name.startsWith('.download-'))).toBe(false);
    await expect(
      installClaudePackage(
        { ...pkg, url: 'https://example.test/binary' },
        root,
        signal,
        () => {},
        fetcher,
      ),
    ).rejects.toThrow('metadata');
    await expect(
      installClaudePackage(
        { ...pkg, integrity: 'sha512-' + Buffer.alloc(64).toString('base64') },
        root,
        signal,
        () => {},
        fetcher,
      ),
    ).rejects.toThrow('checksum');
    expect(readFileSync(installed, 'utf8')).toContain('2.1.270');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
