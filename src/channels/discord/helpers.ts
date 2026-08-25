import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from './audio.ts';

const BYTES_PER_SAMPLE = 2;

/** Bytes of 48 kHz stereo 16-bit PCM that represent one millisecond of audio (192). */
export const DISCORD_PCM_BYTES_PER_MS = (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * BYTES_PER_SAMPLE) / 1000;

/** Extra time allowed on top of a clip's own duration before playback is considered stuck. */
export const PLAYBACK_SLACK_MS = 10_000;

/**
 * How long the voice websocket/UDP handshake may take before we give up.
 *
 * Not 20 s: on a network that advertises IPv6 without routing it, Bun's WebSocket tries the IPv6
 * addresses first and only falls back to IPv4 after the OS gives up on the TCP connect — about
 * 21 s on Windows. A 20 s limit failed those calls with ~1 s to spare while a 21.3 s handshake
 * was about to succeed (measured with scripts/voice-trace.ts). The handshake itself, once the
 * websocket is open, takes well under a second, so the extra headroom costs nothing on a healthy
 * network and turns a failed call into a slow join on a broken one.
 */
export const VOICE_READY_TIMEOUT_MS = 45_000;

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

/**
 * The message shown when the voice handshake never reaches Ready.
 *
 * Everything else in a call — gateway login, REST, the text ping, presence detection — runs over
 * ordinary HTTPS, but the voice websocket connects to a `*.discord.media` host on its own port,
 * so it is the one leg a restrictive or broken network breaks on its own. A bare "not ready
 * within N ms" sends the reader hunting through their own code; these pointers send them to the
 * network, which is where the fault almost always is.
 */
export function voiceTimeoutMessage(voiceChannelId: string, timeoutMs: number): string {
  return (
    `Discord voice connection to channel ${voiceChannelId} was not ready within ${timeoutMs} ms. ` +
    'Everything else (login, text ping) uses HTTPS, so this usually means the network is blocking ' +
    'or black-holing the voice connection rather than anything being wrong with the bot: check for ' +
    'a firewall/VPN blocking outbound traffic to *.discord.media, or IPv6 that is advertised but ' +
    'does not route (Bun tries IPv6 first and only falls back to IPv4 after the OS connect timeout). ' +
    'Run `bun run scripts/voice-trace.ts` to see which phase stalls and `bun run scripts/ws-probe.ts` ' +
    'to test each address family.'
  );
}

/** Minimal structural view of a Node stream that can be destroyed and emits 'close'. */
export interface ClosableStream {
  readonly destroyed: boolean;
  destroy: () => void;
  once: (event: 'close', listener: () => void) => unknown;
  off: (event: 'close', listener: () => void) => unknown;
}

/**
 * Destroys a stream and waits for its 'close' to actually be delivered, giving up after
 * timeoutMs so a stream that never closes cannot wedge the caller.
 *
 * Waiting is the point. @discordjs/voice removes a voice subscription from its per-user
 * registry inside that stream's own 'close' handler, keyed by user id with no identity check —
 * so a 'close' delivered after a re-subscribe would evict the *new* subscription and silently
 * swallow every packet of that turn. Letting the old handler run first avoids that entirely.
 */
export function closeStream(stream: ClosableStream, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stream.off('close', finish);
      resolve();
    };

    // Listener first: destroy() can schedule 'close' immediately.
    stream.once('close', finish);

    try {
      if (!stream.destroyed) stream.destroy();
    } catch {
      // A stream that refuses to be destroyed must not break the call; the timer still fires.
    }

    timer = setTimeout(finish, timeoutMs);
  });
}
