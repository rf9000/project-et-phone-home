#!/usr/bin/env bun
// Diagnoses "the bot joins voice but I hear nothing" by playing a test clip while tracing the
// one layer a silent call never reports on: DAVE end-to-end encryption.
//
// Why this exists: once Discord negotiates DAVE (protocol v1) for a channel, every media frame
// must be MLS-encrypted or the other participants' clients discard it. @discordjs/voice reaches
// Ready *before* the MLS group has formed, and until the group is ready it sends opus frames in
// plaintext (DAVESession.encrypt passes them through). A call that speaks in that window plays a
// clip nobody can decode — player goes Playing -> Idle, status looks normal, human hears silence.
//
// Run from the project root (so Bun loads .env), then JOIN THE VOICE CHANNEL when prompted:
//   bun run scripts/playback-trace.ts            # plays three beeps
//   bun run scripts/playback-trace.ts --tts      # speaks a sentence via ElevenLabs instead
//   bun run scripts/playback-trace.ts --no-wait  # play immediately, do not wait for E2EE
//   bun run scripts/playback-trace.ts --solo     # do not wait for anyone to join (pipeline check only)
//
// Needs the same ETPH_DISCORD_* credentials as a real call (plus ETPH_ELEVENLABS_* for --tts).
// Nothing secret is printed.

import { Readable } from 'node:stream';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { describeE2ee, waitForE2eeReady, type E2eeState } from '../src/channels/discord/dave.ts';
import { toDiscordPlayable } from '../src/channels/discord/audio.ts';
import { VOICE_READY_TIMEOUT_MS } from '../src/channels/discord/helpers.ts';
import { ElevenLabsTts } from '../src/speech/elevenlabs/tts.ts';

const token = process.env.ETPH_DISCORD_BOT_TOKEN;
const guildId = process.env.ETPH_DISCORD_GUILD_ID;
const voiceChannelId = process.env.ETPH_DISCORD_VOICE_CHANNEL_ID;

if (!token || !guildId || !voiceChannelId) {
  console.error('Missing ETPH_DISCORD_BOT_TOKEN / ETPH_DISCORD_GUILD_ID / ETPH_DISCORD_VOICE_CHANNEL_ID.');
  console.error('Run this from the project root so .env is loaded.');
  process.exit(1);
}

const useTts = process.argv.includes('--tts');
const waitForE2ee = !process.argv.includes('--no-wait');
/** --solo: do not wait for a human to join (exercises the pipeline; E2EE state is then bot-only). */
const solo = process.argv.includes('--solo');
const HUMAN_JOIN_TIMEOUT_MS = 120_000;
const E2EE_TIMEOUT_MS = 15_000;

const started = Date.now();
const stamp = (): string => `[t+${((Date.now() - started) / 1000).toFixed(1)}s]`.padEnd(10);

/** 48 kHz stereo 16-bit PCM: three 400 ms beeps at 660 Hz with 300 ms gaps. Unmistakable. */
function makeBeeps(): Buffer {
  const rate = 48_000;
  const pattern = [400, 300, 400, 300, 400];
  const totalMs = pattern.reduce((a, b) => a + b, 0);
  const frames = (rate * totalMs) / 1000;
  const out = Buffer.alloc(frames * 4);
  let frame = 0;
  pattern.forEach((ms, i) => {
    const n = (rate * ms) / 1000;
    const tone = i % 2 === 0;
    for (let k = 0; k < n; k++, frame++) {
      const sample = tone ? Math.round(Math.sin((2 * Math.PI * 660 * k) / rate) * 12_000) : 0;
      out.writeInt16LE(sample, frame * 4);
      out.writeInt16LE(sample, frame * 4 + 2);
    }
  });
  return out;
}

