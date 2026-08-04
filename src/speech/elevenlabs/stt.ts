import { fetchWithRetry } from '../http.ts';
import { pcmToWav } from '../wav.ts';
import type { AudioData, SpeechToText } from '../../types/index.ts';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

export interface ElevenLabsSttConfig {
  apiKey: string;
  model: string;
}

export interface ElevenLabsSttDeps {
  fetchFn?: typeof fetch;
  retryDelaysMs?: number[];
}

interface SpeechToTextResponse {
  text: string;
}

export class ElevenLabsStt implements SpeechToText {
  constructor(
    private readonly cfg: ElevenLabsSttConfig,
    private readonly deps: ElevenLabsSttDeps = {},
  ) {}

  async transcribe(audio: AudioData): Promise<string> {
    const wav = pcmToWav(audio);
    const form = new FormData();
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.set('model_id', this.cfg.model);

    const response = await fetchWithRetry(
      STT_URL,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.cfg.apiKey,
        },
        body: form,
      },
      { fetchFn: this.deps.fetchFn, retryDelaysMs: this.deps.retryDelaysMs },
    );

    const json = (await response.json()) as SpeechToTextResponse;
    return json.text;
  }
}
