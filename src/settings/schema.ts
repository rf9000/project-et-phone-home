import { z } from 'zod';

export const settingsSchema = z.object({
  discord: z
    .object({
      botToken: z.string().min(1).describe('Discord bot token used to authenticate the bot.'),
      guildId: z.string().min(1).describe('Discord server (guild) ID the bot operates in.'),
      textChannelId: z
        .string()
        .min(1)
        .describe('Discord text channel ID used to notify the human that a question is waiting.'),
      voiceChannelId: z
        .string()
        .min(1)
        .describe('Discord voice channel ID the bot joins to speak the question and listen for an answer.'),
      userId: z.string().min(1).describe('Discord user ID of the human to call.'),
    })
    .describe('Discord connection settings.'),
  elevenlabs: z
    .object({
      apiKey: z.string().min(1).describe('ElevenLabs API key.'),
      voiceId: z.string().min(1).describe('ElevenLabs voice ID used to synthesize the question.'),
      ttsModel: z
        .string()
        .min(1)
        .default('eleven_multilingual_v2')
        .describe('ElevenLabs text-to-speech model ID.'),
      sttModel: z.string().min(1).default('scribe_v1').describe('ElevenLabs speech-to-text model ID.'),
    })
    .describe('ElevenLabs text-to-speech / speech-to-text settings.'),
  call: z
    .object({
      joinTimeoutMs: z
        .number()
        .default(120000)
        .describe('Milliseconds to wait for the human to join the voice channel before giving up.'),
      silenceMs: z
        .number()
        .default(1500)
        .describe('Milliseconds of silence that marks the end of the human speaking.'),
      maxListenMs: z
        .number()
        .default(60000)
        .describe('Maximum milliseconds to listen for a response before giving up.'),
      confirmRounds: z
        .number()
        .default(3)
        .describe('Maximum number of rounds spent confirming the transcribed answer with the human.'),
      affirmativeWords: z
        .array(z.string())
        .default(['yes', 'yeah', 'yep', 'correct', 'right', 'ja'])
        .describe('Words treated as an affirmative confirmation from the human.'),
    })
    .default({
      joinTimeoutMs: 120000,
      silenceMs: 1500,
      maxListenMs: 60000,
      confirmRounds: 3,
      affirmativeWords: ['yes', 'yeah', 'yep', 'correct', 'right', 'ja'],
    })
    .describe('Call flow behavior settings.'),
  channel: z
    .literal('discord')
    .default('discord')
    .describe('Communication channel to use for asking the human. Currently only "discord" is supported.'),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface SettingsField {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description: string;
  secret: boolean;
  default?: unknown;
  required: boolean;
}

/** Field paths whose values must be treated as secrets (never logged, masked in UIs). */
const SECRET_PATHS = new Set<string>(['discord.botToken', 'elevenlabs.apiKey']);

interface UnwrapResult {
  base: z.ZodTypeAny;
  defaultValue: unknown;
  hasDefault: boolean;
}

/** Peels ZodDefault/ZodOptional wrappers to find the underlying base schema. */
function unwrapToBase(schema: z.ZodTypeAny): UnwrapResult {
  let current: z.ZodTypeAny = schema;
  let defaultValue: unknown;
  let hasDefault = false;

  for (;;) {
    const def = current.def as { type: string; innerType?: z.ZodTypeAny; defaultValue?: unknown };
    if (def.type === 'default') {
      hasDefault = true;
      defaultValue = def.defaultValue;
      current = def.innerType as z.ZodTypeAny;
      continue;
    }
    if (def.type === 'optional') {
      current = def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { base: current, defaultValue, hasDefault };
}

function inferFieldType(base: z.ZodTypeAny): SettingsField['type'] {
  const def = base.def as { type: string; values?: unknown[] };
  switch (def.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'string[]';
    case 'literal': {
      const value = def.values?.[0];
      if (typeof value === 'number') return 'number';
      if (typeof value === 'boolean') return 'boolean';
      return 'string';
    }
    default:
      throw new Error(`settingsFields: unsupported schema node type "${def.type}"`);
  }
}

function walkShape(shape: Record<string, z.ZodTypeAny>, prefix: string, out: SettingsField[]): void {
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const { base, defaultValue, hasDefault } = unwrapToBase(fieldSchema);

    if (base instanceof z.ZodObject) {
      walkShape(base.shape as Record<string, z.ZodTypeAny>, path, out);
      continue;
    }

    const description = fieldSchema.description ?? base.description ?? '';

    out.push({
      path,
      type: inferFieldType(base),
      description,
      secret: SECRET_PATHS.has(path),
      ...(hasDefault ? { default: defaultValue } : {}),
      required: !hasDefault,
    });
  }
}

function buildSettingsFields(): SettingsField[] {
  const fields: SettingsField[] = [];
  walkShape(settingsSchema.shape as Record<string, z.ZodTypeAny>, '', fields);
  return fields;
}

export const settingsFields: SettingsField[] = buildSettingsFields();
