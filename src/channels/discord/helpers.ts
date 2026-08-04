import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from './audio.ts';

const BYTES_PER_SAMPLE = 2;

/** Bytes of 48 kHz stereo 16-bit PCM that represent one millisecond of audio (192). */
export const DISCORD_PCM_BYTES_PER_MS = (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * BYTES_PER_SAMPLE) / 1000;

/** Extra time allowed on top of a clip's own duration before playback is considered stuck. */
export const PLAYBACK_SLACK_MS = 10_000;

/**
 * Minimal structural view of a discord.js `VoiceState`. Declared locally so these pure
 * helpers stay free of discord.js imports and remain trivially unit-testable.
 */
export interface VoiceStateLike {
  /** The id of the user this voice state belongs to. */
  readonly id: string;
  /** The voice channel the user is currently in, or null when not connected. */
  readonly channelId: string | null;
}

/**
 * True when the given voice state says the target user is sitting in the target voice channel.
 * Used both for the "already there" cache probe and for every `voiceStateUpdate` event, so a
 * state change that keeps the user in the channel (mute/deafen/stream) still counts as present.
 */
export function isTargetUserInChannel(state: VoiceStateLike, userId: string, voiceChannelId: string): boolean {
  return state.id === userId && state.channelId === voiceChannelId;
}

/** The exact Discord text notification that tells the human a question is waiting. */
export function formatRingMessage(opts: { userId: string; question: string; voiceChannelId: string }): string {
  return `🔔 <@${opts.userId}> — I have a question for you:\n> ${opts.question}\nJoin <#${opts.voiceChannelId}> to answer by voice.`;
}

/**
 * Upper bound on how long playback of a PCM clip may take: the clip's own duration plus slack
 * for network jitter and the player's silence padding frames.
 */
export function playbackTimeoutMs(byteLength: number): number {
  return Math.ceil(byteLength / DISCORD_PCM_BYTES_PER_MS) + PLAYBACK_SLACK_MS;
}
