import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { healthy } from './planning-fixture.js';
import { decodeVoiceWav } from '../src/runtime/voice-wav.js';

it('transcribes authenticated web dictation to a draft, rejects invalid audio and cleans up the recording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-web-'));
  const transcribe = vi.fn(async (path: string) => {
    expect(Array.from(decodeVoiceWav(readFileSync(path)))).toEqual([0.5]);
    return 'Текст для проверки';
  });
  const { app, store } = await buildApp({
    dataDir: dir,
    demo: true,
    startWorker: false,
    startUpdateCheck: false,
    speech: { transcribe },
    resourceCheck: healthy,
  });
  try {
    const wav = Buffer.alloc(46);
    wav.write('RIFF');
    wav.writeUInt32LE(38, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(2, 40);
    wav.writeInt16LE(16384, 44);
    const url = '/api/voice/transcribe',
      headers = { 'content-type': 'audio/wav' };
    const auth = {
      ...headers,
      authorization: 'Bearer ' + readFileSync(join(dir, 'access-token'), 'utf8').trim(),
    };
    expect((await app.inject({ method: 'POST', url, headers, payload: wav })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: auth, payload: Buffer.from('invalid') }))
        .statusCode,
    ).toBe(400);
    const result = await app.inject({ method: 'POST', url, headers: auth, payload: wav });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ text: 'Текст для проверки' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(store.daddyJobs()).toHaveLength(0);
    expect(readdirSync(join(dir, 'voice'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
