import { describe, expect, test } from 'bun:test';
import { pcmToWav } from '../../src/speech/wav.ts';
import type { AudioData } from '../../src/types/index.ts';

describe('pcmToWav', () => {
  test('writes a standard 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes of fake PCM
    const audio: AudioData = { pcm, sampleRate: 48000, channels: 1 };

    const wav = pcmToWav(audio);

    expect(wav.length).toBe(44 + pcm.length);

    // Magic bytes.
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');

    // Sizes.
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size

    // Data.
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  test('round-trips sampleRate and channels into the header', () => {
    const pcm = Buffer.alloc(100);
    const audio: AudioData = { pcm, sampleRate: 44100, channels: 2 };

    const wav = pcmToWav(audio);

    expect(wav.readUInt16LE(22)).toBe(2); // channels
    expect(wav.readUInt32LE(24)).toBe(44100); // sample rate
    const blockAlign = 2 * (16 / 8);
    expect(wav.readUInt16LE(32)).toBe(blockAlign);
    expect(wav.readUInt32LE(28)).toBe(44100 * blockAlign); // byte rate
  });

  test('handles empty PCM data', () => {
    const audio: AudioData = { pcm: Buffer.alloc(0), sampleRate: 16000, channels: 1 };

    const wav = pcmToWav(audio);

    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});
