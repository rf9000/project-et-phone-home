import type { HumanResponse } from '../types/index.ts';
import type { AskJobRequest, JobState } from './queue.ts';

export interface SwitchboardClientOptions {
  baseUrl: string;
  authToken?: string;
  fetchFn?: typeof fetch;
  /** Long-poll window per GET; the server caps at 60s. Default 30s. */
  pollWaitMs?: number;
}

export interface RemoteAskOptions {
  userId: string;
  textChannelId?: string;
  voiceChannelId?: string;
  queueTimeoutMs?: number;
  call?: AskJobRequest['call'];
}

/** The job ended without an answer for queue reasons (never rang, or was cancelled). */
export class SwitchboardJobEndedError extends Error {
  readonly state: 'expired' | 'cancelled';

  constructor(state: 'expired' | 'cancelled') {
    super(`Ask ended without an answer: job ${state}.`);
    this.name = 'SwitchboardJobEndedError';
    this.state = state;
  }
}

interface JobViewBody {
  state: JobState;
  position?: number;
  result?: HumanResponse;
}

/** Submit-then-poll client for the switchboard HTTP API. */
export class SwitchboardClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly pollWaitMs: number;

  constructor(opts: SwitchboardClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollWaitMs = opts.pollWaitMs ?? 30_000;
  }

  async ask(question: string, opts: RemoteAskOptions): Promise<HumanResponse> {
    const submit = await this.request('POST', '/ask', { question, ...opts });
    const { id } = (await submit.json()) as { id: string };

    for (;;) {
      const poll = await this.request('GET', `/ask/${id}?waitMs=${this.pollWaitMs}`);
      const body = (await poll.json()) as JobViewBody;

      if (body.state === 'done') return body.result as HumanResponse;
      if (body.state === 'expired' || body.state === 'cancelled') {
        throw new SwitchboardJobEndedError(body.state);
      }
      // queued / calling: poll again.
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.authToken !== undefined && this.authToken !== ''
          ? { authorization: `Bearer ${this.authToken}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Switchboard request failed with status ${response.status}: ${text}`);
    }
    return response;
  }
}
