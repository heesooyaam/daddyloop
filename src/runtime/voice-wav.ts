import { AppError } from '../core/types.js';
export const maxVoiceSamples = 16000 * 300;

// Browser dictation uses canonical 44-byte PCM WAVE: mono, 16-bit, 16 kHz.
export function validateVoiceWav(bytes: Buffer) {
  if (
    bytes.length < 46 ||
    bytes.length > 44 + maxVoiceSamples * 2 ||
    bytes.length % 2 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16000 ||
    bytes.readUInt32LE(28) !== 32000 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(40) !== bytes.length - 44
  )
    throw new AppError(
      'invalid_recording',
      'Send a mono 16 kHz PCM voice recording of up to five minutes.',
      400,
    );
}
export function decodeVoiceWav(bytes: Buffer) {
  validateVoiceWav(bytes);
  const audio = new Float32Array((bytes.length - 44) / 2);
  let energy = 0;
  for (let i = 0; i < audio.length; i++) {
    audio[i] = bytes.readInt16LE(44 + i * 2) / 32768;
    energy += audio[i] * audio[i];
  }
  if (Math.sqrt(energy / audio.length) < 0.0005)
    throw new Error('No audible speech in the recording');
  return audio;
}
