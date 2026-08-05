#!/usr/bin/env bun
// CLI entry point: lets any agent workflow (TypeScript or not) shell out to `et-phone-home ask`
// instead of importing the library. stdout carries only the machine-readable answer (or JSON);
// everything else — usage, progress, diagnostics — goes to stderr.

import { askHuman } from '../core/ask-human.ts';
import { buildDefaultDeps } from '../index.ts';
import { resolveSettings } from '../settings/load.ts';
import { settingsFields } from '../settings/schema.ts';
import type { AskOptions } from '../core/ask-human.ts';
import type { Settings, SettingsField } from '../settings/schema.ts';
import type { HumanResponse } from '../types/index.ts';

const ENV_PREFIX = 'ETPH';

export type CliCommand = 'ask' | 'help';

export interface ParsedArgs {
  command: CliCommand | undefined;
  question?: string;
  json: boolean;
  configPath?: string;
  timeoutSeconds?: number;
  errors: string[];
}

/** Converts a camelCase path segment into UPPER_SNAKE_CASE (mirrors settings/load.ts). */
function segmentToUpperSnake(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Derives the env var name for a settings field path, e.g. discord.botToken -> ETPH_DISCORD_BOT_TOKEN. */
function pathToEnvVar(path: string): string {
  const parts = path.split('.').map(segmentToUpperSnake);
  return [ENV_PREFIX, ...parts].join('_');
}

/** Hand-rolled argv parser: no CLI framework, matches the old template's style. */
export function parseArgs(argv: string[]): ParsedArgs {
  const errors: string[] = [];
  let command: CliCommand | undefined;
  let question: string | undefined;
  let json = false;
  let configPath: string | undefined;
  let timeoutSeconds: number | undefined;

  const rest = [...argv];
  const first = rest[0];

  if (first === undefined) {
    command = 'help';
  } else if (first === 'help' || first === '--help') {
    command = 'help';
    rest.shift();
  } else if (first === 'ask') {
    command = 'ask';
    rest.shift();
  } else {
    errors.push(`Unknown command: ${first}`);
    rest.shift();
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;

    if (arg === '--help') {
      command = 'help';
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--config') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--config requires a value');
      } else {
        configPath = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--timeout') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--timeout requires a value');
      } else {
        const parsedSeconds = Number(value);
        if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
          errors.push(`--timeout must be a positive number, got: ${value}`);
        } else {
          timeoutSeconds = parsedSeconds;
        }
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--')) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    if (command === 'ask' && question === undefined) {
      question = arg;
      continue;
    }

    errors.push(`Unexpected argument: ${arg}`);
  }

  return { command, question, json, configPath, timeoutSeconds, errors };
}

/** Maps a HumanResponse to the process exit code: 0 when answered, 2 otherwise. */
export function exitCodeFor(result: HumanResponse): 0 | 2 {
  return result.answered ? 0 : 2;
}

/** Renders one line of env-var help per settings field: name, description, secret/required/default. */
export function formatEnvHelp(fields: SettingsField[]): string {
  return fields
    .map((field) => {
      const envVar = pathToEnvVar(field.path);
      const notes: string[] = [];
      if (field.secret) notes.push('secret');
      notes.push(field.required ? 'required' : `default: ${JSON.stringify(field.default)}`);
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      return `  ${envVar}\n      ${field.description}${suffix}`;
    })
    .join('\n');
}

function usage(): string {
  return [
    'et-phone-home — call a human on Discord voice; get a spoken answer back as text.',
    '',
    'Usage:',
    '  et-phone-home ask "<question>"    Ask a question (reads stdin if omitted)',
    '  et-phone-home help                Show this help',
    '',
    'Flags:',
    '  --json                Print the full HumanResponse as JSON instead of plain text',
    '  --config <path>       Path to a JSON settings file (overrides env vars)',
    '  --timeout <seconds>   Seconds to wait for pickup (overrides call.joinTimeoutMs)',
    '',
    'Exit codes:',
    '  0   answered',
    '  2   not answered (no_pickup / no_speech / not_confirmed / error)',
    '  1   usage or configuration error',
    '',
    'Environment variables (ETPH_ prefix; --config file values take precedence):',
    formatEnvHelp(settingsFields),
    '',
  ].join('\n');
}

async function readQuestionFromStdin(): Promise<string> {
  const text = await Bun.stdin.text();
  return text.trim();
}

async function runAsk(parsed: ParsedArgs): Promise<number> {
  const question = (parsed.question ?? (await readQuestionFromStdin())).trim();

  if (question === '') {
    process.stderr.write('Usage error: no question provided (pass it as an argument or via stdin).\n');
    return 1;
  }

  let settings: Settings;
  try {
    settings = resolveSettings({ filePath: parsed.configPath });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const deps = buildDefaultDeps(settings);
  const opts: AskOptions | undefined =
    parsed.timeoutSeconds !== undefined ? { joinTimeoutMs: parsed.timeoutSeconds * 1000 } : undefined;

  let result: HumanResponse;
  try {
    result = await askHuman(question, settings, opts, deps);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.answered && result.answer !== null) {
    process.stdout.write(`${result.answer}\n`);
  } else {
    process.stderr.write(`Not answered (status: ${result.status}).\n`);
  }

  return exitCodeFor(result);
}

async function main(): Promise<number> {
  const parsed = parseArgs(Bun.argv.slice(2));

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      process.stderr.write(`${error}\n`);
    }
    process.stderr.write(`\n${usage()}\n`);
    return 1;
  }

  if (parsed.command === 'help' || parsed.command === undefined) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  return runAsk(parsed);
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
