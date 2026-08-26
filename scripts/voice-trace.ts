#!/usr/bin/env bun
// Diagnoses a stalled Discord voice connection by tracing every handshake phase with timings.
//
// Why this exists: a call that fails with "voice connection was not ready within 20000 ms" looks
// identical whether the cause is a firewall, broken IPv6 routing, a wedged voice session, or a
// Discord outage. The phase where time is actually spent tells them apart.
//
// Run from the project root (so Bun loads .env):
//   bun run scripts/voice-trace.ts
//
// Needs the same ETPH_DISCORD_* credentials as a real call. Nobody has to join the channel — the
// bot connects on its own. Exits by itself after ~60 s. Nothing secret is printed.

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';

const token = process.env.ETPH_DISCORD_BOT_TOKEN;
const guildId = process.env.ETPH_DISCORD_GUILD_ID;
const voiceChannelId = process.env.ETPH_DISCORD_VOICE_CHANNEL_ID;

if (!token || !guildId || !voiceChannelId) {
  console.error(
    'Missing ETPH_DISCORD_BOT_TOKEN / ETPH_DISCORD_GUILD_ID / ETPH_DISCORD_VOICE_CHANNEL_ID.',
  );
  console.error('Run this from the project root so .env is loaded.');
  process.exit(1);
}

/** @discordjs/voice NetworkingStatusCode, with what a stall in each one means. */
const PHASES: Record<number, { name: string; meaning: string }> = {
  0: {
    name: 'OpeningWs',
    meaning:
      'the voice websocket never opened. The network is dropping traffic to the voice host — a ' +
      'firewall/VPN blocking *.discord.media (run scripts/ws-probe.ts to test each address).',
  },
  1: { name: 'Identifying', meaning: 'the websocket opened but Discord closed it during identify.' },
  2: {
    name: 'UdpHandshaking',
    meaning: 'UDP discovery never completed — outbound UDP is very likely blocked.',
  },
  3: { name: 'SelectingProtocol', meaning: 'protocol selection stalled (unusual; likely Discord-side).' },
  4: { name: 'Ready', meaning: 'connected.' },
  5: { name: 'Resuming', meaning: 'resuming a dropped session.' },
  6: { name: 'Closed', meaning: 'the voice websocket closed.' },
};

const phaseName = (code: unknown): string =>
  typeof code === 'number' && PHASES[code] !== undefined ? `${PHASES[code]!.name}(${code})` : String(code);

