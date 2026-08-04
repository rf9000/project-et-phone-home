import { describe, expect, test } from 'bun:test';
import { fetchWithRetry, SpeechApiError } from '../../src/speech/http.ts';

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

function fetchSequence(responses: Array<Response | Error>): typeof fetch {
  let call = 0;
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const item = responses[call];
    call += 1;
    if (item === undefined) {
      throw new Error('fetchSequence: no more responses configured');
    }
    if (item instanceof Error) {
      throw item;
    }
    return item;
  }) as typeof fetch;
}

describe('fetchWithRetry — success passthrough', () => {
  test('returns the response on first success, no retries', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return makeResponse(200, 'ok');
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      'https://example.test/x',
      { method: 'GET' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    expect(await response.text()).toBe('ok');
    expect(calls).toBe(1);
  });
});

describe('fetchWithRetry — retry on 500', () => {
  test('retries once on 500 then succeeds', async () => {
    const fetchFn = fetchSequence([makeResponse(500, 'server error'), makeResponse(200, 'ok')]);

    const response = await fetchWithRetry(
      'https://example.test/x',
      { method: 'GET' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    expect(await response.text()).toBe('ok');
  });
});

describe('fetchWithRetry — retry on 429', () => {
  test('retries on 429 then succeeds', async () => {
    const fetchFn = fetchSequence([makeResponse(429, 'rate limited'), makeResponse(200, 'ok')]);

    const response = await fetchWithRetry(
      'https://example.test/x',
      { method: 'GET' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    expect(await response.text()).toBe('ok');
  });
});

describe('fetchWithRetry — no retry on 400', () => {
  test('throws SpeechApiError immediately with status and body', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return makeResponse(400, 'bad request');
    }) as unknown as typeof fetch;

    await expect(
      fetchWithRetry('https://example.test/x', { method: 'GET' }, { fetchFn, retryDelaysMs: [0, 0, 0] }),
    ).rejects.toThrow(SpeechApiError);

    expect(calls).toBe(1);

    try {
      await fetchWithRetry('https://example.test/x', { method: 'GET' }, { fetchFn, retryDelaysMs: [0, 0, 0] });
      throw new Error('expected fetchWithRetry to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpeechApiError);
      const apiErr = err as SpeechApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body).toBe('bad request');
    }
  });
});

describe('fetchWithRetry — network error retry', () => {
  test('retries after a network error then succeeds', async () => {
    const fetchFn = fetchSequence([new Error('network down'), makeResponse(200, 'ok')]);

    const response = await fetchWithRetry(
      'https://example.test/x',
      { method: 'GET' },
      { fetchFn, retryDelaysMs: [0, 0, 0] },
    );

    expect(await response.text()).toBe('ok');
  });
});

describe('fetchWithRetry — exhaustion throws', () => {
  test('throws the last error once retries are exhausted', async () => {
    const fetchFn = fetchSequence([
      makeResponse(500, 'e1'),
      makeResponse(500, 'e2'),
      makeResponse(500, 'e3'),
      makeResponse(500, 'e4'),
    ]);

    await expect(
      fetchWithRetry('https://example.test/x', { method: 'GET' }, { fetchFn, retryDelaysMs: [0, 0, 0] }),
    ).rejects.toThrow(SpeechApiError);
  });

  test('throws the last network error once retries are exhausted', async () => {
    const fetchFn = fetchSequence([
      new Error('e1'),
      new Error('e2'),
      new Error('e3'),
      new Error('e4'),
    ]);

    await expect(
      fetchWithRetry('https://example.test/x', { method: 'GET' }, { fetchFn, retryDelaysMs: [0, 0, 0] }),
    ).rejects.toThrow('e4');
  });
});
