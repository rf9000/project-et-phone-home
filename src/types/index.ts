export interface AudioData {
  pcm: Buffer;          // raw PCM samples, signed 16-bit little-endian
  sampleRate: number;   // e.g. 48000
  channels: number;     // 1 = mono, 2 = stereo
}

export type AskStatus = 'answered' | 'no_pickup' | 'no_speech' | 'not_confirmed' | 'error';

export interface HumanResponse {
  answered: boolean;         // true only when status === 'answered'
  answer: string | null;     // confirmed transcript; null when !answered
  status: AskStatus;
  channel: string;           // channel name, e.g. 'discord'
  durationMs: number;        // wall time of the whole ask
  error?: string;            // set only when status === 'error': the failure and its cause chain
}

export interface AskRequest {
  question: string;
}

export interface ChannelSession {
  /** Notify the human that a question is waiting (Discord: text mention). */
  ring(): Promise<void>;
  /** Wait for the human to pick up (Discord: join the voice channel). Resolves false on timeout. */
  waitForHuman(timeoutMs: number): Promise<boolean>;
  /** Play synthesized audio into the call. Resolves when playback finishes. */
  speak(audio: AudioData): Promise<void>;
  /** Capture the human's speech until silenceMs of silence or maxMs cap. Null if nothing was said. */
  listen(opts: { silenceMs: number; maxMs: number }): Promise<AudioData | null>;
  /** Tear down the session (leave call, close connections). Must be idempotent. */
  hangUp(): Promise<void>;
}

export interface ChannelCapabilities {
  outbound: true;        // all channels can place outbound asks
  inbound: boolean;      // future: human calls the agent (daemon mode)
}

export interface CommunicationChannel {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  createSession(req: AskRequest): Promise<ChannelSession>;
}

export interface TextToSpeech {
  synthesize(text: string): Promise<AudioData>;
}

export interface SpeechToText {
  transcribe(audio: AudioData): Promise<string>;
}
