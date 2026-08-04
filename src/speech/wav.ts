import type { AudioData } from '../types/index.ts';

const WAV_HEADER_SIZE = 44;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;

/**
 * Wraps raw signed 16-bit little-endian PCM samples in a standard 44-byte RIFF/WAVE header.
 */
export function pcmToWav(audio: AudioData): Buffer {
  const { pcm, sampleRate, channels } = audio;
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  const header = Buffer.alloc(WAV_HEADER_SIZE);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
