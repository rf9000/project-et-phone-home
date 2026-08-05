import { describe, expect, test } from 'bun:test';
import { exitCodeFor, formatEnvHelp, parseArgs } from '../../src/cli/index.ts';
import type { HumanResponse } from '../../src/types/index.ts';
import type { SettingsField } from '../../src/settings/schema.ts';

describe('parseArgs — ask command', () => {
  test('reads the question from argv', () => {
    const parsed = parseArgs(['ask', 'what is the meaning of life?']);

    expect(parsed.command).toBe('ask');
    expect(parsed.question).toBe('what is the meaning of life?');
    expect(parsed.json).toBe(false);
    expect(parsed.configPath).toBeUndefined();
    expect(parsed.timeoutSeconds).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  test('question is undefined when omitted (stdin path taken by the caller)', () => {
    const parsed = parseArgs(['ask']);

    expect(parsed.command).toBe('ask');
    expect(parsed.question).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });
});

describe('parseArgs — flags', () => {
  test('parses --json, --config, and --timeout', () => {
    const parsed = parseArgs(['ask', 'q', '--json', '--config', 'settings.json', '--timeout', '30']);

    expect(parsed.command).toBe('ask');
    expect(parsed.question).toBe('q');
    expect(parsed.json).toBe(true);
    expect(parsed.configPath).toBe('settings.json');
    expect(parsed.timeoutSeconds).toBe(30);
    expect(parsed.errors).toEqual([]);
  });

  test('flags can appear before the question', () => {
    const parsed = parseArgs(['ask', '--json', '--timeout', '5', 'q']);

    expect(parsed.question).toBe('q');
    expect(parsed.json).toBe(true);
    expect(parsed.timeoutSeconds).toBe(5);
  });

  test('unknown flag produces an error entry', () => {
    const parsed = parseArgs(['ask', 'q', '--bogus']);

    expect(parsed.errors).toEqual(['Unknown flag: --bogus']);
  });

  test('--config without a value produces an error entry', () => {
    const parsed = parseArgs(['ask', 'q', '--config']);

    expect(parsed.errors).toEqual(['--config requires a value']);
  });

  test('--timeout with a non-numeric value produces an error entry', () => {
    const parsed = parseArgs(['ask', 'q', '--timeout', 'soon']);

    expect(parsed.errors).toEqual(['--timeout must be a positive number, got: soon']);
    expect(parsed.timeoutSeconds).toBeUndefined();
  });

  test('unknown command produces an error entry', () => {
    const parsed = parseArgs(['bogus-command']);

    expect(parsed.errors).toEqual(['Unknown command: bogus-command']);
  });
});

describe('parseArgs — help', () => {
  test('no arguments -> help command, no errors', () => {
    const parsed = parseArgs([]);

    expect(parsed.command).toBe('help');
    expect(parsed.errors).toEqual([]);
  });

  test('"help" -> help command', () => {
    const parsed = parseArgs(['help']);
    expect(parsed.command).toBe('help');
  });

  test('"--help" -> help command', () => {
    const parsed = parseArgs(['--help']);
    expect(parsed.command).toBe('help');
  });

  test('"ask ... --help" -> help command overrides ask', () => {
    const parsed = parseArgs(['ask', 'q', '--help']);
    expect(parsed.command).toBe('help');
  });
});

describe('exitCodeFor', () => {
  function response(overrides: Partial<HumanResponse>): HumanResponse {
    return {
      answered: false,
      answer: null,
      status: 'no_pickup',
      channel: 'discord',
      durationMs: 0,
      ...overrides,
    };
  }

  test('answered -> 0', () => {
    expect(exitCodeFor(response({ answered: true, answer: 'yes', status: 'answered' }))).toBe(0);
  });

  test.each(['no_pickup', 'no_speech', 'not_confirmed', 'error'] as const)(
    'status %s -> 2',
    (status) => {
      expect(exitCodeFor(response({ answered: false, answer: null, status }))).toBe(2);
    },
  );
});

describe('formatEnvHelp', () => {
  const fields: SettingsField[] = [
    {
      path: 'discord.botToken',
      type: 'string',
      description: 'Discord bot token used to authenticate the bot.',
      secret: true,
      required: true,
    },
    {
      path: 'call.joinTimeoutMs',
      type: 'number',
      description: 'Milliseconds to wait for the human to join the voice channel before giving up.',
      secret: false,
      default: 120000,
      required: false,
    },
  ];

  test('derives ETPH_ env var names from field paths', () => {
    const help = formatEnvHelp(fields);

    expect(help).toContain('ETPH_DISCORD_BOT_TOKEN');
    expect(help).toContain('ETPH_CALL_JOIN_TIMEOUT_MS');
  });

  test('marks secret fields and shows required/default annotations', () => {
    const help = formatEnvHelp(fields);

    expect(help).toContain('secret');
    expect(help).toContain('required');
    expect(help).toContain('default: 120000');
  });

  test('includes each field description', () => {
    const help = formatEnvHelp(fields);

    expect(help).toContain('Discord bot token used to authenticate the bot.');
    expect(help).toContain('Milliseconds to wait for the human to join the voice channel before giving up.');
  });
});
