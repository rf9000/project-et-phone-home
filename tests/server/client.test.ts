import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import { SwitchboardClient, SwitchboardJobEndedError } from '../../src/server/client.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(authToken = ''): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken },
  });
}

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

let sb: Switchboard | undefined;
afterEach(async () => {
  await sb?.stop();
  sb = undefined;
});

describe('SwitchboardClient', () => {
  test('ask round-trips: submit, poll, return the verbatim HumanResponse', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('four') });
    const client = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 100 });

    const result = await client.ask('What is 2+2?', { userId: 'user-1' });
    expect(result).toEqual(answered('four'));
  });

  test('sends the bearer token when configured', async () => {
    sb = startSwitchboard(testSettings('s3cret'), { runAsk: async () => answered('x') });
    const noToken = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 100 });
    await expect(noToken.ask('q', { userId: 'u' })).rejects.toThrow(/401/);

    const withToken = new SwitchboardClient({
      baseUrl: `http://127.0.0.1:${sb.port}`,
      authToken: 's3cret',
      pollWaitMs: 100,
    });
    expect((await withToken.ask('q', { userId: 'u' })).answer).toBe('x');
  });

  test('a cancelled job surfaces as SwitchboardJobEndedError', async () => {
    let release: ((r: HumanResponse) => void) | undefined;
    sb = startSwitchboard(testSettings(), {
      runAsk: () => new Promise<HumanResponse>((resolve) => { release = resolve; }),
    });
    const client = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 50 });

    // First ask occupies the worker; second sits queued so we can cancel it mid-poll.
    const blocked = client.ask('a', { userId: 'u1' });
    await Bun.sleep(10);
    const pending = client.ask('b', { userId: 'u2' });
    await Bun.sleep(10);

    // The only cancellable job right now is the client's queued second ask ('b') — the first
    // occupies the worker ('calling', not cancellable). Cancel everything cancellable.
    let cancelled = 0;
    for (const [id] of (sb.queue as unknown as { jobs: Map<string, unknown> })['jobs']) {
      if (sb.queue.cancel(id) === 'cancelled') cancelled += 1;
    }
    expect(cancelled).toBe(1);

    await expect(pending).rejects.toBeInstanceOf(SwitchboardJobEndedError);
    release!(answered('a'));
    await blocked;
  });

  test('unreachable server rejects with a plain Error', async () => {
    const client = new SwitchboardClient({ baseUrl: 'http://127.0.0.1:9', pollWaitMs: 50 });
    await expect(client.ask('q', { userId: 'u' })).rejects.toThrow();
  });
});
