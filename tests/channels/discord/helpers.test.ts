import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  DISCORD_PCM_BYTES_PER_MS,
  PLAYBACK_SLACK_MS,
  closeStream,
  formatRingMessage,
  isTargetUserInChannel,
  playbackTimeoutMs,
  voiceTimeoutMessage,
} from '../../../src/channels/discord/helpers.ts';

const USER = '111';
const VOICE = '222';

describe('isTargetUserInChannel', () => {
  test('true when the target user is in the target channel', () => {
    expect(isTargetUserInChannel({ id: USER, channelId: VOICE }, USER, VOICE)).toBe(true);
  });

  test('false for another user in the target channel', () => {
    expect(isTargetUserInChannel({ id: '999', channelId: VOICE }, USER, VOICE)).toBe(false);
  });

  test('false for the target user in another channel', () => {
    expect(isTargetUserInChannel({ id: USER, channelId: '333' }, USER, VOICE)).toBe(false);
  });

  test('false when the target user is not connected to voice', () => {
    expect(isTargetUserInChannel({ id: USER, channelId: null }, USER, VOICE)).toBe(false);
  });
});

describe('formatRingMessage', () => {
  test('renders the mention, quoted question and channel link', () => {
    const message = formatRingMessage({ userId: USER, question: 'ship it?', voiceChannelId: VOICE });
    expect(message).toBe('🔔 <@111> — I have a question for you:\n> ship it?\nJoin <#222> to answer by voice.');
  });

  test('embeds the question verbatim', () => {
    const message = formatRingMessage({ userId: USER, question: 'a "quoted" one', voiceChannelId: VOICE });
    expect(message).toContain('> a "quoted" one');
  });
});

describe('playbackTimeoutMs', () => {
  test('exposes 192 bytes per millisecond of 48 kHz stereo 16-bit PCM', () => {
    expect(DISCORD_PCM_BYTES_PER_MS).toBe(192);
  });

  test('is the clip duration plus slack', () => {
    expect(playbackTimeoutMs(192 * 1000)).toBe(1000 + PLAYBACK_SLACK_MS);
  });

  test('is just the slack for an empty clip', () => {
    expect(playbackTimeoutMs(0)).toBe(PLAYBACK_SLACK_MS);
  });

  test('rounds a partial millisecond up', () => {
    expect(playbackTimeoutMs(1)).toBe(1 + PLAYBACK_SLACK_MS);
  });

  test('grows with clip length', () => {
    expect(playbackTimeoutMs(192 * 30_000)).toBe(30_000 + PLAYBACK_SLACK_MS);
  });
});

/** Stand-in for a Node stream: destroy() optionally schedules 'close' the way a real one does. */
class FakeStream extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;

  constructor(private readonly emitsClose = true) {
    super();
  }

  destroy(): void {
    this.destroyCalls++;
    this.destroyed = true;
    if (this.emitsClose) setTimeout(() => this.emit('close'), 0);
  }
}

describe('closeStream', () => {
  test('destroys the stream and resolves once close is delivered', async () => {
    const stream = new FakeStream();
    await closeStream(stream, 1000);
    expect(stream.destroyCalls).toBe(1);
    expect(stream.destroyed).toBe(true);
  });

  test('detaches its close listener', async () => {
    const stream = new FakeStream();
    await closeStream(stream, 1000);
    expect(stream.listenerCount('close')).toBe(0);
  });

  test('does not re-destroy an already destroyed stream', async () => {
    const stream = new FakeStream();
    stream.destroyed = true;
    setTimeout(() => stream.emit('close'), 0);
    await closeStream(stream, 1000);
    expect(stream.destroyCalls).toBe(0);
  });

  test('gives up after the timeout when close never arrives', async () => {
    const stream = new FakeStream(false);
    const started = Date.now();
    await closeStream(stream, 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(stream.listenerCount('close')).toBe(0);
  });

  test('resolves even when destroy throws', async () => {
    const stream = new FakeStream(false);
    stream.destroy = () => {
      throw new Error('cannot destroy');
    };
    await closeStream(stream, 20);
  });

  // Regression: @discordjs/voice's receiver deletes its subscription entry from that stream's own
  // 'close' handler, keyed by user id with no identity check. Re-subscribing before that handler
  // has run would let it evict the fresh subscription instead of the spent one.
  test('lets a receiver release its registry slot before the caller re-subscribes', async () => {
    const subscriptions = new Map<string, FakeStream>();

    const subscribe = (userId: string): FakeStream => {
      const existing = subscriptions.get(userId);
      if (existing !== undefined) return existing;
      const stream = new FakeStream();
      stream.once('close', () => subscriptions.delete(userId));
      subscriptions.set(userId, stream);
      return stream;
    };

    const first = subscribe('user');
    await closeStream(first, 1000);
    expect(subscriptions.size).toBe(0);

    const second = subscribe('user');
    expect(second).not.toBe(first);

    // The spent stream's handler has already run, so it cannot evict the fresh entry afterwards.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscriptions.get('user')).toBe(second);
  });
});

describe('voiceTimeoutMessage', () => {
  // This message is the whole diagnosis a user gets when the voice handshake stalls. A bare
  // "not ready within N ms" once cost an hour of bisecting a network fault that was never in
  // the code, so it must name the things actually worth checking.
  const message = voiceTimeoutMessage('123456789', 20_000);

  test('states what failed, where, and after how long', () => {
    expect(message).toContain('123456789');
    expect(message).toContain('20000 ms');
    expect(message.toLowerCase()).toContain('voice');
  });

  test('points at the network causes rather than the code', () => {
    const lower = message.toLowerCase();
    expect(lower).toContain('network');
    expect(lower).toContain('ipv6');
    expect(message).toContain('ETPH_PREFER_IPV4');
  });

  test('names the diagnostic script that identifies the stalling phase', () => {
    expect(message).toContain('scripts/voice-trace.ts');
  });

  test('is a single line so it stays readable in daemon logs and JSON output', () => {
    expect(message).not.toContain('\n');
  });
});