async function makeClip(): Promise<Buffer> {
  if (!useTts) return makeBeeps();
  const apiKey = process.env.ETPH_ELEVENLABS_API_KEY;
  const voiceId = process.env.ETPH_ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    console.error('--tts needs ETPH_ELEVENLABS_API_KEY and ETPH_ELEVENLABS_VOICE_ID.');
    process.exit(1);
  }
  const tts = new ElevenLabsTts({
    apiKey,
    voiceId,
    model: process.env.ETPH_ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2',
  });
  const audio = await tts.synthesize('This is a playback test. If you can hear this sentence, audio works.');
  console.log(`${stamp()} ElevenLabs returned ${audio.pcm.length} bytes of PCM`);
  return toDiscordPlayable(audio);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await client.login(token);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once(Events.ClientReady, () => resolve());
});
console.log(`${stamp()} gateway READY`);

const guild = await client.guilds.fetch(guildId);
const voiceChannel = await guild.channels.fetch(voiceChannelId);
const othersInChannel = (): number =>
  voiceChannel !== null && voiceChannel.isVoiceBased()
    ? voiceChannel.members.filter((m) => m.id !== client.user?.id).size
    : 0;

if (othersInChannel() === 0 && !solo) {
  console.log(`\n${stamp()} >>> Nobody is in the voice channel. JOIN IT NOW — waiting up to ${HUMAN_JOIN_TIMEOUT_MS / 1000}s. <<<\n`);
  const joined = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), HUMAN_JOIN_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (othersInChannel() > 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(true);
      }
    }, 500);
  });
  if (!joined) {
    console.log(`${stamp()} nobody joined; continuing anyway (E2EE state will not be representative).`);
  }
}
console.log(`${stamp()} ${othersInChannel()} other participant(s) in the channel`);

// Fetch the clip before joining so the join -> play gap mirrors a real call (TTS happens after
// Ready in production, but here we want to measure the E2EE handshake in isolation).
const clip = await makeClip();
console.log(`${stamp()} clip ready: ${clip.length} bytes = ${(clip.length / 192).toFixed(0)} ms`);

const connection = joinVoiceChannel({
  channelId: voiceChannelId,
  guildId,
  adapterCreator: guild.voiceAdapterCreator,
  selfDeaf: false,
  selfMute: false,
  debug: true,
});

connection.on('debug', (message) => {
  // Only the DAVE lines. The other debug lines echo raw websocket payloads, which carry the
  // voice session token and the transport secret key — never print those.
  if (message.includes('[DAVE]')) console.log(`${stamp()}   ${message}`);
});
connection.on('error', (error) => console.log(`${stamp()} voice ERROR: ${error.message}`));

/** @discordjs/voice NetworkingStatusCode names, so a stall or a close is attributable to a phase. */
const PHASE = ['OpeningWs', 'Identifying', 'UdpHandshaking', 'SelectingProtocol', 'Ready', 'Resuming', 'Closed'];
let lastNetworking: unknown;
connection.on('stateChange', (o, n) => {
  console.log(`${stamp()} voice: ${o.status} -> ${n.status}`);

  // Each Connecting state carries a fresh Networking instance; the websocket close code lives
  // there, and it is the one fact that tells a network drop from a Discord-side rejection.
  const networking = (n as { networking?: unknown }).networking as
    | { on: (event: string, cb: (...args: unknown[]) => void) => void }
    | undefined;
  if (networking === undefined || networking === lastNetworking) return;
  lastNetworking = networking;
  networking.on('stateChange', (from, to) => {
    const code = (to as { code?: number }).code ?? -1;
    console.log(`${stamp()}   phase: ${PHASE[(from as { code?: number }).code ?? -1] ?? '?'} -> ${PHASE[code] ?? code}`);
  });
  networking.on('close', (code) => console.log(`${stamp()}   voice websocket CLOSED with code ${String(code)}`));
  networking.on('error', (error) => console.log(`${stamp()}   networking ERROR: ${(error as Error).message}`));
});

try {
  await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
} catch {
  console.log(`${stamp()} voice never reached Ready — this is the *connection* problem, not silence. Run scripts/voice-trace.ts.`);
  connection.destroy();
  void client.destroy();
  process.exit(1);
}
console.log(`${stamp()} voice READY`);

const readE2ee = (): E2eeState => describeE2ee(connection);
console.log(`${stamp()} E2EE at Ready: ${JSON.stringify(readE2ee())}`);

