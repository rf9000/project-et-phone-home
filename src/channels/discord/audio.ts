import type { AudioData } from '../../types/index.ts';

/** Discord voice always transports 48 kHz, 2-channel, signed 16-bit little-endian PCM. */
export const DISCORD_SAMPLE_RATE = 48000;
export const DISCORD_CHANNELS = 2;

const BYTES_PER_SAMPLE = 2;
const STEREO_FRAME_BYTES = BYTES_PER_SAMPLE * DISCORD_CHANNELS;

/**
 * Upmixes mono PCM to stereo by duplicating every 16-bit sample into the L and R slots.
 * A trailing partial sample (odd byte) is dropped rather than throwing, so a truncated
 * capture never aborts a live call.
 */
export function monoToStereo(pcm: Buffer): Buffer {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const out = Buffer.allocUnsafe(sampleCount * STEREO_FRAME_BYTES);

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    out.writeInt16LE(sample, i * STEREO_FRAME_BYTES);
    out.writeInt16LE(sample, i * STEREO_FRAME_BYTES + BYTES_PER_SAMPLE);
  }

  return out;
}

/**
 * Downmixes stereo PCM to mono by averaging each L/R pair. The average truncates toward
 * negative infinity (arithmetic shift), which cannot overflow the 16-bit range. A trailing
 * partial frame is dropped rather than throwing.
 */
export function stereoToMono(pcm: Buffer): Buffer {
  const frameCount = Math.floor(pcm.length / STEREO_FRAME_BYTES);
  const out = Buffer.allocUnsafe(frameCount * BYTES_PER_SAMPLE);

  for (let i = 0; i < frameCount; i++) {
    const left = pcm.readInt16LE(i * STEREO_FRAME_BYTES);
    const right = pcm.readInt16LE(i * STEREO_FRAME_BYTES + BYTES_PER_SAMPLE);
    out.writeInt16LE((left + right) >> 1, i * BYTES_PER_SAMPLE);
  }

  return out;
}

/**
 * Converts synthesized audio into the 48 kHz stereo PCM buffer Discord expects.
 * Resampling is deliberately out of scope — the TTS provider is asked for 48 kHz directly.
 */
export function toDiscordPlayable(audio: AudioData): Buffer {
  if (audio.sampleRate !== DISCORD_SAMPLE_RATE) {
    throw new Error(
      `Discord voice requires ${DISCORD_SAMPLE_RATE} Hz audio but got ${audio.sampleRate} Hz; resampling is not supported (request 48 kHz from the speech provider).`,
    );
  }

  if (audio.channels === DISCORD_CHANNELS) return audio.pcm;
  if (audio.channels === 1) return monoToStereo(audio.pcm);

  throw new Error(`Discord voice requires mono or stereo audio but got ${audio.channels} channels.`);
}

/**
 * Converts a 48 kHz stereo capture from Discord into mono AudioData.
 * Mono halves the speech-to-text upload size and ElevenLabs handles mono WAV fine.
 */
export function fromDiscordCapture(stereo48k: Buffer): AudioData {
  return {
    pcm: stereoToMono(stereo48k),
    sampleRate: DISCORD_SAMPLE_RATE,
    channels: 1,
  };
}
