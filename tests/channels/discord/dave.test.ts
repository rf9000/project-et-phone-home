import { describe, expect, test } from 'bun:test';
import {
  describeE2ee,
  e2eeNotReadyMessage,
  isE2eeReady,
  waitForE2eeReady,
} from '../../../src/channels/discord/dave.ts';
import type { VoiceConnectionLike } from '../../../src/channels/discord/dave.ts';

/** A mutable connection stand-in whose DAVE state tests can flip mid-wait. */
class FakeConnection implements VoiceConnectionLike {
  status = 'ready';
  hasNetworking = true;
  dave: { protocolVersion: number; session?: { ready: boolean } } | undefined;

  constructor(dave?: { protocolVersion: number; session?: { ready: boolean } }) {
    this.dave = dave;
  }

  get state(): VoiceConnectionLike['state'] {
    return {
      status: this.status,
      networking: this.hasNetworking ? { state: { code: 4, dave: this.dave } } : undefined,
    };
  }
}

describe('describeE2ee', () => {
  test('no DAVE session at all means nothing to wait for', () => {
    const conn = new FakeConnection(undefined);
    expect(describeE2ee(conn)).toEqual({ connection: 'ready', protocolVersion: -1, sessionReady: true });
  });

  test('no networking state (not yet connected) also means nothing to wait for', () => {
    const conn = new FakeConnection(undefined);
    conn.hasNetworking = false;
    conn.status = 'signalling';
    expect(describeE2ee(conn)).toEqual({ connection: 'signalling', protocolVersion: -1, sessionReady: true });
  });

  test('protocol 0 is ready regardless of the MLS session', () => {
    expect(describeE2ee(new FakeConnection({ protocolVersion: 0 })).sessionReady).toBe(true);
    expect(describeE2ee(new FakeConnection({ protocolVersion: 0, session: { ready: false } })).sessionReady).toBe(true);
  });

  test('protocol 1 without a native session is not ready', () => {
    expect(describeE2ee(new FakeConnection({ protocolVersion: 1 }))).toEqual({
      connection: 'ready',
      protocolVersion: 1,
      sessionReady: false,
    });
  });

  test('protocol 1 follows the native session readiness', () => {
    expect(isE2eeReady(new FakeConnection({ protocolVersion: 1, session: { ready: false } }))).toBe(false);
    expect(isE2eeReady(new FakeConnection({ protocolVersion: 1, session: { ready: true } }))).toBe(true);
  });
});

describe('waitForE2eeReady', () => {
  test('resolves true immediately when already ready', async () => {
    const started = Date.now();
    expect(await waitForE2eeReady(new FakeConnection({ protocolVersion: 0 }), 1000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(40);
  });

  test('resolves true once the MLS session becomes ready mid-wait', async () => {
    const session = { ready: false };
    const conn = new FakeConnection({ protocolVersion: 1, session });
    setTimeout(() => {
      session.ready = true;
    }, 80);

    expect(await waitForE2eeReady(conn, 2000)).toBe(true);
  });

  test('resolves true when the wrapper creates its native session later', async () => {
    const dave: { protocolVersion: number; session?: { ready: boolean } } = { protocolVersion: 1 };
    const conn = new FakeConnection(dave);
    setTimeout(() => {
      dave.session = { ready: true };
    }, 80);

    expect(await waitForE2eeReady(conn, 2000)).toBe(true);
  });

  test('resolves true when Discord downgrades the channel to protocol 0 mid-wait', async () => {
    const dave = { protocolVersion: 1, session: { ready: false } };
    const conn = new FakeConnection(dave);
    setTimeout(() => {
      dave.protocolVersion = 0;
    }, 80);

    expect(await waitForE2eeReady(conn, 2000)).toBe(true);
  });

  test('resolves false after the timeout when the session never becomes ready', async () => {
    const started = Date.now();
    expect(await waitForE2eeReady(new FakeConnection({ protocolVersion: 1, session: { ready: false } }), 120)).toBe(
      false,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test('resolves false as soon as the connection is destroyed', async () => {
    const conn = new FakeConnection({ protocolVersion: 1, session: { ready: false } });
    setTimeout(() => {
      conn.status = 'destroyed';
    }, 60);

    const started = Date.now();
    expect(await waitForE2eeReady(conn, 5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('e2eeNotReadyMessage', () => {
  const message = e2eeNotReadyMessage({ connection: 'ready', protocolVersion: 1, sessionReady: false }, 10_000);

  test('names the wait, the protocol version and the consequence', () => {
    expect(message).toContain('10000 ms');
    expect(message).toContain('v1');
    expect(message.toLowerCase()).toContain('silence');
  });

  test('points at the diagnostic script', () => {
    expect(message).toContain('scripts/playback-trace.ts');
  });

  test('is a single line for daemon logs', () => {
    expect(message).not.toContain('\n');
  });
});