let e2eeWaitMs = 0;
if (waitForE2ee) {
  const t = Date.now();
  const ready = await waitForE2eeReady(connection, E2EE_TIMEOUT_MS);
  e2eeWaitMs = Date.now() - t;
  console.log(`${stamp()} E2EE ${ready ? 'ready' : 'NOT ready'} after ${e2eeWaitMs} ms: ${JSON.stringify(readE2ee())}`);
}

const atPlay = readE2ee();
const packetsBefore = (connection.state as { networking?: { state?: { connectionData?: { packetsPlayed?: number } } } })
  .networking?.state?.connectionData?.packetsPlayed ?? 0;

const player = createAudioPlayer();
player.on('stateChange', (o, n) => console.log(`${stamp()} player: ${o.status} -> ${n.status}`));
player.on('error', (error) => console.log(`${stamp()} player ERROR: ${error.message}`));
connection.subscribe(player);

console.log(`\n${stamp()} >>> PLAYING NOW — listen. <<<`);
player.play(createAudioResource(Readable.from(clip, { objectMode: false }), { inputType: StreamType.Raw }));

let playbackOk = true;
try {
  await entersState(player, AudioPlayerStatus.Playing, 5_000);
  await entersState(player, AudioPlayerStatus.Idle, clip.length / 192 + 10_000);
} catch (error) {
  playbackOk = false;
  console.log(`${stamp()} playback did not complete: ${(error as Error).message}`);
}

const packetsAfter = (connection.state as { networking?: { state?: { connectionData?: { packetsPlayed?: number } } } })
  .networking?.state?.connectionData?.packetsPlayed ?? 0;
const sent = packetsAfter - packetsBefore;
const expected = Math.round(clip.length / 192 / 20);

console.log(`\n${stamp()} playback ${playbackOk ? 'finished' : 'FAILED'}; ${sent} RTP packets sent (~${expected} expected for the clip)`);
console.log(`${stamp()} E2EE while playing: ${JSON.stringify(atPlay)}`);

console.log('\n--- Diagnosis ---');
const alone = othersInChannel() === 0;
if (!playbackOk || sent === 0) {
  console.log('No audio left the bot. The encoder/player pipeline is broken on this machine — check');
  console.log('the opus library in `generateDependencyReport()` (prism-media must fall back to opusscript under Bun).');
} else if (alone) {
  console.log(`The pipeline works: ${sent} packets encoded and sent (DAVE v${atPlay.protocolVersion}, MLS ready: ${atPlay.sessionReady}).`);
  console.log('With nobody else in the channel there is no one to form the MLS group with, so the E2EE');
  console.log('readiness above proves nothing either way. Re-run while sitting in the channel for the real answer.');
} else if (atPlay.protocolVersion > 0 && !atPlay.sessionReady) {
  console.log(`Discord negotiated DAVE v${atPlay.protocolVersion} but the bot's MLS session was NOT ready when it played,`);
  console.log('so the frames went out unencrypted and every other client discarded them. If you heard');
  console.log('nothing, this is the cause. The fix is to wait for E2EE before speaking (src/channels/discord/dave.ts).');
  if (waitForE2ee) console.log(`The handshake did not complete within ${E2EE_TIMEOUT_MS} ms — look at the [DAVE] lines above for where it stopped.`);
} else if (atPlay.protocolVersion > 0) {
  console.log(`Frames were E2EE-encrypted (DAVE v${atPlay.protocolVersion}, handshake took ${e2eeWaitMs} ms) and ${sent} packets were sent.`);
  console.log('If you heard the clip: the bot works; a silent real call is timing (speak() before E2EE) or Discord-side.');
  console.log("If you heard nothing: check the bot's per-user volume in your Discord client (right-click the bot) and");
  console.log('that your client is not in a different voice region than the bot; then compare under Node 22.');
} else {
  console.log(`No end-to-end encryption in this channel (DAVE v0) and ${sent} packets were sent in the transport encryption.`);
  console.log('If you heard nothing, the problem is not E2EE: check per-user volume for the bot in your client, then the');
  console.log('opus library in use (opusscript vs @discordjs/opus) by comparing under Node 22.');
}

player.stop(true);
connection.destroy();
void client.destroy();
process.exit(0);
