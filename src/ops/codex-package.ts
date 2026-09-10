import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { command } from './process.js';

const registry = 'https://registry.npmjs.org';
const stableVersion = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
export interface CodexPackage {
  version: string;
  platform: string;
  url: string;
  integrity: string;
}
function platform() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Managed Codex updates require Linux x64 or ARM64');
  return `linux-${process.arch}`;
}
export function validatePackage(value: CodexPackage) {
  if (
    !stableVersion.test(value.version) ||
    value.platform !== platform() ||
    value.url !== `${registry}/@openai/codex/-/codex-${value.version}-${value.platform}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)
  )
    throw new Error('Invalid official Codex package metadata');
}
async function metadata(path: string, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher(`${registry}/@openai%2Fcodex/${path}`, {
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok || !response.body)
    throw new Error(`Codex registry returned HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Codex registry response is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as {
    name?: string;
    version?: string;
    optionalDependencies?: Record<string, string>;
    dist?: { tarball?: string; integrity?: string };
  };
}
export async function latestCodexPackage(
  signal: AbortSignal,
  fetcher = fetch,
): Promise<CodexPackage> {
  const target = platform(),
    main = await metadata('latest', signal, fetcher);
  if (
    main.name !== '@openai/codex' ||
    !main.version ||
    !stableVersion.test(main.version) ||
    main.optionalDependencies?.[`@openai/codex-${target}`] !==
      `npm:@openai/codex@${main.version}-${target}`
  )
    throw new Error('Unsupported Codex package layout');
  const binary = await metadata(`${main.version}-${target}`, signal, fetcher);
  if (binary.name !== '@openai/codex' || binary.version !== `${main.version}-${target}`)
    throw new Error('Codex platform package does not match the requested version');
  const result = {
    version: main.version,
    platform: target,
    url: binary.dist?.tarball ?? '',
    integrity: binary.dist?.integrity ?? '',
  };
  validatePackage(result);
  return result;
}

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
      code === 0 ? resolve() : reject(new Error('Codex archive extraction failed')),
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
export async function installCodexPackage(
  pkg: CodexPackage,
  root: string,
  signal: AbortSignal,
  resourceCheck: () => void,
  fetcher = fetch,
): Promise<string> {
  validatePackage(pkg);
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
      throw new Error(`Codex download returned HTTP ${response.status}`);
    const hash = createHash('sha512');
    let bytes = 0,
      lastCheck = 0;
    const account = (count: number) => {
      bytes += count;
      if (bytes > 768 * 1024 * 1024) throw new Error('Codex package exceeds the size limit');
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
      throw new Error('Codex package checksum mismatch');
    const listing = await command('tar', ['-tzf', archive], {
      signal: limit,
      timeoutMs: 60000,
      maxBytes: 32000,
    });
    const triple =
      process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
    const prefix = `package/vendor/${triple}/`;
    const members = listing.stdout
      .trim()
      .split('\n')
      .filter((name) => name.startsWith(prefix) && !name.endsWith('/'));
    if (!members.length || members.length > 40 || new Set(members).size !== members.length)
      throw new Error('Unsupported Codex archive layout');
    const relative = members.map((member) => member.slice(prefix.length));
    if (
      relative.some(
        (name) =>
          !/^[A-Za-z0-9_.\/-]{1,240}$/.test(name) ||
          name.split('/').some((part) => !part || part === '.' || part === '..'),
      )
    )
      throw new Error('Unsafe Codex archive path');
    const executable = ['bin/codex', 'codex/codex'].find((name) => relative.includes(name));
    if (!executable) throw new Error('Codex archive contains no supported executable');
    for (let i = 0; i < members.length; i++)
      await extract(archive, members[i], join(payload, relative[i]), limit, account);
    resourceCheck();
    limit.throwIfAborted();
    // Unique immutable directories: never overwrite a binary used by an existing turn.
    const destination = join(root, `${pkg.version}-${stage.split('.download-').at(-1)}`);
    await rename(payload, destination);
    return join(destination, executable);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
