import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceConnection, VoiceReceiver } from '@discordjs/voice';
import { Events } from 'discord.js';
import type { Client, Guild, VoiceState } from 'discord.js';
import prism from 'prism-media';
import type { AskRequest, AudioData, ChannelSession } from '../../types/index.ts';
import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE, fromDiscordCapture, toDiscordPlayable } from './audio.ts';
import { formatRingMessage, isTargetUserInChannel, playbackTimeoutMs } from './helpers.ts';

/** How long the voice websocket/UDP handshake may take before we give up. */
const VOICE_READY_TIMEOUT_MS = 20_000;
/** How long the player may take to actually start emitting audio. */
const PLAYBACK_START_TIMEOUT_MS = 5_000;
/** Opus frame size for 20 ms of 48 kHz audio. */
const OPUS_FRAME_SIZE = 960;

export interface DiscordSessionOptions {
  /** A logged-in, ready discord.js client owned by this session (destroyed on hangUp). */
  client: Client;
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  /** Discord user id of the human being called. */
  userId: string;
  request: AskRequest;
}

function noop(): void {
  // Keeps at least one 'error' listener attached so a late stream error can never go unhandled.
}

function destroyStream(stream: { readonly destroyed: boolean; destroy: () => void }): void {
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // A stream that refuses to be destroyed must not break the call.
  }
}

function destroyConnection(connection: VoiceConnection): void {
  try {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  } catch {
    // destroy() throws if the connection was already destroyed elsewhere; that is the desired state.
  }
}

