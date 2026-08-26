#!/usr/bin/env bun
// CLI entry point: lets any agent workflow (TypeScript or not) shell out to `et-phone-home ask`
// instead of importing the library. stdout carries only the machine-readable answer (or JSON);
// everything else — usage, progress, diagnostics — goes to stderr.

import { text } from 'node:stream/consumers';
import { askHuman } from '../core/ask-human.ts';
import { buildDefaultDeps } from '../index.ts';
import { resolveSettings } from '../settings/load.ts';
import { settingsFields } from '../settings/schema.ts';
import { startSwitchboard } from '../server/http.ts';
import { SwitchboardClient, SwitchboardJobEndedError } from '../server/client.ts';
import { makeDefaultRunAsk } from '../server/run-ask.ts';
import type { AskJobRequest } from '../server/queue.ts';
import type { AskOptions } from '../core/ask-human.ts';
import type { Settings, SettingsField } from '../settings/schema.ts';
import type { HumanResponse } from '../types/index.ts';

const ENV_PREFIX = 'ETPH';

export type CliCommand = 'ask' | 'help' | 'serve';

export interface ParsedArgs {
  command: CliCommand | undefined;
  question?: string;
  json: boolean;
  configPath?: string;
  timeoutSeconds?: number;
  server?: string;
  user?: string;
  queueTimeoutSeconds?: number;
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
  let server: string | undefined;
  let user: string | undefined;
  let queueTimeoutSeconds: number | undefined;

  const rest = [...argv];
  const first = rest[0];

  if (first === undefined) {
    command = 'help';
  } else if (first === 'help' || first === '--help') {
    command = 'help';
    rest.shift();
  } else if (first === 'serve') {
    command = 'serve';
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

    if (arg === '--server') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--server requires a value');
      } else {
        server = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--user') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--user requires a value');
      } else {
        user = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--queue-timeout') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--queue-timeout requires a value');
      } else {
        const parsedSeconds = Number(value);
        if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
          errors.push(`--queue-timeout must be a positive number, got: ${value}`);
        } else {
          queueTimeoutSeconds = parsedSeconds;
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

  if (user !== undefined && server === undefined) errors.push('--user requires --server');
  if (server !== undefined && configPath !== undefined) errors.push('--config cannot be combined with --server');
  if (command === 'ask' && server !== undefined && user === undefined) {
    errors.push('--user is required with --server');
  }

  return { command, question, json, configPath, timeoutSeconds, server, user, queueTimeoutSeconds, errors };
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
    '  et-phone-home serve               Run the switchboard daemon (queue + HTTP API)',
    '  et-phone-home help                Show this help',
    '',
    'Flags:',
    '  --json                Print the full HumanResponse as JSON instead of plain text',
    '  --config <path>       Path to a JSON settings file (overrides env vars)',
    '  --timeout <seconds>   Seconds to wait for pickup (overrides call.joinTimeoutMs)',
    '  --server <url>        Send the ask to a running switchboard instead of calling directly',
    '  --user <id>           Discord user ID to call (required with --server)',
    '  --queue-timeout <s>   Seconds the ask may wait in the switchboard queue before expiring',
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
  // node:stream/consumers rather than Bun.stdin so `ask` also runs under Node, which is the
  // runtime that survives a network whose IPv6 does not route (see README, "Runtime notes").
  const input = await text(process.stdin);
  return input.trim();
}

function printResult(result: HumanResponse, parsed: ParsedArgs): 0 | 2 {
  // Diagnostics go to stderr in both modes so stdout stays purely machine-readable.
  if (result.error !== undefined) {
    process.stderr.write(`Call failed: ${result.error}\n`);
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

async function runAsk(parsed: ParsedArgs): Promise<number> {
  const question = (parsed.question ?? (await readQuestionFromStdin())).trim();

  if (question === '') {
    process.stderr.write('Usage error: no question provided (pass it as an argument or via stdin).\n');
    return 1;
  }

  if (parsed.server !== undefined) {
    const client = new SwitchboardClient({
      baseUrl: parsed.server,
      authToken: process.env.ETPH_SERVER_AUTH_TOKEN,
    });

    let result: HumanResponse;
    try {
      result = await client.ask(question, {
        userId: parsed.user as string, // parser guarantees presence with --server
        ...(parsed.queueTimeoutSeconds !== undefined
          ? { queueTimeoutMs: parsed.queueTimeoutSeconds * 1000 }
          : {}),
        ...(parsed.timeoutSeconds !== undefined
          ? { call: { joinTimeoutMs: parsed.timeoutSeconds * 1000 } }
          : {}),
      });
    } catch (error) {
      if (error instanceof SwitchboardJobEndedError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }

    return printResult(result, parsed);
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

  return printResult(result, parsed);
}

async function runServe(parsed: ParsedArgs): Promise<number> {
  let settings: Settings;
  try {
    settings = resolveSettings({ filePath: parsed.configPath });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // A daemon whose terminal says nothing about the calls it places is undiagnosable, so wrap the
  // production call-placer to log each job's start and outcome. Diagnostics go to stderr; the
  // daemon writes nothing to stdout at all.
  const placeCall = makeDefaultRunAsk(settings);
  const runAskLogged = async (request: AskJobRequest): Promise<HumanResponse> => {
    const started = Date.now();
    process.stderr.write(`[call] start user=${request.userId} question=${JSON.stringify(request.question)}\n`);
    const result = await placeCall(request);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const detail = result.error === undefined ? '' : ` error=${result.error}`;
    process.stderr.write(`[call] end   user=${request.userId} status=${result.status} in ${seconds}s${detail}\n`);
    return result;
  };

  let switchboard: ReturnType<typeof startSwitchboard>;
  try {
    switchboard = startSwitchboard(settings, { runAsk: runAskLogged });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  process.stderr.write(`switchboard listening on http://${settings.server.host}:${switchboard.port}\n`);
  // Serve until the process is terminated (Ctrl+C / service manager).
  await new Promise<never>(() => {});
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

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

  if (parsed.command === 'serve') return runServe(parsed);

  return runAsk(parsed);
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
