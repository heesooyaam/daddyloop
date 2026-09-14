import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { command } from './process.js';

import type { AgentPackage } from '../modules/contracts.js';

// Extract each member to stdout, then to a file we create ourselves. Archive links,
// permissions and paths can never make tar write outside the private staging folder.
async function extract(
  archive: string,
  member: string,
  target: string,
  signal: AbortSignal,
  account: (bytes: number) => void,
) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const child = spawn('tar', ['-xzOf', archive, '--', member], {
    stdio: ['ignore', 'pipe', 'ignore'],
    signal,
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Agent CLI archive extraction failed')),
    );
  });
  try {
    await Promise.all([
      closed,
      pipeline(
        child.stdout,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            try {
              account(chunk.length);
              callback(null, chunk);
            } catch (error) {
              callback(error as Error);
            }
          },
        }),
        createWriteStream(target, { flags: 'wx', mode: 0o700 }),
        { signal },
      ),
    ]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed.catch(() => {});
  }
}
export async function installAgentPackage(
  pkg: AgentPackage,
  root: string,
  signal: AbortSignal,
  resourceCheck: () => void,
  layout: (members: string[]) => {
    members: { source: string; target: string }[];
    executable: string;
  },
  fetcher = fetch,
): Promise<string> {
  resourceCheck();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, '.download-'));
  const limit = AbortSignal.any([signal, AbortSignal.timeout(5 * 60000)]);
  try {
    const archive = join(stage, 'package.tgz'),
      payload = join(stage, 'payload');
    await mkdir(payload, { mode: 0o700 });
    const response = await fetcher(pkg.url, { redirect: 'error', signal: limit });
    if (!response.ok || !response.body)
      throw new Error(`Agent CLI download returned HTTP ${response.status}`);
    const hash = createHash('sha512');
    let bytes = 0,
      lastCheck = 0;
    const account = (count: number) => {
      bytes += count;
      if (bytes > 768 * 1024 * 1024) throw new Error('Agent CLI package exceeds the size limit');
      if (Date.now() - lastCheck > 1000) {
        resourceCheck();
        lastCheck = Date.now();
      }
    };
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            account(chunk.length);
            hash.update(chunk);
            callback(null, chunk);
          } catch (error) {
            callback(error as Error);
          }
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal: limit },
    );
    if (`sha512-${hash.digest('base64')}` !== pkg.integrity)
      throw new Error('Agent CLI package checksum mismatch');
    const listing = await command('tar', ['-tzf', archive], {
      signal: limit,
      timeoutMs: 60000,
      maxBytes: 32000,
    });
    const selected = layout(listing.stdout.trim().split('\n'));
    if (
      !selected.members.length ||
      selected.members.length > 40 ||
      new Set(selected.members.map((m) => m.source)).size !== selected.members.length ||
      new Set(selected.members.map((m) => m.target)).size !== selected.members.length ||
      !selected.members.some((m) => m.target === selected.executable)
    )
      throw new Error('Unsupported agent CLI archive layout');
    for (const member of selected.members) {
      if (
        [member.source, member.target].some(
          (name) =>
            !/^[A-Za-z0-9_.\/-]{1,240}$/.test(name) ||
            name.split('/').some((part) => !part || part === '.' || part === '..'),
        )
      )
        throw new Error('Unsafe agent CLI archive path');
      await extract(archive, member.source, join(payload, member.target), limit, account);
    }
    resourceCheck();
    limit.throwIfAborted();
    // Unique immutable directories: never overwrite a binary used by an existing turn.
    const destination = join(root, `${pkg.version}-${stage.split('.download-').at(-1)}`);
    await rename(payload, destination);
    return join(destination, selected.executable);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
