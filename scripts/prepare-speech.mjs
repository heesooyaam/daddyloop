import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareSpeech } from '../src/runtime/prepare-speech.ts';
export { prepareSpeech };
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv[2]
    ? resolve(process.argv[2])
    : join((await import('../src/ops/config.ts')).defaultDataDir(), 'speech/whisper-small');
  await prepareSpeech(target);
}
