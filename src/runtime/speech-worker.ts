/** Runs in a disposable child process; audio is never passed to an external ASR service. */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { OggOpusDecoder } from 'ogg-opus-decoder';
const [file, model, language] = process.argv.slice(2);
try {
  const bytes = readFileSync(file);
  if (bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 4).toString() !== 'OggS')
    throw new Error('Unsupported voice recording');
  let header = bytes.indexOf('OpusHead');
  if (header < 0) throw new Error('Unsupported voice recording');
  while (header >= 0) {
    if (![1, 2].includes(bytes[header + 9])) throw new Error('Invalid voice recording');
    header = bytes.indexOf('OpusHead', header + 8);
  }
  // The package supports sampleRate but its declaration omits this option.
  const decoderOptions = { sampleRate: 16000, forceStereo: false };
  const decoder = new OggOpusDecoder(decoderOptions);
  await decoder.ready;
  // Decode incrementally to bound memory even if Telegram metadata is incorrect.
  const chunks: Float32Array[] = [];
  let samples = 0,
    energy = 0;
  const append = (pcm: Awaited<ReturnType<OggOpusDecoder['decode']>>) => {
    if (pcm.errors.length || pcm.channelData.length > 2) throw new Error('Invalid voice recording');
    if (!pcm.samplesDecoded) return;
    if (Number(pcm.sampleRate) !== 16000) throw new Error('Unexpected voice sample rate');
    const mono = pcm.channelData[0];
    samples += mono.length;
    if (samples > 16000 * 300) throw new Error('Voice messages can be at most 5 minutes long');
    for (let i = 0; i < mono.length; i++) {
      if (pcm.channelData.length === 2) mono[i] = (mono[i] + pcm.channelData[1][i]) / 2;
      energy += mono[i] * mono[i];
    }
    chunks.push(mono);
  };
  try {
    for (let at = 0; at < bytes.length; at += 4096) {
      append(await decoder.decode(bytes.subarray(at, at + 4096)));
    }
    append(await decoder.flush());
  } finally {
    decoder.free();
  }
  if (!samples || Math.sqrt(energy / samples) < 0.0005)
    throw new Error('No audible speech in the recording');
  const audio = new Float32Array(samples);
  let at = 0;
  for (const chunk of chunks) {
    audio.set(chunk, at);
    at += chunk.length;
  }
  env.allowRemoteModels = false;
  env.localModelPath = dirname(model) + '/';
  const transcribe = await pipeline('automatic-speech-recognition', basename(model), {
    dtype: 'q8',
    device: 'cpu',
    session_options: {
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  });
  try {
    const result = await transcribe(audio, {
      language: language === 'en' ? 'english' : 'russian',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (
      Array.isArray(result) ? result.map((item) => item.text).join(' ') : result.text
    ).trim();
    if (!text || text.length > 20000) throw new Error('Could not recognize a clear voice message');
    process.stdout.write(JSON.stringify({ text }) + '\n');
  } finally {
    await transcribe.dispose();
  }
} catch (error) {
  process.stderr.write((error as Error).message + '\n');
  process.exitCode = 1;
}
