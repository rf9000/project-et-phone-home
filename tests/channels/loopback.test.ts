import { describe, expect, test } from 'bun:test';
import { LoopbackChannel, LoopbackStt, LoopbackTts, audioToText, textToAudio } from '../../src/channels/loopback.ts';

describe('textToAudio / audioToText', () => {
  test('round-trips text through AudioData losslessly', () => {
    const audio = textToAudio('hello world');
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(1);
    expect(audio.pcm).toBeInstanceOf(Buffer);
    expect(audioToText(audio)).toBe('hello world');
  });
});

describe('LoopbackTts / LoopbackStt', () => {
  test('synthesize then transcribe returns the original text', async () => {
    const tts = new LoopbackTts();
    const stt = new LoopbackStt();

    const audio = await tts.synthesize('what is your favorite number?');
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(1);

    const text = await stt.transcribe(audio);
    expect(text).toBe('what is your favorite number?');
  });
});

describe('LoopbackChannel', () => {
  test('declares name and capabilities', () => {
    const channel = new LoopbackChannel({ pickUp: true, utterances: [] });
    expect(channel.name).toBe('loopback');
    expect(channel.capabilities).toEqual({ outbound: true, inbound: false });
  });

  test('waitForHuman resolves script.pickUp', async () => {
    const pickedUp = new LoopbackChannel({ pickUp: true, utterances: [] });
    const sessionA = await pickedUp.createSession({ question: 'q' });
    expect(await sessionA.waitForHuman(1000)).toBe(true);

    const noPickup = new LoopbackChannel({ pickUp: false, utterances: [] });
    const sessionB = await noPickup.createSession({ question: 'q' });
    expect(await sessionB.waitForHuman(1000)).toBe(false);
  });

  test('ring records rang and ringCount', async () => {
    const channel = new LoopbackChannel({ pickUp: true, utterances: [] });
    const session = await channel.createSession({ question: 'q' });

    expect(channel.lastSession?.rang).toBe(false);
    expect(channel.lastSession?.ringCount).toBe(0);

    await session.ring();
    expect(channel.lastSession?.rang).toBe(true);
    expect(channel.lastSession?.ringCount).toBe(1);

    await session.ring();
    expect(channel.lastSession?.ringCount).toBe(2);
  });

  test('speak records spokenTexts, listen shifts utterances, hangUp records hungUp', async () => {
    const channel = new LoopbackChannel({ pickUp: true, utterances: ['four', null, 'five'] });
    const session = await channel.createSession({ question: 'what is 2+2?' });

    await session.speak(textToAudio('what is 2+2?'));
    expect(channel.lastSession?.spokenTexts).toEqual(['what is 2+2?']);

    const first = await session.listen({ silenceMs: 100, maxMs: 1000 });
    expect(first && audioToText(first)).toBe('four');

    const second = await session.listen({ silenceMs: 100, maxMs: 1000 });
    expect(second).toBeNull();

    const third = await session.listen({ silenceMs: 100, maxMs: 1000 });
    expect(third && audioToText(third)).toBe('five');

    expect(channel.lastSession?.hungUp).toBe(false);
    await session.hangUp();
    expect(channel.lastSession?.hungUp).toBe(true);
  });

  test('exposes lastSession for the most recently created session', async () => {
    const channel = new LoopbackChannel({ pickUp: true, utterances: [] });
    expect(channel.lastSession).toBeUndefined();

    const session = await channel.createSession({ question: 'q' });
    expect(channel.lastSession).toBeDefined();
    expect(channel.lastSession).not.toBe(undefined);
    // structural identity: the session returned IS the exposed lastSession
    expect(session).toBe(channel.lastSession as unknown as typeof session);
  });
});
