import { describe, expect, test } from 'bun:test';
import { settingsSchema, settingsFields } from '../../src/settings/schema.ts';

const validDiscord = {
  botToken: 'bot-token',
  guildId: 'guild-id',
  textChannelId: 'text-channel-id',
  voiceChannelId: 'voice-channel-id',
  userId: 'user-id',
};

describe('settingsSchema', () => {
  test('parses a valid full object', () => {
    const result = settingsSchema.safeParse({
      discord: validDiscord,
      elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id', ttsModel: 'custom-tts', sttModel: 'custom-stt' },
      call: {
        joinTimeoutMs: 5000,
        silenceMs: 1000,
        maxListenMs: 30000,
        confirmRounds: 2,
        affirmativeWords: ['yes'],
      },
      channel: 'discord',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.discord).toEqual(validDiscord);
      expect(result.data.elevenlabs.ttsModel).toBe('custom-tts');
      expect(result.data.call.joinTimeoutMs).toBe(5000);
      expect(result.data.channel).toBe('discord');
    }
  });

  test('applies defaults for call.*, elevenlabs models, and channel', () => {
    const result = settingsSchema.safeParse({
      discord: validDiscord,
      elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.elevenlabs.ttsModel).toBe('eleven_multilingual_v2');
      expect(result.data.elevenlabs.sttModel).toBe('scribe_v1');
      expect(result.data.call).toEqual({
        joinTimeoutMs: 120000,
        silenceMs: 1500,
        maxListenMs: 60000,
        confirmRounds: 3,
        affirmativeWords: ['yes', 'yeah', 'yep', 'correct', 'right', 'ja'],
        debugAudioDir: '',
      });
      expect(result.data.channel).toBe('discord');
    }
  });

  test('missing required fields produce a formatted error listing each path', () => {
    const result = settingsSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('discord');
      expect(paths).toContain('elevenlabs');
    }
  });
});

describe('settingsFields', () => {
  function findField(path: string) {
    const field = settingsFields.find((f) => f.path === path);
    if (!field) throw new Error(`no settingsField for path ${path}`);
    return field;
  }

  test('contains an entry for every leaf field', () => {
    const paths = settingsFields.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        'discord.botToken',
        'discord.guildId',
        'discord.textChannelId',
        'discord.voiceChannelId',
        'discord.userId',
        'elevenlabs.apiKey',
        'elevenlabs.voiceId',
        'elevenlabs.ttsModel',
        'elevenlabs.sttModel',
        'call.joinTimeoutMs',
        'call.silenceMs',
        'call.maxListenMs',
        'call.confirmRounds',
        'call.affirmativeWords',
        'call.debugAudioDir',
        'channel',
        'server.host',
        'server.port',
        'server.authToken',
      ].sort(),
    );
  });

  test('discord.botToken is secret and required', () => {
    const field = findField('discord.botToken');
    expect(field.secret).toBe(true);
    expect(field.required).toBe(true);
    expect(field.type).toBe('string');
  });

  test('call.joinTimeoutMs is a number with default 120000', () => {
    const field = findField('call.joinTimeoutMs');
    expect(field.type).toBe('number');
    expect(field.default).toBe(120000);
    expect(field.required).toBe(false);
  });

  test('call.affirmativeWords is a string[]', () => {
    const field = findField('call.affirmativeWords');
    expect(field.type).toBe('string[]');
    expect(field.default).toEqual(['yes', 'yeah', 'yep', 'correct', 'right', 'ja']);
  });

  test('elevenlabs.voiceId is not secret and is required', () => {
    const field = findField('elevenlabs.voiceId');
    expect(field.secret).toBe(false);
    expect(field.required).toBe(true);
  });

  test('every field has a non-empty description', () => {
    for (const field of settingsFields) {
      expect(field.description.length).toBeGreaterThan(0);
    }
  });

  test('channel field defaults to discord', () => {
    const field = findField('channel');
    expect(field.type).toBe('string');
    expect(field.default).toBe('discord');
    expect(field.required).toBe(false);
  });

  test('server fields have defaults and correct types', () => {
    expect(findField('server.host').default).toBe('127.0.0.1');
    expect(findField('server.port').default).toBe(3117);
    expect(findField('server.port').type).toBe('number');
    expect(findField('server.authToken').default).toBe('');
  });

  test('server.authToken is secret', () => {
    expect(findField('server.authToken').secret).toBe(true);
    expect(findField('server.authToken').required).toBe(false);
  });
});
