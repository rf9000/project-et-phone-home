import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pcmToWav } from './wav.ts';
import type { AudioData, SpeechToText } from '../types/index.ts';

/**
 * SpeechToText decorator that saves every captured utterance as a WAV file before delegating,
 * so a human can listen to exactly what the bot heard when a transcript comes back wrong
 * (clipped onset, mic noise, wrong speaker). Enabled via settings.call.debugAudioDir.
 * Dump failures are reported to stderr but never fail the transcription itself.
 */
export class DumpingStt implements SpeechToText {
  private counter = 0;

  constructor(
    private readonly inner: SpeechToText,
    private readonly dir: string,
  ) {}

  async transcribe(audio: AudioData): Promise<string> {
    this.counter += 1;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `utterance-${String(this.counter).padStart(3, '0')}-${Date.now()}.wav`);
      writeFileSync(file, pcmToWav(audio));
      process.stderr.write(`[debug] captured audio saved: ${file}\n`);
    } catch (error) {
      process.stderr.write(`[debug] failed to save captured audio: ${(error as Error).message}\n`);
    }
    return this.inner.transcribe(audio);
  }
}
