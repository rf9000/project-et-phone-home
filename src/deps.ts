// Default production wiring, in its own module so src/server/* can use it without importing
// src/index.ts (which re-exports the server modules — that would be an import cycle).

import type { AskDeps } from './core/ask-human.ts';
import type { Settings } from './settings/schema.ts';
import { DiscordChannel } from './channels/discord/channel.ts';
import { ElevenLabsTts } from './speech/elevenlabs/tts.ts';
import { ElevenLabsStt } from './speech/elevenlabs/stt.ts';
import { DumpingStt } from './speech/debug.ts';

/**
 * Builds the production dependency set implied by `settings`: the channel named by
 * `settings.channel` (currently only 'discord') plus ElevenLabs TTS/STT. This is the wiring
 * `ask()` uses; exported separately so callers who want askHuman directly can still get the
 * default deps without re-deriving them.
 */
export function buildDefaultDeps(settings: Settings): AskDeps {
  const channel = new DiscordChannel(settings.discord);
  const tts = new ElevenLabsTts({
    apiKey: settings.elevenlabs.apiKey,
    voiceId: settings.elevenlabs.voiceId,
    model: settings.elevenlabs.ttsModel,
  });
  const elevenLabsStt = new ElevenLabsStt({
    apiKey: settings.elevenlabs.apiKey,
    model: settings.elevenlabs.sttModel,
  });
  // With debugAudioDir set, every captured utterance is also written to disk as a WAV so a
  // human can hear exactly what the bot heard when a transcript comes back wrong.
  const stt =
    settings.call.debugAudioDir === ''
      ? elevenLabsStt
      : new DumpingStt(elevenLabsStt, settings.call.debugAudioDir);

  return { channel, tts, stt };
}
