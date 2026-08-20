import { describe, expect, test } from 'bun:test';
import { AskQueue } from '../../src/server/queue.ts';
import type { AskJobRequest } from '../../src/server/queue.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

/** runAsk fake whose promises resolve only when the test says so. */
function deferredRunAsk() {
  const calls: Array<{ request: AskJobRequest; resolve: (r: HumanResponse) => void }> = [];
  const runAsk = (request: AskJobRequest): Promise<HumanResponse> =>
    new Promise<HumanResponse>((resolve) => {
      calls.push({ request, resolve });
    });
  return { calls, runAsk };
}

const REQ: AskJobRequest = { question: 'q?', userId: 'user-1' };

describe('AskQueue core', () => {
  test('submit returns id and 1-based position', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });

    const first = queue.submit(REQ);
    await Bun.sleep(0); // let the worker pick it up
    const second = queue.submit({ ...REQ, userId: 'user-2' });

    expect(first.id).not.toBe(second.id);
    expect(first.position).toBe(1);
    expect(second.position).toBe(2); // one call in progress ahead of it
    expect(calls.length).toBe(1);
    expect(queue.get(first.id)?.state).toBe('calling');
    expect(queue.get(second.id)?.state).toBe('queued');
    expect(queue.position(second.id)).toBe(2);
  });

  test('strictly serial: second call starts only after the first resolves', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });

    const a = queue.submit(REQ);
    const b = queue.submit({ ...REQ, userId: 'user-2' });
    await Bun.sleep(0);
    expect(calls.length).toBe(1); // b not started

    calls[0]!.resolve(answered('A'));
    await Bun.sleep(0);
    expect(calls.length).toBe(2); // b started only now
    expect(queue.get(a.id)?.state).toBe('done');
    expect(queue.get(a.id)?.result).toEqual(answered('A'));
    expect(queue.get(b.id)?.state).toBe('calling');

    calls[1]!.resolve(answered('B'));
    await Bun.sleep(0);
    expect(queue.get(b.id)?.result?.answer).toBe('B');
  });

  test('a rejecting runAsk becomes a done job with an error-status result', async () => {
    const queue = new AskQueue({
      runAsk: () => Promise.reject(new Error('guild not found')),
    });
    const { id } = queue.submit(REQ);
    await Bun.sleep(0);

    const job = queue.get(id);
    expect(job?.state).toBe('done');
    expect(job?.result?.status).toBe('error');
    expect(job?.result?.error).toContain('guild not found');
  });

  test('get of unknown id returns undefined', () => {
    const queue = new AskQueue({ runAsk: () => Promise.resolve(answered('x')) });
    expect(queue.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
