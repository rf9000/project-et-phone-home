import type {
  AskRequest,
  AudioData,
  ChannelCapabilities,
  ChannelSession,
  CommunicationChannel,
  SpeechToText,
  TextToSpeech,
} from '../types/index.ts';

/** Scripted behavior for a LoopbackChannel session, used by tests and integrators. */
export interface LoopbackScript {
  /** Does the human "join"? */
  pickUp: boolean;
  /** Successive listen() results as text; null = silence. */
  utterances: Array<string | null>;
}

/** Encodes text into AudioData.pcm as UTF-8 bytes so the loopback pipeline is lossless. */
export function textToAudio(text: string): AudioData {
  return { pcm: Buffer.from(text, 'utf8'), sampleRate: 48000, channels: 1 };
}

/** Decodes AudioData.pcm (UTF-8 bytes) back to text. Inverse of textToAudio. */
export function audioToText(audio: AudioData): string {
  return audio.pcm.toString('utf8');
}

export class LoopbackTts implements TextToSpeech {
  async synthesize(text: string): Promise<AudioData> {
    return textToAudio(text);
  }
}

export class LoopbackStt implements SpeechToText {
  async transcribe(audio: AudioData): Promise<string> {
    return audioToText(audio);
  }
}

export class LoopbackSession implements ChannelSession {
  /** Every text passed to speak(), decoded back from AudioData, in call order. */
  readonly spokenTexts: string[] = [];
  /** Whether hangUp() has been called. */
  hungUp = false;
  /** Whether ring() has been called. */
  rang = false;
  /** How many times ring() has been called. */
  ringCount = 0;

  private readonly script: LoopbackScript;
  private readonly remainingUtterances: Array<string | null>;

  constructor(script: LoopbackScript) {
    this.script = script;
    this.remainingUtterances = [...script.utterances];
  }

  async ring(): Promise<void> {
    this.rang = true;
    this.ringCount += 1;
  }

  async waitForHuman(_timeoutMs: number): Promise<boolean> {
    return this.script.pickUp;
  }

  async speak(audio: AudioData): Promise<void> {
    this.spokenTexts.push(audioToText(audio));
  }

  async listen(_opts: { silenceMs: number; maxMs: number }): Promise<AudioData | null> {
    const next = this.remainingUtterances.shift();
    if (next === undefined || next === null) {
      return null;
    }
    return textToAudio(next);
  }

  async hangUp(): Promise<void> {
    this.hungUp = true;
  }
}

/** Test/integration fake channel: never touches the network, records what happened. */
export class LoopbackChannel implements CommunicationChannel {
  readonly name = 'loopback';
  readonly capabilities: ChannelCapabilities = { outbound: true, inbound: false };

  /** The most recently created session, exposed so tests can inspect it. */
  lastSession: LoopbackSession | undefined;

  private readonly script: LoopbackScript;

  constructor(script: LoopbackScript) {
    this.script = script;
  }

  async createSession(_req: AskRequest): Promise<ChannelSession> {
    const session = new LoopbackSession(this.script);
    this.lastSession = session;
    return session;
  }
}
