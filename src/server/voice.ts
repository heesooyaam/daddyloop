import type { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, type ResourceStatus } from '../core/types.js';
import type { Speech } from '../runtime/speech.js';
import type { Locale } from '../i18n/index.js';
import { validateVoiceWav, maxVoiceSamples } from '../runtime/voice-wav.js';

export function registerVoice(
  app: FastifyInstance,
  dataDir: string,
  speech: Speech,
  locale: () => Locale,
  resources: () => ResourceStatus,
) {
  let active: AbortController | undefined;
  app.addContentTypeParser(
    'audio/wav',
    { parseAs: 'buffer', bodyLimit: 44 + maxVoiceSamples * 2 },
    (_req, body, done) => done(null, body),
  );
  app.addHook('preClose', async () => active?.abort());
  app.post<{ Body: Buffer }>(
    '/api/voice/transcribe',
    { bodyLimit: 44 + maxVoiceSamples * 2 },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body))
        throw new AppError('invalid_recording', 'Send an audio/wav recording.', 415);
      validateVoiceWav(request.body);
      const status = resources();
      if (!status.ok || status.memoryAvailableGiB < 3.5)
        throw new AppError('voice_resources', 'Waiting for server resources', 503);
      if (active)
        throw new AppError('voice_busy', 'Voice recognition is busy. Try again shortly.', 429);
      const controller = new AbortController();
      active = controller;
      const disconnect = () => controller.abort();
      reply.raw.once('close', disconnect);
      let tmp: string | undefined;
      try {
        const root = join(dataDir, 'voice');
        await mkdir(root, { recursive: true, mode: 0o700 });
        tmp = await mkdtemp(join(root, 'web-'));
        const path = join(tmp, 'recording.wav');
        await writeFile(path, request.body, { mode: 0o600, flag: 'wx' });
        const text = await speech.transcribe(path, locale(), controller.signal);
        return { text };
      } finally {
        reply.raw.off('close', disconnect);
        active = undefined;
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    },
  );
}