/** Resolves true as soon as the target user is heard speaking, false once timeoutMs elapses. */
function waitForSpeakingStart(receiver: VoiceReceiver, userId: string, timeoutMs: number): Promise<boolean> {
  if (receiver.speaking.users.has(userId)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (started: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      receiver.speaking.off('start', onStart);
      resolve(started);
    };

    const onStart = (speakerId: string): void => {
      if (speakerId === userId) finish(true);
    };

    receiver.speaking.on('start', onStart);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * A single Discord "call": one text notification, one voice connection, and the
 * speak/listen turns on top of it. Owns the client it is given and destroys it on hangUp.
 */
export class DiscordSession implements ChannelSession {
  private readonly client: Client;
  private readonly guildId: string;
  private readonly textChannelId: string;
  private readonly voiceChannelId: string;
  private readonly userId: string;
  private readonly request: AskRequest;

  private connection: VoiceConnection | undefined;
  private hungUp = false;

  constructor(options: DiscordSessionOptions) {
    this.client = options.client;
    this.guildId = options.guildId;
    this.textChannelId = options.textChannelId;
    this.voiceChannelId = options.voiceChannelId;
    this.userId = options.userId;
    this.request = options.request;
  }

  /** Posts the "a question is waiting for you" mention in the configured text channel. */
  async ring(): Promise<void> {
    const channel = await this.client.channels.fetch(this.textChannelId);

    if (channel === null || !channel.isSendable()) {
      throw new Error(
        `Discord text channel ${this.textChannelId} is missing or the bot cannot send messages in it.`,
      );
    }

    await channel.send(
      formatRingMessage({
        userId: this.userId,
        question: this.request.question,
        voiceChannelId: this.voiceChannelId,
      }),
    );
  }

  /**
   * Resolves true once the human is in the configured voice channel and the bot has joined it
   * too, false if that has not happened within timeoutMs. Always detaches its gateway listener.
   */
  async waitForHuman(timeoutMs: number): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);

    const present = await this.awaitVoicePresence(guild, timeoutMs);
    if (!present) return false;

    await this.connect(guild);
    return true;
  }

  /** Plays a PCM clip into the voice channel and resolves once playback has finished. */
  async speak(audio: AudioData): Promise<void> {
    const connection = this.requireConnection();
    const payload = toDiscordPlayable(audio);
    if (payload.length === 0) return;

    const player = createAudioPlayer();
    const subscription = connection.subscribe(player);

    try {
      // objectMode:false keeps the resource a plain binary stream; Readable.from would
      // otherwise hand the opus encoder an object-mode stream.
      const resource = createAudioResource(Readable.from(payload, { objectMode: false }), {
        inputType: StreamType.Raw,
      });

      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT_MS);
      await entersState(player, AudioPlayerStatus.Idle, playbackTimeoutMs(payload.length));
    } finally {
      player.stop(true);
      subscription?.unsubscribe();
    }
  }

  /**
   * Captures the human's next utterance. Waits up to maxMs for them to start speaking (null if
   * they never do), then records until silenceMs of silence or another maxMs, whichever is first.
   */
  async listen(opts: { silenceMs: number; maxMs: number }): Promise<AudioData | null> {
    const connection = this.requireConnection();
    const receiver = connection.receiver;

    // The receiver marks a user as speaking on the same packet it would push to a subscription,
    // so subscribing after the 'start' event costs at most the single 20 ms frame that raised it.
    const started = await waitForSpeakingStart(receiver, this.userId, opts.maxMs);
    if (!started) return null;

    const captured = await this.captureUtterance(receiver, opts);
    if (captured.length === 0) return null;

    return fromDiscordCapture(captured);
  }

  /** Leaves the voice channel and closes the gateway connection. Idempotent; never throws. */
  async hangUp(): Promise<void> {
    if (this.hungUp) return;
    this.hungUp = true;

    const connection = this.connection ?? getVoiceConnection(this.guildId);
    if (connection !== undefined) destroyConnection(connection);
    this.connection = undefined;

    try {
      await this.client.destroy();
    } catch {
      // Tearing down an already-closed client must never surface as a call failure.
    }
  }

  /**
   * Resolves true when the human is in the target voice channel. The gateway listener is
   * attached before the presence probe runs so a join in between cannot be missed.
   */
  private awaitVoicePresence(guild: Guild, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (present: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.client.off(Events.VoiceStateUpdate, onVoiceStateUpdate);
        resolve(present);
      };

      const onVoiceStateUpdate = (_oldState: VoiceState, newState: VoiceState): void => {
        if (isTargetUserInChannel(newState, this.userId, this.voiceChannelId)) finish(true);
      };

      this.client.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
      timer = setTimeout(() => finish(false), timeoutMs);

      void this.isUserAlreadyInVoiceChannel(guild).then(
        (present) => {
          if (present) finish(true);
        },
        () => {
          // A failed presence probe is not fatal — keep waiting for the join event.
        },
      );
    });
  }

  private async isUserAlreadyInVoiceChannel(guild: Guild): Promise<boolean> {
    const cached = guild.voiceStates.cache.get(this.userId);
    if (cached !== undefined) return isTargetUserInChannel(cached, this.userId, this.voiceChannelId);

    try {
      const fetched = await guild.voiceStates.fetch(this.userId);
      return isTargetUserInChannel(fetched, this.userId, this.voiceChannelId);
    } catch {
      // Discord 404s the voice state of a user who is not connected to any voice channel.
      return false;
    }
  }

  private async connect(guild: Guild): Promise<VoiceConnection> {
    const existing = getVoiceConnection(guild.id);
    const connection =
      existing !== undefined && existing.state.status !== VoiceConnectionStatus.Destroyed
        ? existing
        : joinVoiceChannel({
            channelId: this.voiceChannelId,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            // Deaf would silence the receiver; mute would silence playback.
            selfDeaf: false,
            selfMute: false,
          });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    } catch (error) {
      destroyConnection(connection);
      throw new Error(
        `Discord voice connection to channel ${this.voiceChannelId} was not ready within ${VOICE_READY_TIMEOUT_MS} ms.`,
        { cause: error },
      );
    }

    this.connection = connection;
    return connection;
  }

  private requireConnection(): VoiceConnection {
    const connection = this.connection;

    if (connection === undefined || connection.state.status === VoiceConnectionStatus.Destroyed) {
      throw new Error('Discord session has no active voice connection; waitForHuman() must succeed first.');
    }

    return connection;
  }

  /**
   * Subscribes to the user's opus stream, decodes it to PCM and collects it until the receiver
   * ends the stream after silenceMs, the decoder errors, or the maxMs hard cap fires — whichever
   * comes first. Always tears both streams down and resolves with whatever was captured.
   */
  private captureUtterance(receiver: VoiceReceiver, opts: { silenceMs: number; maxMs: number }): Promise<Buffer> {
    // subscribe() hands back an existing subscription for the same user, which would be a
    // spent (destroyed) stream from a previous turn; drop it so every listen() starts fresh.
    const stale = receiver.subscriptions.get(this.userId);
    if (stale !== undefined) {
      destroyStream(stale);
      receiver.subscriptions.delete(this.userId);
    }

    const opusStream = receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: opts.silenceMs },
    });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: OPUS_FRAME_SIZE,
    });

    // Permanent no-op handlers: a stream error raised while tearing down must not crash the process.
    opusStream.on('error', noop);
    decoder.on('error', noop);

    const chunks: Buffer[] = [];

    return new Promise<Buffer>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        decoder.off('data', onData);
        opusStream.unpipe(decoder);
        destroyStream(opusStream);
        destroyStream(decoder);
        resolve(Buffer.concat(chunks));
      };

      decoder.on('data', onData);
      // 'end' is the normal flush; 'close' covers a stream destroyed without ending;
      // 'error' keeps whatever was decoded before the failure.
      decoder.once('end', finish);
      decoder.once('close', finish);
      decoder.once('error', finish);
      opusStream.once('error', finish);

      timer = setTimeout(finish, opts.maxMs);
      opusStream.pipe(decoder);
    });
  }
}
