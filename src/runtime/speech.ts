import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/types.js';
import type { Locale } from '../i18n/index.js';
import { bundledRoot } from './executable.js';
import { redact } from '../core/security.js';
export interface Speech {
  transcribe(path: string, locale: Locale, signal: AbortSignal): Promise<string>;
}
export class LocalSpeech implements Speech {
  constructor(private dataDir: string) {}
  transcribe(path: string, locale: Locale, signal: AbortSignal): Promise<string> {
    const bundle = bundledRoot();
    const model = bundle
      ? join(bundle, 'app/speech/whisper-small')
      : join(this.dataDir, 'speech/whisper-small');
    if (!existsSync(join(model, 'config.json')))
      return Promise.reject(
        new AppError(
          'speech_model_missing',
          'Install the release with voice support, or run npm run speech:prepare for a source checkout.',
          422,
        ),
      );
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--max-old-space-size=384',
          fileURLToPath(new URL('./speech-worker.js', import.meta.url)),
          path,
          model,
          locale,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8', OMP_NUM_THREADS: '2' },
        },
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let output = '',
        diagnostic = '',
        stopped = false;
      const abort = () => {
        stopped = true;
        child.kill('SIGKILL');
      };
      const timeout = setTimeout(abort, 180000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (bytes) => {
        output += bytes.toString();
        if (output.length > 100000) abort();
      });
      child.stderr.on('data', (bytes) => {
        diagnostic = (diagnostic + bytes.toString()).slice(-3000);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (stopped || signal.aborted)
          return reject(
            new AppError(
              'speech_interrupted',
              signal.aborted
                ? 'Voice recognition was interrupted; the recording is preserved.'
                : 'Voice recognition timed out. Send a shorter recording.',
            ),
          );
        if (code !== 0)
          return reject(
            new AppError('speech_failed', redact(diagnostic.trim()) || 'Voice recognition failed'),
          );
        try {
          const result = JSON.parse(output);
          if (typeof result.text !== 'string' || !result.text.trim())
            throw new Error('No speech recognized');
          resolve(result.text);
        } catch {
          reject(new AppError('speech_failed', 'Could not recognize a clear voice message'));
        }
      });
    });
  }
}
