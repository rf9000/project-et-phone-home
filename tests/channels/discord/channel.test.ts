import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test } from 'bun:test';
import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import { DiscordChannel } from '../../../src/channels/discord/channel.ts';

const CFG = {
  botToken: 'never-logged',
  guildId: 'guild-1',
  textChannelId: 'text-1',
  voiceChannelId: 'voice-1',
  userId: 'user-1',
};

interface FakeClientBehavior {
  /** Drives what login() does; a promise that never settles models a hung gateway. */
  login: () => Promise<string>;
  /** Emits READY this many ms after login() is called. */
  emitReadyAfterMs?: number;
}

/**
 * The smallest client the channel touches: login/READY plus the fetches used for validation.
 * guilds.fetch always fails, so reaching it proves the ready gate let us through.
 */
class FakeClient extends EventEmitter {
  destroyCalls = 0;
  loginCalls = 0;

  readonly guilds = {
    fetch: async (): Promise<never> => {
      throw new Error('guild-fetch-rejected');
    },
  };

  readonly channels = {
    fetch: async (): Promise<null> => null,
  };

  constructor(private readonly behavior: FakeClientBehavior) {
    super();
  }

  isReady(): boolean {
    return false;
  }

  async login(_token: string): Promise<string> {
    this.loginCalls++;
    if (this.behavior.emitReadyAfterMs !== undefined) {
      setTimeout(() => this.emit(Events.ClientReady, this), this.behavior.emitReadyAfterMs);
    }
    return this.behavior.login();
  }

  async destroy(): Promise<void> {
    this.destroyCalls++;
  }
}

function channelWith(fake: FakeClient, readyTimeoutMs: number): DiscordChannel {
  return new DiscordChannel(CFG, {
    clientFactory: () => fake as unknown as Client,
    readyTimeoutMs,
  });
}

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

describe('DiscordChannel', () => {
  test('declares name and capabilities', () => {
    const channel = new DiscordChannel(CFG);
    expect(channel.name).toBe('discord');
    expect(channel.capabilities).toEqual({ outbound: true, inbound: false });
  });
});

describe('DiscordChannel ready gate', () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    unhandled.length = 0;
  });

  test('rejects cleanly when READY never arrives while login is still pending', async () => {
    const fake = new FakeClient({ login: neverSettles });

    await expect(channelWith(fake, 25).createSession({ question: 'q' })).rejects.toThrow(
      /did not become ready within 25 ms/,
    );
    expect(fake.destroyCalls).toBe(1);
  });

  // Regression: the gate can reject before anything awaits it. An unhandled rejection terminates
  // the process under Bun, so the gate must carry a handler from the moment it is armed.
  test('a login failure landing after the ready timeout does not go unhandled', async () => {
    process.on('unhandledRejection', onUnhandledRejection);

    let failLogin!: (error: Error) => void;
    const fake = new FakeClient({
      login: () =>
        new Promise<string>((_resolve, reject) => {
          failLogin = reject;
        }),
    });

    await expect(channelWith(fake, 20).createSession({ question: 'q' })).rejects.toThrow(
      /did not become ready/,
    );

    failLogin(new Error('gateway gave up long after the deadline'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(unhandled).toEqual([]);
  });

  test('reports a login failure without echoing the bot token', async () => {
    const fake = new FakeClient({
      login: () => Promise.reject(new Error('An invalid token was provided.')),
    });

    const error = await channelWith(fake, 5000).createSession({ question: 'q' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/check settings\.discord\.botToken/);
    expect((error as Error).message).not.toContain(CFG.botToken);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(fake.destroyCalls).toBe(1);
  });

  test('proceeds to target validation once READY arrives', async () => {
    const fake = new FakeClient({ login: async () => 'ok', emitReadyAfterMs: 5 });

    // guilds.fetch always rejects, so this message proves the gate opened and validation ran.
    await expect(channelWith(fake, 5000).createSession({ question: 'q' })).rejects.toThrow(
      /guild guild-1 \(settings\.discord\.guildId\) could not be fetched/,
    );
    expect(fake.loginCalls).toBe(1);
    expect(fake.destroyCalls).toBe(1);
  });

  test('skips login entirely for an already-ready client', async () => {
    const fake = new FakeClient({ login: neverSettles });
    fake.isReady = (): boolean => true;

    await expect(channelWith(fake, 25).createSession({ question: 'q' })).rejects.toThrow(
      /could not be fetched/,
    );
    expect(fake.loginCalls).toBe(0);
  });
});
