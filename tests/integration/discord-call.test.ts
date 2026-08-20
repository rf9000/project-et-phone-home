// Live integration test — NOT part of the normal unit-test suite's guarantees.
//
// This test places a REAL Discord call (real bot login, real voice-channel join) and makes
// REAL ElevenLabs API calls (both TTS and STT). It costs money and requires a human to be
// present and willing to join the configured Discord voice channel and answer out loud.
//
// It is gated on ETPH_LIVE_TEST=1 *and* credentials, so a bare `bun test` run skips it cleanly
// (describe.skipIf) rather than failing — or worse, silently placing a real call. Credentials
// alone are NOT enough on purpose: once a .env exists in the repo root, Bun auto-loads it for
// every `bun test`, and without the explicit opt-in each such run would ring the human's Discord
// and spend ElevenLabs credit.
//
// To run it for real:
//   1. Set ETPH_LIVE_TEST=1 (the explicit opt-in; put it on the command line, not in .env).
//   2. Set the following env vars (see src/settings/schema.ts for what each one configures):
//        ETPH_DISCORD_BOT_TOKEN
//        ETPH_DISCORD_GUILD_ID
//        ETPH_DISCORD_TEXT_CHANNEL_ID
//        ETPH_DISCORD_VOICE_CHANNEL_ID
//        ETPH_DISCORD_USER_ID
//        ETPH_ELEVENLABS_API_KEY
//        ETPH_ELEVENLABS_VOICE_ID
//   3. Have the Discord user identified by ETPH_DISCORD_USER_ID ready to join the configured
//      voice channel when the bot pings them in the configured text channel, and to answer
//      "two plus two" out loud (then confirm with "yes").
//   4. Run: ETPH_LIVE_TEST=1 bun test tests/integration/
//      (PowerShell: $env:ETPH_LIVE_TEST = '1'; bun test tests/integration/)
//
// Test 1 requires a human to actually join and answer. Test 2 is skipped by default (see the
// comment on it below) because it requires the human to deliberately NOT join, which would
// conflict with Test 1 in the same run.

import { describe, expect, test } from 'bun:test';
import { askHuman } from '../../src/core/ask-human.ts';
import { buildDefaultDeps } from '../../src/index.ts';
import { resolveSettings } from '../../src/settings/load.ts';
import type { AskStatus } from '../../src/types/index.ts';

const REQUIRED_ENV_VARS = [
  'ETPH_DISCORD_BOT_TOKEN',
  'ETPH_DISCORD_GUILD_ID',
  'ETPH_DISCORD_TEXT_CHANNEL_ID',
  'ETPH_DISCORD_VOICE_CHANNEL_ID',
  'ETPH_DISCORD_USER_ID',
  'ETPH_ELEVENLABS_API_KEY',
  'ETPH_ELEVENLABS_VOICE_ID',
] as const;

const hasCredentials = REQUIRED_ENV_VARS.every((name) => {
  const value = process.env[name];
  return value !== undefined && value !== '';
});

// Explicit opt-in on top of credentials: see the header comment for why credentials alone
// must never trigger a live call.
const liveTestEnabled = process.env.ETPH_LIVE_TEST === '1';

const VALID_STATUSES: AskStatus[] = ['answered', 'no_pickup', 'no_speech', 'not_confirmed', 'error'];

describe.skipIf(!liveTestEnabled || !hasCredentials)('Discord live call integration', () => {
  test(
    'live call — requires a human to answer',
    async () => {
      const settings = resolveSettings();
      const deps = buildDefaultDeps(settings);

      const result = await askHuman('What is two plus two?', settings, undefined, deps);

      // Full result is logged so a human running this test can eyeball the transcript.
      console.error('Live call result:', result);

      expect(VALID_STATUSES).toContain(result.status);
      if (result.answered) {
        expect(typeof result.answer).toBe('string');
        expect((result.answer as string).length).toBeGreaterThan(0);
      }
    },
    240_000,
  );

  // Skipped by default: exercising the no-pickup path requires the human to deliberately NOT
  // join the voice channel within the (short) joinTimeoutMs window below. Running this in the
  // same pass as Test 1 is inherently contradictory (join for one, don't join for the other),
  // so this is left as test.skip and must be run manually — comment it in (or change to
  // `test(...)`) and ask the human runner to ignore the ping for this run only.
  test.skip('no pickup times out cleanly', async () => {
    const settings = resolveSettings();
    const deps = buildDefaultDeps(settings);

    const result = await askHuman(
      'This should time out — please do not join the voice channel.',
      settings,
      { joinTimeoutMs: 5_000 },
      deps,
    );

    console.error('No-pickup result:', result);

    expect(result.status).toBe('no_pickup');
    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
  });
});
