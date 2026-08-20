import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DumpingStt } from '../../src/speech/debug.ts';
import type { AudioData, SpeechToText } from '../../src/types/index.ts';

function makeAudio(byteLength = 4): AudioData {
  return { pcm: Buffer.alloc(byteLength, 7), sampleRate: 48000, channels: 2 };
}

class RecordingStt implements SpeechToText {
  received: AudioData[] = [];
  async transcribe(audio: AudioData): Promise<string> {
    this.received.push(audio);
    return 'four';
  }
}

describe('DumpingStt', () => {
  test('writes each utterance as a WAV then delegates, returning the inner transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'etph-debug-'));
    try {
      const inner = new RecordingStt();
      const stt = new DumpingStt(inner, dir);

      const first = await stt.transcribe(makeAudio(4));
      const second = await stt.transcribe(makeAudio(8));

      expect(first).toBe('four');
      expect(second).toBe('four');
      expect(inner.received.length).toBe(2);

      const files = readdirSync(dir).sort();
      expect(files.length).toBe(2);
      for (const file of files) {
        expect(file.endsWith('.wav')).toBe(true);
        // RIFF magic proves it went through pcmToWav, not a raw PCM dump.
        expect(readFileSync(join(dir, file)).subarray(0, 4).toString('ascii')).toBe('RIFF');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates the directory if it does not exist yet', async () => {
    const base = mkdtempSync(join(tmpdir(), 'etph-debug-'));
    try {
      const dir = join(base, 'nested', 'dumps');
      const stt = new DumpingStt(new RecordingStt(), dir);

      await stt.transcribe(makeAudio());

      expect(readdirSync(dir).length).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a dump failure never breaks transcription', async () => {
    // A path that cannot be a directory: a file already occupies it.
    const base = mkdtempSync(join(tmpdir(), 'etph-debug-'));
    try {
      const blocker = join(base, 'blocker');
      await Bun.write(blocker, 'not a directory');
      const stt = new DumpingStt(new RecordingStt(), join(blocker, 'dumps'));

      const result = await stt.transcribe(makeAudio());

      expect(result).toBe('four');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
