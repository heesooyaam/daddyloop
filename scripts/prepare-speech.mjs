import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const manifest = JSON.parse(
  await readFile(new URL('./speech-model.json', import.meta.url), 'utf8'),
);
export async function prepareSpeech(directory) {
  for (const file of manifest.files) {
    const target = join(directory, file.name),
      hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    try {
      if (hash(await readFile(target)) === file.sha256) continue;
    } catch {
      /* Not cached. */
    }
    await mkdir(dirname(target), { recursive: true });
    const response = await fetch(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.name}`,
      { signal: AbortSignal.timeout(180000) },
    );
    if (!response.ok)
      throw new Error(`Speech model download failed: ${file.name} (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > file.size) throw new Error('Speech model exceeded its pinned size');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== file.size || hash(bytes) !== file.sha256)
      throw new Error('Speech model checksum mismatch');
    const temporary = target + `.download-${process.pid}`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await writeFile(join(directory, 'daddyloop-model.json'), JSON.stringify(manifest, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareSpeech(resolve(process.argv[2] ?? '.daddyloop/speech/whisper-small'));
