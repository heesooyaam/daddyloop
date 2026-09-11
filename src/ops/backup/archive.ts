import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { z } from 'zod';
import { VERSION } from '../../version.js';

export const safePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const manifestSchema = z
  .object({
    format: z.literal(1),
    appVersion: z.string(),
    createdAt: z.string(),
    sourceDataDir: z.string(),
    nativeContexts: z.literal('restart-from-saved-work'),
    config: z.record(z.string(), z.unknown()),
    sources: z.array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{20}$/),
        path: z.string().startsWith('/'),
        vcs: z.enum(['git', 'arcadia']),
        bundle: safePath.optional(),
        head: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
        branch: z.string().optional(),
        names: z.array(z.string()),
        remotes: z
          .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/), url: z.string().min(1) }))
          .optional(),
        warning: z.string().optional(),
      }),
    ),
    warnings: z.array(z.string()),
    files: z
      .array(
        z.object({
          path: safePath,
          blob: hash.optional(),
          size: z.number().int().nonnegative(),
          mode: z.number().int(),
          link: z.string().optional(),
        }),
      )
      .max(200000),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
export const digest = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
export async function diskBudget(path: string, bytes: number, reserveGiB: number) {
  const fs = await statfs(path);
  if (fs.bavail * fs.bsize - bytes < reserveGiB * 1024 ** 3)
    throw new Error(
      `Backup needs ${Math.ceil(bytes / 1024 ** 3)} GiB plus ${reserveGiB} GiB free reserve`,
    );
}
export class ArchiveBuilder {
  readonly manifest: BackupManifest;
  private bytes = 0;
  private paths = new Set<string>();
  constructor(
    readonly stage: string,
    sourceDataDir: string,
    private maxBytes: number,
    private reserveGiB: number,
  ) {
    this.manifest = {
      format: 1,
      appVersion: VERSION,
      createdAt: new Date().toISOString(),
      sourceDataDir,
      nativeContexts: 'restart-from-saved-work',
      config: {},
      sources: [],
      files: [],
      warnings: [],
    };
  }
  get remainingBytes() {
    return this.maxBytes - this.bytes;
  }
  async add(source: string, path: string) {
    safePath.parse(path);
    if (this.paths.has(path)) throw new Error(`Duplicate backup path: ${path}`);
    this.paths.add(path);
    const before = await lstat(source);
    if (before.isSymbolicLink()) {
      const link = await readlink(source);
      const target = posix.normalize(posix.join(posix.dirname(path), link));
      if (
        link.startsWith('/') ||
        link.includes('\\') ||
        target.startsWith('../') ||
        target === '..'
      )
        throw new Error(
          `Non-portable symlink: ${source}. Keep its target in the workspace before backing up.`,
        );
      this.manifest.files.push({ path, link, size: 0, mode: 0o777 });
      return;
    }
    if (!before.isFile()) throw new Error(`Backup only accepts regular files: ${source}`);
    this.bytes += before.size;
    if (this.bytes > this.maxBytes)
      throw new Error('Backup exceeds --max-gib; raise the limit after checking free disk space');
    if (this.manifest.files.length >= 200000) throw new Error('Backup exceeds 200000 files');
    await diskBudget(this.stage, before.size, this.reserveGiB);
    const temporary = join(this.stage, 'blobs', randomUUID());
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    await copyFile(source, temporary);
    const after = await lstat(source);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino
    )
      throw new Error(`File changed during backup: ${source}. Retry when the workspace is idle.`);
    const blob = await digest(temporary);
    await rename(temporary, join(this.stage, 'blobs', blob));
    this.manifest.files.push({ path, blob, size: before.size, mode: before.mode & 0o777 });
  }
  async finish(output: string) {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await diskBudget(dirname(output), this.bytes, this.reserveGiB);
    await writeFile(join(this.stage, 'manifest.json'), JSON.stringify(this.manifest), {
      mode: 0o600,
    });
    const temporary = output + '.' + randomUUID() + '.partial';
    try {
      const dest = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      await pipeline(
        tar.c({ cwd: this.stage, gzip: true, portable: true }, ['manifest.json', 'blobs']),
        dest,
      );
      // No overwrite, even if another backup finished while this one was streaming.
      const { link } = await import('node:fs/promises');
      await link(temporary, output);
      return {
        path: output,
        sha256: await digest(output),
        bytes: (await stat(output)).size,
        files: this.manifest.files.length,
        warnings: this.manifest.warnings,
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Extract only opaque regular blobs. Workspace links are recreated after validation. */
export async function readArchive(file: string, maxBytes: number, reserveGiB: number) {
  const stage = await mkdtemp(join(tmpdir(), 'daddyloop-restore-'));
  await chmod(stage, 0o700);
  const seen = new Set<string>();
  let total = 0;
  const unpack = tar.x({
    cwd: stage,
    strict: true,
    preserveOwner: false,
    noChmod: true,
    filter(path, entry) {
      const allowed =
        (path === 'blobs/' && ('type' in entry ? entry.type : '') === 'Directory') ||
        ((path === 'manifest.json' || /^blobs\/[a-f0-9]{64}$/.test(path)) &&
          ('type' in entry ? entry.type : '') === 'File');
      if (!allowed || seen.has(path)) {
        unpack.abort(new Error('Unsafe or duplicate archive entry: ' + path));
        return false;
      }
      seen.add(path);
      if (seen.size > 200002 || (path === 'manifest.json' && entry.size > 32 * 1024 ** 2)) {
        unpack.abort(new Error('Archive manifest exceeds limits'));
        return false;
      }
      return true;
    },
  });
  try {
    await diskBudget(stage, maxBytes, reserveGiB);
    await pipeline(
      createReadStream(file),
      createGunzip(),
      new Transform({
        transform(chunk, _encoding, callback) {
          total += chunk.length;
          callback(
            total > maxBytes + 64 * 1024 ** 2 ? new Error('Archive exceeds --max-gib') : null,
            chunk,
          );
        },
      }),
      unpack,
    );
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8')),
    );
    if (manifest.files.reduce((sum, file) => sum + file.size, 0) > maxBytes)
      throw new Error('Snapshot files exceed --max-gib');
    const sourceIds = new Set(manifest.sources.map((source) => source.id));
    if (sourceIds.size !== manifest.sources.length) throw new Error('Duplicate backup source');
    for (const source of manifest.sources)
      if (source.bundle && (source.bundle !== `source-bundles/${source.id}.bundle` || !source.head))
        throw new Error('Invalid source bundle');
    const paths = new Set<string>();
    const blobs = new Set<string>();
    for (const entry of manifest.files) {
      const sourceFile = entry.path.match(
        /^source-(?:files|index|sharedindex|bundles)\/([a-f0-9]{20})(?:\.bundle$|\/|$)/,
      );
      if (
        !/^data\/(?:daddyloop\.sqlite$|workspaces\/|artifacts\/|voice\/)/.test(entry.path) &&
        !/^recovery\/arcadia\//.test(entry.path) &&
        !(sourceFile && sourceIds.has(sourceFile[1]))
      )
        throw new Error('Unexpected snapshot payload path: ' + entry.path);
      if (paths.has(entry.path) || !!entry.blob === (entry.link != null))
        throw new Error('Invalid backup file manifest');
      paths.add(entry.path);
      if (entry.blob) {
        const source = join(stage, 'blobs', entry.blob);
        if ((await stat(source)).size !== entry.size) throw new Error('Backup file size mismatch');
        if (!blobs.has(entry.blob) && (await digest(source)) !== entry.blob)
          throw new Error('Backup checksum mismatch');
        blobs.add(entry.blob);
      } else {
        const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.link!));
        if (
          entry.link!.startsWith('/') ||
          entry.link!.includes('\\') ||
          target === '..' ||
          target.startsWith('../')
        )
          throw new Error('Unsafe backup symlink');
      }
    }
    for (const path of paths)
      for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent))
        if (paths.has(parent)) throw new Error('Backup file is used as a parent directory');
    return { stage, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
