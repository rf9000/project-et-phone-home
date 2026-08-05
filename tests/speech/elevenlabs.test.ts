import { describe, expect, test } from 'bun:test';
import { ElevenLabsTts } from '../../src/speech/elevenlabs/tts.ts';
import { ElevenLabsStt } from '../../src/speech/elevenlabs/stt.ts';
import { SpeechApiError } from '../../src/speech/http.ts';
import type { AudioData } from '../../src/types/index.ts';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

describe('ElevenLabsTts', () => {
  test('sends the correct URL, headers, body, and maps PCM response to AudioData', async () => {
    const captured: CapturedRequest[] = [];
    const fakePcm = Buffer.from([1, 2, 3, 4]);

    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response(fakePcm, { status: 200 });
    }) as typeof fetch;

    const tts = new ElevenLabsTts(
      { apiKey: 'test-key', voiceId: 'voice-123', model: 'eleven_multilingual_v2' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    const audio = await tts.synthesize('hello there');

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=pcm_48000');
    expect(req.init.method).toBe('POST');

    const headers = req.init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(req.init.body as string) as { text: string; model_id: string };
    expect(body.text).toBe('hello there');
    expect(body.model_id).toBe('eleven_multilingual_v2');

    expect(audio.pcm.equals(fakePcm)).toBe(true);
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(1);
  });

  test('surfaces API errors as SpeechApiError', async () => {
    const fetchFn = (async () => new Response('invalid voice', { status: 400 })) as unknown as typeof fetch;

    const tts = new ElevenLabsTts(
      { apiKey: 'test-key', voiceId: 'bad-voice', model: 'eleven_multilingual_v2' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    await expect(tts.synthesize('hi')).rejects.toThrow(SpeechApiError);
  });
});

describe('ElevenLabsStt', () => {
  test('posts multipart form with file + model_id, sets xi-api-key, returns text', async () => {
    const captured: CapturedRequest[] = [];

    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const stt = new ElevenLabsStt({ apiKey: 'test-key', model: 'scribe_v1' }, { fetchFn, retryDelaysMs: [0, 0, 0] });

    const audio: AudioData = { pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 48000, channels: 1 };
    const text = await stt.transcribe(audio);

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(req.init.method).toBe('POST');

    const headers = req.init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('test-key');
    // No Content-Type set explicitly — fetch derives the multipart boundary itself.
    expect(headers['Content-Type']).toBeUndefined();

    expect(req.init.body instanceof FormData).toBe(true);
    const form = req.init.body as FormData;
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('audio/wav');
    expect(form.get('model_id')).toBe('scribe_v1');

    expect(text).toBe('hello world');
  });

  test('surfaces API errors as SpeechApiError', async () => {
    const fetchFn = (async () => new Response('unsupported format', { status: 422 })) as unknown as typeof fetch;

    const stt = new ElevenLabsStt({ apiKey: 'test-key', model: 'scribe_v1' }, { fetchFn, retryDelaysMs: [0, 0, 0] });

    const audio: AudioData = { pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 48000, channels: 1 };
    await expect(stt.transcribe(audio)).rejects.toThrow(SpeechApiError);
  });

  test('throws SpeechApiError when the response body has no string "text" field', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: 'no speech detected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const stt = new ElevenLabsStt({ apiKey: 'test-key', model: 'scribe_v1' }, { fetchFn, retryDelaysMs: [0, 0, 0] });

    const audio: AudioData = { pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 48000, channels: 1 };
    await expect(stt.transcribe(audio)).rejects.toThrow(SpeechApiError);
    await expect(stt.transcribe(audio)).rejects.toThrow(/missing a string "text" field/);
  });
});
