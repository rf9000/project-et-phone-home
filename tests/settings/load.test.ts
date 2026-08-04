import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSettings } from '../../src/settings/load.ts';

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ETPH_DISCORD_BOT_TOKEN: 'bot-token',
    ETPH_DISCORD_GUILD_ID: 'guild-id',
    ETPH_DISCORD_TEXT_CHANNEL_ID: 'text-channel-id',
    ETPH_DISCORD_VOICE_CHANNEL_ID: 'voice-channel-id',
    ETPH_DISCORD_USER_ID: 'user-id',
    ETPH_ELEVENLABS_API_KEY: 'api-key',
    ETPH_ELEVENLABS_VOICE_ID: 'voice-id',
    ...overrides,
  };
}

describe('resolveSettings — env only', () => {
  test('resolves from an injected env object', () => {
    const settings = resolveSettings({ env: baseEnv() });

    expect(settings.discord.botToken).toBe('bot-token');
    expect(settings.discord.guildId).toBe('guild-id');
    expect(settings.elevenlabs.apiKey).toBe('api-key');
    expect(settings.elevenlabs.ttsModel).toBe('eleven_multilingual_v2');
    expect(settings.call.joinTimeoutMs).toBe(120000);
    expect(settings.channel).toBe('discord');
  });

  test('coerces ETPH_CALL_JOIN_TIMEOUT_MS to a number', () => {
    const settings = resolveSettings({
      env: baseEnv({ ETPH_CALL_JOIN_TIMEOUT_MS: '5000' }),
    });

    expect(settings.call.joinTimeoutMs).toBe(5000);
    expect(typeof settings.call.joinTimeoutMs).toBe('number');
  });

  test('parses comma-separated affirmativeWords env var', () => {
    const settings = resolveSettings({
      env: baseEnv({ ETPH_CALL_AFFIRMATIVE_WORDS: 'yes,yep, sure ,ok' }),
    });

    expect(settings.call.affirmativeWords).toEqual(['yes', 'yep', 'sure', 'ok']);
  });

  test('throws a formatted error when required fields are missing', () => {
    expect(() => resolveSettings({ env: {} })).toThrow(/^Invalid configuration:\n(  - .+\n?)+$/);
  });

  test('supports a custom env prefix', () => {
    const env = baseEnv();
    const renamed: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      renamed[key.replace(/^ETPH_/, 'CUSTOM_')] = value;
    }

    const settings = resolveSettings({ env: renamed, envPrefix: 'CUSTOM' });
    expect(settings.discord.botToken).toBe('bot-token');
  });
});

describe('resolveSettings — file precedence over env', () => {
  test('file values override env values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etph-settings-'));
    const filePath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        discord: { botToken: 'file-bot-token' },
      }),
    );

    const settings = resolveSettings({ env: baseEnv(), filePath });

    expect(settings.discord.botToken).toBe('file-bot-token');
    expect(settings.discord.guildId).toBe('guild-id'); // still from env

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('throws when filePath is explicitly given but missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etph-settings-'));
    const missingPath = path.join(dir, 'does-not-exist.json');

    expect(() => resolveSettings({ env: baseEnv(), filePath: missingPath })).toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('skips file merge when no filePath is given', () => {
    const settings = resolveSettings({ env: baseEnv() });
    expect(settings.discord.botToken).toBe('bot-token');
  });
});

describe('resolveSettings — object precedence over file and env', () => {
  test('object values win over file and env values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etph-settings-'));
    const filePath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        discord: { botToken: 'file-bot-token' },
      }),
    );

    const settings = resolveSettings({
      env: baseEnv(),
      filePath,
      object: { discord: { botToken: 'object-bot-token' } },
    });

    expect(settings.discord.botToken).toBe('object-bot-token');
    expect(settings.discord.guildId).toBe('guild-id'); // still from env, untouched by object override

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveSettings — error formatting', () => {
  test('formats each validation issue on its own line', () => {
    try {
      resolveSettings({ env: {} });
      throw new Error('expected resolveSettings to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message.startsWith('Invalid configuration:\n')).toBe(true);
      expect(message).toContain('  - discord:');
    }
  });
});
