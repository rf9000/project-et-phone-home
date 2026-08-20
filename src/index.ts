// Public library entry point: default wiring so integrators (TypeScript or otherwise, via the
// CLI) can call a human without hand-assembling channel/tts/stt dependencies themselves.

export * from './types/index.ts';

export { askHuman } from './core/ask-human.ts';
export type { AskDeps, AskOptions } from './core/ask-human.ts';
export { buildDefaultDeps } from './deps.ts';

export { resolveSettings } from './settings/load.ts';
export type { SettingsSources } from './settings/load.ts';
export { settingsSchema, settingsFields } from './settings/schema.ts';
export type { Settings, SettingsField } from './settings/schema.ts';

export { LoopbackChannel, LoopbackTts, LoopbackStt } from './channels/loopback.ts';
export type { LoopbackScript, LoopbackSession } from './channels/loopback.ts';

export { ElevenLabsTts } from './speech/elevenlabs/tts.ts';
export type { ElevenLabsTtsConfig, ElevenLabsTtsDeps } from './speech/elevenlabs/tts.ts';
export { ElevenLabsStt } from './speech/elevenlabs/stt.ts';
export type { ElevenLabsSttConfig, ElevenLabsSttDeps } from './speech/elevenlabs/stt.ts';

export { DumpingStt } from './speech/debug.ts';

export { DiscordChannel } from './channels/discord/channel.ts';
export type { DiscordChannelDeps, DiscordConfig } from './channels/discord/channel.ts';

import { askHuman } from './core/ask-human.ts';
import { resolveSettings } from './settings/load.ts';
import type { Settings } from './settings/schema.ts';
import { buildDefaultDeps } from './deps.ts';
import type { HumanResponse } from './types/index.ts';

/**
 * One-liner integrators call: resolves settings (env fills in whatever `settings` omits),
 * builds the default production deps, and calls askHuman. Never rejects except on
 * configuration errors (invalid/missing settings), which propagate from resolveSettings.
 */
export async function ask(
  question: string,
  settings?: Partial<Settings> | undefined,
): Promise<HumanResponse> {
  const resolved = resolveSettings({ object: settings });
  const deps = buildDefaultDeps(resolved);
  return askHuman(question, resolved, undefined, deps);
}
