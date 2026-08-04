import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';
import type { Channel } from 'discord.js';
import type { Settings } from '../../settings/schema.ts';
import type {
  AskRequest,
  ChannelCapabilities,
  ChannelSession,
  CommunicationChannel,
} from '../../types/index.ts';
import { DiscordSession } from './session.ts';

/** How long login + READY may take before the configuration is declared broken. */
const READY_TIMEOUT_MS = 30_000;

export type DiscordConfig = Settings['discord'];

export interface DiscordChannelDeps {
  /** Injectable client factory so tests can supply a fake instead of a real gateway client. */
  clientFactory?: () => Client;
}

interface ReadyGate {
  promise: Promise<void>;
  /** Detaches listeners and the timer. After this the promise can no longer settle. */
  cancel: () => void;
}

function createDefaultClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });
}

/**
 * Arms the READY/error/timeout race *before* login is attempted. Cancelling instead of rejecting
 * on the caller's error path means a failed login can never leave an unhandled rejection behind.
 */
function armReadyGate(client: Client): ReadyGate {
  let cancel = (): void => {};

  const promise = new Promise<void>((resolve, reject) => {
    const detach = (): void => {
      clearTimeout(timer);
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };

    const onReady = (): void => {
      detach();
      resolve();
    };

    const onError = (error: Error): void => {
      detach();
      reject(new Error('Discord client reported an error before it became ready.', { cause: error }));
    };

    const timer = setTimeout(() => {
      detach();
      reject(new Error(`Discord client did not become ready within ${READY_TIMEOUT_MS} ms.`));
    }, READY_TIMEOUT_MS);

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
    cancel = detach;
  });

  return { promise, cancel };
}

async function loginAndWaitReady(client: Client, botToken: string): Promise<void> {
  if (client.isReady()) return;

  const gate = armReadyGate(client);

  try {
    try {
      await client.login(botToken);
    } catch (error) {
      // The token itself is never echoed — only the library's own message is chained as the cause.
      throw new Error('Discord login failed; check settings.discord.botToken.', { cause: error });
    }

    await gate.promise;
  } finally {
    gate.cancel();
  }
}

function channelGuildId(channel: Channel): string | undefined {
  return 'guildId' in channel ? channel.guildId : undefined;
}

async function fetchChannel(client: Client, channelId: string, settingPath: string): Promise<Channel> {
  const channel = await client.channels.fetch(channelId).catch((error: unknown) => {
    throw new Error(`Discord channel ${channelId} (${settingPath}) could not be fetched.`, { cause: error });
  });

  if (channel === null) {
    throw new Error(`Discord channel ${channelId} (${settingPath}) does not exist or is not visible to the bot.`);
  }

  return channel;
}

/**
 * Discord implementation of the channel contract. Discord bots cannot ring a DM, so a call is
 * "post a mention in a text channel, then meet the human in a voice channel".
 */
export class DiscordChannel implements CommunicationChannel {
  readonly name = 'discord';
  readonly capabilities: ChannelCapabilities = { outbound: true, inbound: false };

  private readonly cfg: DiscordConfig;
  private readonly deps: DiscordChannelDeps;

  constructor(cfg: DiscordConfig, deps: DiscordChannelDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
  }

  /**
   * Logs a fresh client in and validates the configured guild/channels before handing back a
   * session. Misconfiguration throws a descriptive Error (configuration errors are allowed to
   * propagate out of the orchestrator); the client is always destroyed on that path.
   */
  async createSession(req: AskRequest): Promise<ChannelSession> {
    const client = this.deps.clientFactory?.() ?? createDefaultClient();

    try {
      await loginAndWaitReady(client, this.cfg.botToken);
      await this.validateTargets(client);

      return new DiscordSession({
        client,
        guildId: this.cfg.guildId,
        textChannelId: this.cfg.textChannelId,
        voiceChannelId: this.cfg.voiceChannelId,
        userId: this.cfg.userId,
        request: req,
      });
    } catch (error) {
      try {
        await client.destroy();
      } catch {
        // The original configuration error is what matters, not a teardown hiccup.
      }
      throw error;
    }
  }

  private async validateTargets(client: Client): Promise<void> {
    await client.guilds.fetch(this.cfg.guildId).catch((error: unknown) => {
      throw new Error(
        `Discord guild ${this.cfg.guildId} (settings.discord.guildId) could not be fetched; check the id and that the bot has been invited to that server.`,
        { cause: error },
      );
    });

    const textChannel = await fetchChannel(client, this.cfg.textChannelId, 'settings.discord.textChannelId');

    if (channelGuildId(textChannel) !== this.cfg.guildId) {
      throw new Error(
        `Discord channel ${this.cfg.textChannelId} (settings.discord.textChannelId) does not belong to guild ${this.cfg.guildId}.`,
      );
    }

    if (!textChannel.isSendable()) {
      throw new Error(
        `Discord channel ${this.cfg.textChannelId} (settings.discord.textChannelId) is not a text channel the bot can send messages to.`,
      );
    }

    const voiceChannel = await fetchChannel(client, this.cfg.voiceChannelId, 'settings.discord.voiceChannelId');

    if (channelGuildId(voiceChannel) !== this.cfg.guildId) {
      throw new Error(
        `Discord channel ${this.cfg.voiceChannelId} (settings.discord.voiceChannelId) does not belong to guild ${this.cfg.guildId}.`,
      );
    }

    if (voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error(
        `Discord channel ${this.cfg.voiceChannelId} (settings.discord.voiceChannelId) is not a regular voice channel (stage channels are not supported).`,
      );
    }
  }
}
