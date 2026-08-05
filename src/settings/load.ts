import * as fs from 'node:fs';
import { settingsSchema, settingsFields } from './schema.ts';
import type { Settings, SettingsField } from './schema.ts';

export interface SettingsSources {
  object?: unknown; // programmatic partial settings
  filePath?: string; // JSON file with partial settings
  env?: Record<string, string | undefined>; // injectable for tests; default process.env
  envPrefix?: string; // default 'ETPH'
}

const DEFAULT_ENV_PREFIX = 'ETPH';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts a camelCase path segment into UPPER_SNAKE_CASE. */
function segmentToUpperSnake(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Derives the env var name for a settings field path, e.g. discord.botToken -> ETPH_DISCORD_BOT_TOKEN. */
function pathToEnvVar(path: string, prefix: string): string {
  const parts = path.split('.').map(segmentToUpperSnake);
  return [prefix, ...parts].join('_');
}

function coerceEnvValue(type: SettingsField['type'], raw: string): unknown {
  switch (type) {
    case 'number':
      return Number(raw);
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return raw;
    case 'string[]':
      return raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    case 'string':
      return raw;
    default:
      return raw;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    const existing = cursor[segment];
    if (!isPlainObject(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  cursor[last] = value;
}

function envToPartialSettings(
  fields: SettingsField[],
  env: Record<string, string | undefined>,
  prefix: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const envVar = pathToEnvVar(field.path, prefix);
    const raw = env[envVar];
    if (raw === undefined) continue;
    setPath(result, field.path, coerceEnvValue(field.type, raw));
  }
  return result;
}

/** Deep-merges plain objects (recursively); arrays and scalars from `overlay` replace `base`. */
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function formatValidationError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const lines = error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  return `Invalid configuration:\n${lines.join('\n')}`;
}

export function resolveSettings(sources: SettingsSources = {}): Settings {
  const env = sources.env ?? process.env;
  const prefix = sources.envPrefix ?? DEFAULT_ENV_PREFIX;

  let merged: Record<string, unknown> = envToPartialSettings(settingsFields, env, prefix);

  if (sources.filePath !== undefined) {
    const raw = fs.readFileSync(sources.filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      const type = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed;
      throw new Error(`Config file must contain a JSON object, got ${type}: ${sources.filePath}`);
    }
    merged = deepMerge(merged, parsed);
  }

  if (sources.object !== undefined && isPlainObject(sources.object)) {
    merged = deepMerge(merged, sources.object);
  }

  const result = settingsSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(formatValidationError(result.error));
  }
  return result.data;
}
