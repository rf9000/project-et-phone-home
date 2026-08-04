import { describe, expect, test } from 'bun:test';
import {
  DISCORD_PCM_BYTES_PER_MS,
  PLAYBACK_SLACK_MS,
  formatRingMessage,
  isTargetUserInChannel,
  playbackTimeoutMs,
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
