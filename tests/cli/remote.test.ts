import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken: '' },
  });
}

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

let sb: Switchboard | undefined;
afterEach(async () => {
  await sb?.stop();
  sb = undefined;
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe('CLI remote mode (subprocess)', () => {
  test('answered remote ask: exit 0, pure JSON on stdout', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('four') });

    const run = await runCli([
      'ask', 'What is 2+2?',
      '--server', `http://127.0.0.1:${sb.port}`,
      '--user', 'user-1',
      '--json',
    ]);

    expect(run.exitCode).toBe(0);
    const body = JSON.parse(run.stdout) as HumanResponse;
    expect(body.answer).toBe('four');
  }, 20_000);

  test('unreachable server: exit 1, diagnostics on stderr, empty stdout', async () => {
    const run = await runCli(['ask', 'q?', '--server', 'http://127.0.0.1:9', '--user', 'u']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr.length).toBeGreaterThan(0);
  }, 20_000);
});