console.log(`runtime: ${typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`}\n`);

console.log('--- @discordjs/voice dependency report ---');
console.log(generateDependencyReport());
console.log('------------------------------------------\n');

const started = Date.now();
const stamp = (): string => `[t+${((Date.now() - started) / 1000).toFixed(1)}s]`.padEnd(10);

/** Wall time spent in each networking phase — the stall is wherever this is largest. */
const timeInPhase = new Map<number, number>();
let currentPhase: number | undefined;
let phaseEnteredAt = Date.now();
let reachedConnecting = false;
/** Set once the websocket has opened at least once (any phase past OpeningWs). */
let wsOpened = false;
let endpoint: string | undefined;

function enterPhase(code: unknown): void {
  if (typeof code !== 'number') return;
  if (code >= 1 && code <= 5) wsOpened = true;
  if (currentPhase !== undefined) {
    timeInPhase.set(currentPhase, (timeInPhase.get(currentPhase) ?? 0) + (Date.now() - phaseEnteredAt));
  }
  currentPhase = code;
  phaseEnteredAt = Date.now();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await client.login(token);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once(Events.ClientReady, () => resolve());
});
console.log(`${stamp()} gateway READY`);

const guild = await client.guilds.fetch(guildId);
console.log(`${stamp()} guild fetched: ${guild.name}`);

const connection = joinVoiceChannel({
  channelId: voiceChannelId,
  guildId,
  adapterCreator: guild.voiceAdapterCreator,
  selfDeaf: false,
  selfMute: false,
});

console.log(`${stamp()} joinVoiceChannel called — tracing phases...\n`);

let lastNetworking: unknown;

connection.on('stateChange', (oldState, newState) => {
  console.log(`${stamp()} voice: ${oldState.status} -> ${newState.status}`);
  if (newState.status === VoiceConnectionStatus.Connecting) reachedConnecting = true;

  const networking = (newState as { networking?: unknown }).networking;
  if (networking === undefined || networking === lastNetworking) return;
  lastNetworking = networking;

  const options = (networking as { state?: { connectionOptions?: { endpoint?: string } } }).state
    ?.connectionOptions;
  if (options?.endpoint !== undefined && options.endpoint !== endpoint) {
    endpoint = options.endpoint;
    console.log(`${stamp()}   voice endpoint: ${endpoint}`);
  }

  enterPhase(0);
  (networking as { on: (e: string, cb: (o: unknown, n: unknown) => void) => void }).on(
    'stateChange',
    (o, n) => {
      const next = (n as { code?: unknown }).code;
      enterPhase(next);
      console.log(`${stamp()}   phase: ${phaseName((o as { code?: unknown }).code)} -> ${phaseName(next)}`);
    },
  );
});

connection.on('error', (error) => console.log(`${stamp()} voice ERROR: ${(error as Error).message}`));
connection.on(VoiceConnectionStatus.Ready, () => {
  console.log(`\n${stamp()} *** READY — the voice connection works. ***`);
  connection.destroy();
  void client.destroy();
  process.exit(0);
});

setTimeout(() => {
  enterPhase(currentPhase); // bank the time spent in the phase we are still sitting in
  console.log(`\n${stamp()} giving up.\n`);

  console.log('Time spent per phase:');
  const ranked = [...timeInPhase.entries()].sort((a, b) => b[1] - a[1]);
  for (const [code, ms] of ranked) {
    console.log(`  ${phaseName(code).padEnd(22)} ${(ms / 1000).toFixed(1)}s`);
  }

  // The verdict is the phase that ate the time, NOT whatever state the retry loop left behind —
  // a failed attempt falls back to Signalling, which would otherwise frame every failure as a
  // Discord problem.
  const worst = ranked[0];
  console.log('\nDiagnosis:');
  if (!reachedConnecting) {
    console.log('  Never left Signalling: Discord never sent VOICE_SERVER_UPDATE.');
    console.log('  => Discord-side, or a wedged voice session. Try a brand-new voice channel.');
  } else if (worst !== undefined && worst[0] === 0 && wsOpened) {
    // The websocket DID open — slowly. That is not a blocked port; it is the IPv6-first fallback.
    // What happened next is a separate fact and comes from the phases after the open.
    const openMs = worst[1];
    console.log(`  The websocket took ${(openMs / 1000).toFixed(1)}s to open.`);
    console.log('  => IPv6 is advertised but does not route: Bun tries IPv6 first and only falls back to IPv4');
    console.log('     after the OS connect timeout (~21 s on Windows). Confirm with scripts/ws-probe.ts.');
    console.log('     Node 22 falls back in milliseconds:');
    console.log('       node --experimental-transform-types --env-file=.env scripts/voice-trace.ts');

    const after = ranked.find(([code]) => code !== 0);
    if (after !== undefined && after[0] === 6) {
      console.log('  After the open, Discord closed the websocket and the connection fell back to Signalling:');
      console.log('  => the late identify was rejected (close code 4006, "session no longer valid") — the voice');
      console.log('     session expired during the slow open. A real call retries, but each retry stalls the same 21 s.');
    } else if (after !== undefined && after[0] === currentPhase && after[0] !== 4) {
      // The phase we were still sitting in when the trace gave up. Its "time" is just however much
      // of the trace budget the slow open left over, NOT a measured stall — do not call it a fault.
      console.log(`  The trace then ran out of time while in ${phaseName(after[0])}; the slow open left`);
      console.log(`  only ${(after[1] / 1000).toFixed(1)}s for the rest. Re-run — a real call has a longer budget — before`);
      console.log('  reading this phase as a second fault; on a good day it completes here in well under a second.');
    } else if (after !== undefined && after[1] >= 1000 && PHASES[after[0]] !== undefined) {
      console.log(`  After the open, it stalled in ${phaseName(after[0])} for ${(after[1] / 1000).toFixed(1)}s:`);
      console.log(`  => ${PHASES[after[0]]!.meaning} This is a second, separate fault.`);
    }
  } else if (worst !== undefined && PHASES[worst[0]] !== undefined) {
    console.log(`  Stalled in ${phaseName(worst[0])} for ${(worst[1] / 1000).toFixed(1)}s:`);
    console.log(`  => ${PHASES[worst[0]]!.meaning}`);
  } else {
    console.log('  Reached Connecting but no phase dominated — inconclusive; re-run.');
  }

  if (endpoint !== undefined) {
    const [host, port] = endpoint.split(':');
    console.log(`\nReachability check for the endpoint Discord assigned:`);
    console.log(`  Test-NetConnection ${host} -Port ${port ?? 443}      # PowerShell`);
    console.log(`  nc -vz ${host} ${port ?? 443}                        # macOS/Linux`);
    console.log('  If IPv6 addresses fail and IPv4 succeeds, Bun cannot be steered around it (its native WebSocket');
    console.log('  ignores DNS result order); run under Node 22 or disable IPv6 on the adapter.');
  }

  connection.destroy();
  void client.destroy();
  process.exit(1);
  // 60 s, not 40: a ~21 s IPv6-first open must still leave a real budget for the phases after it,
  // or the trace guillotines UdpHandshaking and misreports it as a UDP block.
}, 60_000);
