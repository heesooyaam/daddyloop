import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import manifest from './speech-model.json' with { type: 'json' };

export async function prepareSpeech(directory: string) {
  for (const file of manifest.files) {
    const target = join(directory, file.name);
    const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (existing?.size === file.size) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      if (hash.digest('hex') === file.sha256) continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const response = await fetch(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.name}`,
      { signal: AbortSignal.timeout(180000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`Speech model download failed: ${file.name} (${response.status})`);
    const temporary = target + '.download-' + randomUUID();
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        Readable.from(response.body),
        async function* (chunks) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > file.size) throw new Error('Speech model exceeded its pinned size');
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      if (size !== file.size || hash.digest('hex') !== file.sha256)
        throw new Error('Speech model checksum mismatch');
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const marker = join(directory, 'daddyloop-model.json'),
    tmp = marker + '.' + randomUUID();
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(tmp, marker);
  } finally {
    await rm(tmp, { force: true });
  }
}
