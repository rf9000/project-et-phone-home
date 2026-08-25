import { SpeechApiError, fetchWithRetry } from '../http.ts';
import type { AudioData, TextToSpeech } from '../../types/index.ts';

const TTS_SAMPLE_RATE = 48000;
const TTS_CHANNELS = 1;

export interface ElevenLabsTtsConfig {
  apiKey: string;
  voiceId: string;
  model: string;
}

export interface ElevenLabsTtsDeps {
  fetchFn?: typeof fetch;
  retryDelaysMs?: number[];
}

export class ElevenLabsTts implements TextToSpeech {
  constructor(
    private readonly cfg: ElevenLabsTtsConfig,
    private readonly deps: ElevenLabsTtsDeps = {},
  ) {}

  async synthesize(text: string): Promise<AudioData> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.cfg.voiceId}?output_format=pcm_48000`;

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.cfg.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: this.cfg.model }),
      },
      { fetchFn: this.deps.fetchFn, retryDelaysMs: this.deps.retryDelaysMs },
    );

    const arrayBuffer = await response.arrayBuffer();

    // A 200 with no audio would otherwise flow all the way to a "successful" call in which the
    // bot joins, says nothing, and listens — indistinguishable in the logs from a working one.
    if (arrayBuffer.byteLength === 0) {
      throw new SpeechApiError(
        `Speech API returned status ${response.status} with an empty body for text-to-speech (voice ${this.cfg.voiceId}, model ${this.cfg.model}).`,
        { status: response.status, body: '' },
      );
    }

    return {
      pcm: Buffer.from(arrayBuffer),
      sampleRate: TTS_SAMPLE_RATE,
      channels: TTS_CHANNELS,
    };
  }
}
