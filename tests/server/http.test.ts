import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import type { AskJobRequest } from '../../src/server/queue.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(overrides: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken: '' },
    ...overrides,
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

function base(): string {
  return `http://127.0.0.1:${sb!.port}`;
}

async function postAsk(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base()}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('switchboard HTTP API', () => {
  test('POST /ask -> 202 with id+position; GET returns the verbatim result when done', async () => {
    const seen: AskJobRequest[] = [];
    sb = startSwitchboard(testSettings(), {
      runAsk: async (request) => {
        seen.push(request);
        return answered('four');
      },
    });

    const res = await postAsk({ question: 'What is 2+2?', userId: 'user-1' });
    expect(res.status).toBe(202);
    const { id, position } = (await res.json()) as { id: string; position: number };
    expect(position).toBe(1);

    const poll = await fetch(`${base()}/ask/${id}?waitMs=5000`);
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { state: string; result?: HumanResponse };
    expect(body.state).toBe('done');
    expect(body.result).toEqual(answered('four'));
    expect(seen[0]?.userId).toBe('user-1');
  });

  test('invalid body -> 400 with field errors; unknown route and id -> 404', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('x') });

    const res = await postAsk({ question: '' }); // empty question, missing userId
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('question');
    expect(body.error).toContain('userId');

    expect((await fetch(`${base()}/nope`)).status).toBe(404);
    expect(
      (await fetch(`${base()}/ask/00000000-0000-0000-0000-000000000000`)).status,
    ).toBe(404);
  });

  test('GET after retention window elapses -> 404, even with no intervening POST', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('four') });

    const { id } = (await (await postAsk({ question: 'q', userId: 'u' })).json()) as { id: string };
    const firstPoll = await fetch(`${base()}/ask/${id}?waitMs=5000`);
    expect(firstPoll.status).toBe(200);
    expect(((await firstPoll.json()) as { state: string }).state).toBe('done');

    // Simulate the job having finished over an hour ago (default resultTtlMs), with no other
    // request in between to trigger GC via submit()/get().
    const job = (sb.queue as unknown as { jobs: Map<string, { finishedAt?: number }> }).jobs.get(id);
    job!.finishedAt = Date.now() - 2 * 60 * 60 * 1000;

    const secondPoll = await fetch(`${base()}/ask/${id}?waitMs=0`);
    expect(secondPoll.status).toBe(404);
  });

  test('auth: configured token required on every route', async () => {
    sb = startSwitchboard(testSettings({ server: { host: '127.0.0.1', port: 0, authToken: 's3cret' } }), {
      runAsk: async () => answered('x'),
    });

    expect((await postAsk({ question: 'q', userId: 'u' })).status).toBe(401);
    const ok = await postAsk({ question: 'q', userId: 'u' }, { authorization: 'Bearer s3cret' });
    expect(ok.status).toBe(202);
  });

  test('DELETE cancels a queued job; refuses an in-progress one with 409', async () => {
    let release: ((r: HumanResponse) => void) | undefined;
    sb = startSwitchboard(testSettings(), {
      runAsk: () => new Promise<HumanResponse>((resolve) => { release = resolve; }),
    });

    const a = (await (await postAsk({ question: 'a', userId: 'u1' })).json()) as { id: string };
    const b = (await (await postAsk({ question: 'b', userId: 'u2' })).json()) as { id: string };
    await Bun.sleep(0);

    const cancelB = await fetch(`${base()}/ask/${b.id}`, { method: 'DELETE' });
    expect(cancelB.status).toBe(200);
    expect(((await cancelB.json()) as { state: string }).state).toBe('cancelled');

    const cancelA = await fetch(`${base()}/ask/${a.id}`, { method: 'DELETE' });
    expect(cancelA.status).toBe(409);

    release!(answered('a'));
  });

  test('startup is refused on a non-loopback bind without an auth token', () => {
    expect(() =>
      startSwitchboard(testSettings({ server: { host: '0.0.0.0', port: 0, authToken: '' } }), {
        runAsk: async () => answered('x'),
      }),
    ).toThrow(/auth token/i);
  });
});
