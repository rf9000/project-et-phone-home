import { describe, expect, test } from 'bun:test';
import {
  DISCORD_CHANNELS,
  DISCORD_SAMPLE_RATE,
  fromDiscordCapture,
  monoToStereo,
  stereoToMono,
  toDiscordPlayable,
} from '../../../src/channels/discord/audio.ts';

/** Builds a PCM buffer from signed 16-bit sample values. */
function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

/** Reads a PCM buffer back into signed 16-bit sample values. */
function samples(buffer: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) out.push(buffer.readInt16LE(i));
  return out;
}

describe('constants', () => {
  test('describe Discord voice transport', () => {
    expect(DISCORD_SAMPLE_RATE).toBe(48000);
    expect(DISCORD_CHANNELS).toBe(2);
  });
});

describe('monoToStereo', () => {
  test('duplicates each sample into the L and R slots', () => {
    expect(samples(monoToStereo(pcm([100, -200])))).toEqual([100, 100, -200, -200]);
  });

  test('doubles the byte length', () => {
    expect(monoToStereo(pcm([1, 2, 3, 4])).length).toBe(16);
  });

  test('preserves the extremes of the 16-bit range', () => {
    expect(samples(monoToStereo(pcm([32767, -32768])))).toEqual([32767, 32767, -32768, -32768]);
  });

  test('returns an empty buffer for empty input', () => {
    expect(monoToStereo(Buffer.alloc(0)).length).toBe(0);
  });

  test('drops a trailing partial sample instead of throwing', () => {
    const odd = Buffer.concat([pcm([7]), Buffer.from([0x01])]);
    expect(samples(monoToStereo(odd))).toEqual([7, 7]);
  });
});

describe('stereoToMono', () => {
  test('averages each L/R pair', () => {
    expect(samples(stereoToMono(pcm([100, 300, -200, -400])))).toEqual([200, -300]);
  });

  test('halves the byte length', () => {
    expect(stereoToMono(pcm([1, 2, 3, 4])).length).toBe(4);
  });

  test('averages odd sums by truncating toward negative infinity', () => {
    expect(samples(stereoToMono(pcm([100, 101])))).toEqual([100]);
    expect(samples(stereoToMono(pcm([-100, -101])))).toEqual([-101]);
    expect(samples(stereoToMono(pcm([0, 1])))).toEqual([0]);
    expect(samples(stereoToMono(pcm([0, -1])))).toEqual([-1]);
  });

  test('does not overflow when both channels are at full scale', () => {
    expect(samples(stereoToMono(pcm([32767, 32767, -32768, -32768])))).toEqual([32767, -32768]);
  });

  test('returns an empty buffer for empty input', () => {
    expect(stereoToMono(Buffer.alloc(0)).length).toBe(0);
  });

  test('drops a trailing partial frame instead of throwing', () => {
    const partial = pcm([10, 20, 30]); // one full frame plus a lone left sample
    expect(samples(stereoToMono(partial))).toEqual([15]);
  });
});

describe('monoToStereo / stereoToMono round trip', () => {
  test('recovers the original mono samples', () => {
    const original = pcm([0, 1, -1, 1234, -4321, 32767, -32768]);
    expect(samples(stereoToMono(monoToStereo(original)))).toEqual(samples(original));
  });
});

describe('toDiscordPlayable', () => {
  test('passes stereo 48 kHz audio through unchanged', () => {
    const stereo = pcm([1, 2, 3, 4]);
    const out = toDiscordPlayable({ pcm: stereo, sampleRate: 48000, channels: 2 });
    expect(out).toBe(stereo);
  });

  test('upmixes mono 48 kHz audio to stereo', () => {
    const out = toDiscordPlayable({ pcm: pcm([100, -200]), sampleRate: 48000, channels: 1 });
    expect(samples(out)).toEqual([100, 100, -200, -200]);
  });

  test('throws on a non-48 kHz sample rate', () => {
    expect(() => toDiscordPlayable({ pcm: pcm([1]), sampleRate: 44100, channels: 1 })).toThrow(/48000 Hz/);
  });

  test('throws on an unsupported channel count', () => {
    expect(() => toDiscordPlayable({ pcm: pcm([1]), sampleRate: 48000, channels: 6 })).toThrow(/6 channels/);
  });
});

describe('fromDiscordCapture', () => {
  test('downmixes to mono and tags the result as 48 kHz mono', () => {
    const captured = fromDiscordCapture(pcm([100, 300, -200, -400]));
    expect(captured.sampleRate).toBe(48000);
    expect(captured.channels).toBe(1);
    expect(samples(captured.pcm)).toEqual([200, -300]);
  });

  test('handles an empty capture', () => {
    const captured = fromDiscordCapture(Buffer.alloc(0));
    expect(captured.pcm.length).toBe(0);
    expect(captured.channels).toBe(1);
  });
});
