import { describe, expect, test } from 'bun:test';
import { askHuman } from '../../src/core/ask-human.ts';
import { LoopbackChannel, LoopbackStt, LoopbackTts } from '../../src/channels/loopback.ts';
import { settingsSchema, type Settings } from '../../src/settings/schema.ts';
import type { AskDeps } from '../../src/core/ask-human.ts';
import type { LoopbackScript } from '../../src/channels/loopback.ts';
import type {
  AskRequest,
  AudioData,
  ChannelCapabilities,
  ChannelSession,
  CommunicationChannel,
  TextToSpeech,
} from '../../src/types/index.ts';

function mockSettings(overrides: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'user-id',
    },
    elevenlabs: {
      apiKey: 'api-key',
      voiceId: 'voice-id',
    },
    ...overrides,
  });
}

function makeDeps(script: { pickUp: boolean; utterances: Array<string | null> }): {
  channel: LoopbackChannel;
  deps: AskDeps;
} {
  const channel = new LoopbackChannel(script);
  const deps: AskDeps = { channel, tts: new LoopbackTts(), stt: new LoopbackStt() };
  return { channel, deps };
}

describe('askHuman — happy path', () => {
  test('pickup, answer, confirm yes -> answered', async () => {
    const { channel, deps } = makeDeps({ pickUp: true, utterances: ['four', 'yes'] });

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(true);
    expect(result.answer).toBe('four');
    expect(result.status).toBe('answered');
    expect(result.channel).toBe('loopback');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(channel.lastSession?.hungUp).toBe(true);
    expect(channel.lastSession?.rang).toBe(true);
    expect(channel.lastSession?.ringCount).toBe(1);
    expect(channel.lastSession?.spokenTexts[0]).toBe('what is 2+2?');
    expect(channel.lastSession?.spokenTexts[1]).toBe(
      'I heard: "four" — is that correct? Please answer yes or no.',
    );
  });

  test('ring() happens before waitForHuman is asked to resolve pickup', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({ pickUp: true, utterances: ['four', 'yes'] });
    const innerSession = await deps.channel.createSession({ question: 'q' });
    const orderedSession: ChannelSession = {
      ring: async () => {
        order.push('ring');
        await innerSession.ring();
      },
      waitForHuman: async (timeoutMs) => {
        order.push('waitForHuman');
        return innerSession.waitForHuman(timeoutMs);
      },
      speak: (audio) => innerSession.speak(audio),
      listen: (opts) => innerSession.listen(opts),
      hangUp: () => innerSession.hangUp(),
    };
    const orderedChannel: CommunicationChannel = {
      name: 'ordered',
      capabilities: { outbound: true, inbound: false },
      createSession: async () => orderedSession,
    };

    await askHuman('what is 2+2?', mockSettings(), undefined, {
      channel: orderedChannel,
      tts: new LoopbackTts(),
      stt: new LoopbackStt(),
    });

    expect(order).toEqual(['ring', 'waitForHuman']);
  });
});

describe('askHuman — no pickup', () => {
  test('human never joins -> no_pickup', async () => {
    const { channel, deps } = makeDeps({ pickUp: false, utterances: [] });

    const result = await askHuman('anyone there?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.status).toBe('no_pickup');
    expect(channel.lastSession?.hungUp).toBe(true);
  });
});

describe('askHuman — total silence', () => {
  test('no speech at all -> no_speech', async () => {
    const { channel, deps } = makeDeps({ pickUp: true, utterances: [null] });

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.status).toBe('no_speech');
    expect(channel.lastSession?.hungUp).toBe(true);
  });
});

describe('askHuman — confirm says no, then re-answer, then yes', () => {
  test('resolves with the second transcript', async () => {
    const { channel, deps } = makeDeps({
      pickUp: true,
      utterances: ['four', 'no', 'five', 'yes'],
    });

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(true);
    expect(result.answer).toBe('five');
    expect(result.status).toBe('answered');
    expect(channel.lastSession?.spokenTexts).toEqual([
      'what is 2+2?',
      'I heard: "four" — is that correct? Please answer yes or no.',
      'Okay, please repeat your answer.',
      'I heard: "five" — is that correct? Please answer yes or no.',
    ]);
  });
});

describe('askHuman — silence during confirm exhausts rounds', () => {
  test('never confirms -> not_confirmed', async () => {
    const { channel, deps } = makeDeps({
      pickUp: true,
      utterances: ['four', null, null, null],
    });

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.status).toBe('not_confirmed');
    expect(channel.lastSession?.hungUp).toBe(true);
    // one confirm prompt per round (default confirmRounds = 3), same transcript re-confirmed each time
    expect(channel.lastSession?.spokenTexts).toEqual([
      'what is 2+2?',
      'I heard: "four" — is that correct? Please answer yes or no.',
      'I heard: "four" — is that correct? Please answer yes or no.',
      'I heard: "four" — is that correct? Please answer yes or no.',
    ]);
  });
});

describe('askHuman — affirmative word-boundary matching', () => {
  test('"yesterday" must not match "yes"', async () => {
    const { channel, deps } = makeDeps({
      pickUp: true,
      utterances: ['four', 'yesterday', 'yes', 'yes'],
    });

    const result = await askHuman('what day is it?', mockSettings(), undefined, deps);

    // "yesterday" should NOT confirm "four"; it is treated as a negative/other reply,
    // triggering a repeat, whose new answer ("yes") is then confirmed by the final "yes".
    expect(result.answered).toBe(true);
    expect(result.answer).toBe('yes');
    expect(result.status).toBe('answered');
    expect(channel.lastSession?.spokenTexts).toEqual([
      'what day is it?',
      'I heard: "four" — is that correct? Please answer yes or no.',
      'Okay, please repeat your answer.',
      'I heard: "yes" — is that correct? Please answer yes or no.',
    ]);
  });
});

