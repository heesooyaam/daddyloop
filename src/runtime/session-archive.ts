import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  symlink,
} from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { safePath, diskBudget } from '../ops/backup/archive.js';
import type { WorkspaceBackupSink } from '../modules/contracts.js';
import { z } from 'zod';

const manifestSchema = z.object({
  format: z.literal(1),
  sessionId: z.string(),
  fingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  files: z
    .array(
      z.object({
        path: safePath,
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        link: z.string().optional(),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .max(200000),
});
const fileDigest = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

export async function verifySessionArchive(
  root: string,
  sessionId: string,
  expectedDigest?: string,
) {
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error('The session archive was redirected');
  const ownership = join(root, 'ownership.json');
  const stat = await lstat(ownership);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('The session archive manifest was replaced');
  const digest = await fileDigest(ownership);
  if (expectedDigest && digest !== expectedDigest)
    throw new Error('The session archive manifest changed; copies were preserved');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(ownership, 'utf8')));
  if (manifest.sessionId !== sessionId) throw new Error('The archive belongs to another session');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('Duplicate session archive file');
    seen.add(file.path);
    const path = join(root, file.path);
    const parent = await realpath(dirname(path));
    if (parent !== canonical && !parent.startsWith(canonical + '/'))
      throw new Error('An archive path escaped its directory');
    const stat = await lstat(path);
    if (file.link !== undefined) {
      if (!stat.isSymbolicLink() || (await readlink(path)) !== file.link)
        throw new Error('A session archive link changed; copies were preserved');
    } else if (
      !file.sha256 ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== file.bytes ||
      (await fileDigest(path)) !== file.sha256
    ) {
      throw new Error('A session archive file changed; copies were preserved');
    }
  }
  return { digest, manifest };
}

/** A readable, bounded export. Symlinks are preserved without reading their targets. */
export class SessionArchive implements WorkspaceBackupSink {
  readonly warnings: string[] = [];
  readonly files: { path: string; sha256?: string; link?: string; bytes: number }[] = [];
  private bytes = 0;
  private paths = new Set<string>();
  private directories = new Set<string>();
  constructor(
    readonly root: string,
    private reserveGiB: number,
    private maxBytes = 2 * 1024 ** 3,
  ) {}
  private async target(path: string, size: number) {
    safePath.parse(path);
    if (this.paths.has(path)) throw new Error('Repeated session archive path');
    this.paths.add(path);
    this.bytes += size;
    if (this.bytes > this.maxBytes)
      throw new Error(
        'Session changes exceed the 2 GiB automatic archive limit; working copies were preserved',
      );
    await diskBudget(this.root, size, this.reserveGiB);
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    for (
      let directory = dirname(target);
      directory === this.root || directory.startsWith(this.root + '/');
      directory = dirname(directory)
    )
      this.directories.add(directory);
    return target;
  }
  async sync() {
    for (const path of [...this.directories, this.root].sort((a, b) => b.length - a.length)) {
      const directory = await open(path, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  async text(path: string, content: string) {
    const bytes = Buffer.byteLength(content);
    const target = await this.target(path, bytes);
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.files.push({ path, sha256: createHash('sha256').update(content).digest('hex'), bytes });
  }
  async file(path: string, source: string) {
    const before = await lstat(source);
    const target = await this.target(path, before.isSymbolicLink() ? 0 : before.size);
    if (before.isSymbolicLink()) {
      const link = await readlink(source);
      const resolved = posix.normalize(posix.join(posix.dirname(path), link));
      if (
        posix.isAbsolute(link) ||
        link.includes('\\') ||
        resolved === '..' ||
        resolved.startsWith('../')
      )
        throw new Error(
          'A session symlink points outside its archive; working copies were preserved',
        );
      await symlink(link, target);
      this.files.push({ path, link, bytes: 0 });
      return;
    }
    if (!before.isFile()) throw new Error('Only regular session files can be archived');
    await copyFile(source, target, 1);
    const after = await lstat(source);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('A session file changed during export; deletion was stopped');
    const handle = await open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    this.files.push({ path, sha256: hash.digest('hex'), bytes: before.size });
  }
  warning(message: string) {
    this.warnings.push(message);
  }
}
