/** Thrown for non-retryable (or retry-exhausted) HTTP failures from a speech API call. */
export class SpeechApiError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, opts?: { status?: number; body?: string }) {
    super(message);
    this.name = 'SpeechApiError';
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.body !== undefined) this.body = opts.body;
  }
}

/** Longest response body echoed into the error message; the full body stays on `.body`. */
const MAX_BODY_IN_MESSAGE = 400;

/** Collapses whitespace and truncates, so a JSON or HTML error page stays readable on one line. */
function summarizeBody(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length <= MAX_BODY_IN_MESSAGE ? flat : `${flat.slice(0, MAX_BODY_IN_MESSAGE)}...`;
}

export interface FetchWithRetryOptions {
  maxRetries?: number;
  retryDelaysMs?: number[];
  fetchFn?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * fetch wrapper with exponential-backoff retry on network errors, 429, and 5xx.
 * Non-retryable non-OK responses (4xx other than 429) throw immediately as SpeechApiError.
 * When retries are exhausted, the last error (network error or SpeechApiError) is thrown.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: FetchWithRetryOptions,
): Promise<Response> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const retryDelaysMs = opts?.retryDelaysMs ?? [1000, 2000, 4000];
  const maxRetries = opts?.maxRetries ?? retryDelaysMs.length;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(url, init);

      if (response.ok) {
        return response;
      }

      const body = await response.text();
      // The status alone is not actionable — a 400 from ElevenLabs means "bad voice id" or
      // "unknown model" only if you can read the body, so it goes in the message too.
      const summary = summarizeBody(body);
      const apiError = new SpeechApiError(
        `Speech API request failed with status ${response.status}${summary === '' ? '' : `: ${summary}`}`,
        { status: response.status, body },
      );

      if (!isRetryableStatus(response.status)) {
        throw apiError;
      }

      lastError = apiError;
    } catch (err) {
      // Non-retryable SpeechApiError thrown above propagates straight out; anything else
      // reaching here (a retryable SpeechApiError, or a network error from fetchFn) is retryable.
      if (err instanceof SpeechApiError && !isRetryableStatus(err.status ?? 0)) {
        throw err;
      }
      lastError = err;
    }

    if (attempt < maxRetries) {
      const delay = retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0;
      await sleep(delay);
    }
  }

  throw lastError;
}