describe('askHuman — channel throws mid-call', () => {
  type FailOn = 'ring' | 'speak';

  class ThrowingSession implements ChannelSession {
    constructor(
      private readonly inner: ChannelSession,
      private readonly failOn: FailOn,
    ) {}
    async ring(): Promise<void> {
      if (this.failOn === 'ring') {
        throw new Error('boom: ring exploded mid-call');
      }
      await this.inner.ring();
    }
    async waitForHuman(timeoutMs: number): Promise<boolean> {
      return this.inner.waitForHuman(timeoutMs);
    }
    async speak(audio: AudioData): Promise<void> {
      if (this.failOn === 'speak') {
        throw new Error('boom: channel exploded mid-call');
      }
      await this.inner.speak(audio);
    }
    async listen(opts: { silenceMs: number; maxMs: number }): Promise<AudioData | null> {
      return this.inner.listen(opts);
    }
    async hangUp(): Promise<void> {
      await this.inner.hangUp();
    }
  }

  class ThrowingChannel implements CommunicationChannel {
    readonly name = 'throwing';
    readonly capabilities: ChannelCapabilities = { outbound: true, inbound: false };
    readonly inner: LoopbackChannel;
    private lastThrowingSession: ThrowingSession | undefined;

    constructor(
      script: LoopbackScript,
      private readonly failOn: FailOn,
    ) {
      this.inner = new LoopbackChannel(script);
    }

    async createSession(req: AskRequest): Promise<ChannelSession> {
      const innerSession = await this.inner.createSession(req);
      this.lastThrowingSession = new ThrowingSession(innerSession, this.failOn);
      return this.lastThrowingSession;
    }
  }

  test('speak() throws -> exception is caught, hangUp still runs, status is error', async () => {
    const channel = new ThrowingChannel({ pickUp: true, utterances: ['four'] }, 'speak');
    const deps: AskDeps = { channel, tts: new LoopbackTts(), stt: new LoopbackStt() };

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.status).toBe('error');
    expect(result.channel).toBe('throwing');
    expect(channel.inner.lastSession?.hungUp).toBe(true);
  });

  test('ring() throws -> exception is caught, hangUp still runs, status is error', async () => {
    const channel = new ThrowingChannel({ pickUp: true, utterances: ['four'] }, 'ring');
    const deps: AskDeps = { channel, tts: new LoopbackTts(), stt: new LoopbackStt() };

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.status).toBe('error');
    expect(result.channel).toBe('throwing');
    expect(channel.inner.lastSession?.hungUp).toBe(true);
  });

  test('error status carries the failure message so callers can diagnose it', async () => {
    const channel = new ThrowingChannel({ pickUp: true, utterances: ['four'] }, 'speak');
    const deps: AskDeps = { channel, tts: new LoopbackTts(), stt: new LoopbackStt() };

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.status).toBe('error');
    expect(result.error).toContain('boom: channel exploded mid-call');
  });

  test('error message includes the whole cause chain', async () => {
    // Mirrors production wiring: every layer chains the one below it via { cause }, so a bare
    // top-level message ("TTS request failed") hides the part that actually says what went wrong.
    class ThrowingTts implements TextToSpeech {
      synthesize(): Promise<AudioData> {
        return Promise.reject(
          new Error('ElevenLabs TTS request failed.', {
            cause: new Error('HTTP 401: invalid api key'),
          }),
        );
      }
    }

    const deps: AskDeps = {
      channel: new LoopbackChannel({ pickUp: true, utterances: ['four'] }),
      tts: new ThrowingTts(),
      stt: new LoopbackStt(),
    };

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.status).toBe('error');
    expect(result.error).toContain('ElevenLabs TTS request failed.');
    expect(result.error).toContain('HTTP 401: invalid api key');
  });

  test('non-Error throwables are still reported', async () => {
    class StringThrowingTts implements TextToSpeech {
      synthesize(): Promise<AudioData> {
        return Promise.reject('just a string');
      }
    }

    const deps: AskDeps = {
      channel: new LoopbackChannel({ pickUp: true, utterances: ['four'] }),
      tts: new StringThrowingTts(),
      stt: new LoopbackStt(),
    };

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.status).toBe('error');
    expect(result.error).toContain('just a string');
  });

  test('successful calls carry no error field', async () => {
    const { deps } = makeDeps({ pickUp: true, utterances: ['four', 'yes'] });

    const result = await askHuman('what is 2+2?', mockSettings(), undefined, deps);

    expect(result.status).toBe('answered');
    expect(result.error).toBeUndefined();
  });
});

describe('askHuman — opts override settings', () => {
  test('confirmRounds: 1 exhausts before the third scripted confirmation', async () => {
    const { deps } = makeDeps({
      pickUp: true,
      utterances: ['four', 'no', 'five', 'yes'],
    });

    const result = await askHuman('what is 2+2?', mockSettings(), { confirmRounds: 1 }, deps);

    // With confirmRounds: 3 (default) this same script resolves to answered "five" (see above).
    // With confirmRounds: 1, only one round runs, so it exhausts before the final "yes" is reached.
    expect(result.answered).toBe(false);
    expect(result.status).toBe('not_confirmed');
  });
});
