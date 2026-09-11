import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { AppError } from '../core/types.js';
import { credential } from '../core/security.js';
import { skillSnapshotSchema, type SkillSnapshot } from '../core/instructions.js';

export const instructionSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('text'), name: z.string().max(100), text: z.string().max(65536) })
    .strict(),
  z
    .object({ kind: z.literal('file'), name: z.string().max(100), text: z.string().max(65536) })
    .strict(),
  z.object({ kind: z.literal('local'), path: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal('github'), url: z.string().min(1).max(2048) }).strict(),
]);
export type InstructionSource = z.infer<typeof instructionSourceSchema>;
const limit = 65536;
export const instructionPath = (path: string) =>
  resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export async function readInstructionText(path: string, maxBytes = limit): Promise<string> {
  const target = await realpath(instructionPath(path));
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new AppError(
        'invalid_skill',
        'The instruction file is too large or is not a regular file',
        422,
      );
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes)
      throw new AppError('skill_too_large', 'The instruction file is too large', 422);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw new AppError('invalid_skill', 'Choose a UTF-8 Markdown or text file', 422);
    }
  } finally {
    await file.close();
  }
}
function snapshot(text: string, name: string, source: SkillSnapshot['source']): SkillSnapshot {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const declared = front?.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1];
  return skillSnapshotSchema.parse({
    name: (declared ?? name).trim(),
    text,
    checksum: createHash('sha256').update(text).digest('hex'),
    source,
  });
}
function decode(bytes: Uint8Array) {
  if (bytes.byteLength > limit)
    throw new AppError('skill_too_large', 'A skill must fit in 64 KiB', 422);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('invalid_skill', 'Choose a UTF-8 Markdown or text file', 422);
  }
}
async function local(path: string): Promise<SkillSnapshot> {
  path = instructionPath(path);
  if ((await stat(path)).isDirectory()) path = join(path, 'SKILL.md');
  path = await realpath(path);
  if (!/\.(?:md|txt)$/i.test(path))
    throw new AppError(
      'invalid_skill',
      'Choose a Markdown file or a folder containing SKILL.md',
      422,
    );
  return snapshot(await readInstructionText(path), basename(path, '.md'), {
    kind: 'local',
    location: path,
  });
}

/** Fetch only GitHub API data, pin the selected revision, and never execute repository installers. */
export class InstructionSources {
  constructor(
    private fetcher: typeof fetch = fetch,
    private token: () => string = () => {
      try {
        return credential('github', 'github.com');
      } catch (error) {
        if (error instanceof AppError && error.code === 'credentials_missing') return '';
        throw error;
      }
    },
  ) {}
  async import(source: InstructionSource, signal?: AbortSignal): Promise<SkillSnapshot> {
    source = instructionSourceSchema.parse(source);
    signal?.throwIfAborted();
    if (source.kind === 'text' || source.kind === 'file')
      return snapshot(source.text, source.name, {
        kind: source.kind,
        ...(source.kind === 'file' ? { location: source.name } : {}),
      });
    if (source.kind === 'local') return local(source.path);
    return this.github(source.url, signal);
  }
  private async request(path: string, signal?: AbortSignal): Promise<any> {
    const token = this.token();
    const response = await this.fetcher('https://api.github.com' + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'daddyloop',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144)
            throw new AppError(
              'skill_too_large',
              'The GitHub response is too large for a skill',
              422,
            );
          chunks.push(value);
        }
    } finally {
      await reader?.cancel();
    }
    if (!response.ok)
      throw new AppError(
        'skill_source_' + response.status,
        'GitHub could not read this skill (HTTP ' + response.status + ')',
        response.status === 404 ? 404 : 502,
      );
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError('invalid_skill', 'GitHub returned an invalid skill response', 502);
    }
  }
  private async github(value: string, signal?: AbortSignal) {
    let url: URL;
    try {
      url = new URL(value.includes('://') ? value : 'https://github.com/' + value);
    } catch {
      throw new AppError(
        'invalid_skill_url',
        'Enter a GitHub repository, folder or Markdown file URL',
        422,
      );
    }
    if (
      url.protocol !== 'https:' ||
      !['github.com', 'raw.githubusercontent.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      throw new AppError('invalid_skill_url', 'Use an HTTPS GitHub URL', 422);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.some((part) => /[\\\0]/.test(part) || part === '..' || part === '.'))
      throw new AppError('invalid_skill_url', 'Invalid skill path', 422);
    const [owner, repository, marker] = parts;
    if (!owner || !repository || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository))
      throw new AppError('invalid_skill_url', 'Enter a GitHub owner and repository', 422);
    const repoName = repository.replace(/\.git$/, '');
    const repo = owner + '/' + repoName;
    let ref = url.searchParams.get('ref') ?? '',
      path = '';
    if (url.hostname === 'raw.githubusercontent.com') {
      const index = parts[2] === 'refs' && ['heads', 'tags'].includes(parts[3]) ? 4 : 2;
      ref ||= parts[index] ?? '';
      path = parts.slice(index + 1).join('/');
    } else if (marker === 'tree' || marker === 'blob') {
      ref ||= parts[3] ?? '';
      path = parts.slice(4).join('/');
    } else if (parts.length > 2)
      throw new AppError('invalid_skill_url', 'Use a GitHub repository, tree or blob URL', 422);
    if (!ref) ref = (await this.request('/repos/' + repo, signal)).default_branch;
    if (typeof ref !== 'string' || !ref || ref.length > 256)
      throw new AppError('invalid_skill_url', 'GitHub did not report a valid branch', 422);
    let revision = ref;
    if (!/^[a-f0-9]{40}$/i.test(revision)) {
      let object;
      try {
        object = (
          await this.request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`, signal)
        ).object;
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
        object = (
          await this.request(`/repos/${repo}/git/ref/tags/${encodeURIComponent(ref)}`, signal)
        ).object;
      }
      for (let depth = 0; object?.type === 'tag' && depth < 4; depth++)
        object = (await this.request(`/repos/${repo}/git/tags/${object.sha}`, signal)).object;
      if (object?.type !== 'commit')
        throw new AppError('invalid_skill_url', 'Choose a Git commit, branch or tag', 422);
      revision = object.sha;
    }
    if (!/^[a-f0-9]{40}$/i.test(revision))
      throw new AppError('invalid_skill_url', 'GitHub returned an invalid revision', 502);
    const candidates = path
      ? [/\.(md|txt)$/i.test(path) ? path : path + '/SKILL.md']
      : [
          'SKILL.md',
          `skills/${repoName.toLowerCase()}/SKILL.md`,
          `plugins/${repoName.toLowerCase()}/skills/${repoName.toLowerCase()}/SKILL.md`,
        ];
    for (const candidate of candidates) {
      try {
        const file = await this.request(
          `/repos/${repo}/contents/${candidate.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`,
          signal,
        );
        if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string')
          throw new AppError('invalid_skill', 'Choose a readable Markdown skill file', 422);
        return snapshot(decode(Buffer.from(file.content, 'base64')), repoName, {
          kind: 'github',
          revision: revision.toLowerCase(),
          location: `https://github.com/${repo}/blob/${revision}/${candidate}`,
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
      }
    }
    throw new AppError(
      'skill_not_found',
      'SKILL.md was not found. Paste the GitHub URL of the specific skill folder or file.',
      404,
    );
  }
}
