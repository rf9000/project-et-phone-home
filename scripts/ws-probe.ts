#!/usr/bin/env bun
// Isolates WHERE a voice-websocket failure lives: the network, Cloudflare, or the runtime.
//
// Asks Discord for a fresh voice endpoint (they rotate, and a stale one proves nothing), then
// hits it three ways:
//   1. fetch()    — does plain HTTPS to this host/port work from inside Bun?
//   2. WebSocket  — does Bun's own WebSocket client complete the upgrade?
//   3. reports the difference, which is the diagnosis.
//
// Run from the project root:  bun run scripts/ws-probe.ts

import net from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';

const token = process.env.ETPH_DISCORD_BOT_TOKEN;
const guildId = process.env.ETPH_DISCORD_GUILD_ID;
const voiceChannelId = process.env.ETPH_DISCORD_VOICE_CHANNEL_ID;

if (!token || !guildId || !voiceChannelId) {
  console.error('Missing ETPH_DISCORD_* env. Run from the project root so .env loads.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await client.login(token);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once(Events.ClientReady, () => resolve());
});

const guild = await client.guilds.fetch(guildId);

// Joining is how Discord hands out a voice endpoint; we only want the endpoint, not the audio.
const connection = joinVoiceChannel({
  channelId: voiceChannelId,
  guildId,
  adapterCreator: guild.voiceAdapterCreator,
  selfDeaf: false,
  selfMute: false,
});

const endpoint = await new Promise<string | undefined>((resolve) => {
  const timer = setTimeout(() => resolve(undefined), 15_000);
  connection.on('stateChange', (_old, next) => {
    const found = (next as { networking?: { state?: { connectionOptions?: { endpoint?: string } } } })
      .networking?.state?.connectionOptions?.endpoint;
    if (found !== undefined) {
      clearTimeout(timer);
      resolve(found);
    }
  });
});

connection.destroy();

if (endpoint === undefined) {
  console.error('Discord never provided a voice endpoint (never left Signalling).');
  void client.destroy();
  process.exit(1);
}

console.log(`Fresh voice endpoint: ${endpoint}\n`);
const [host, port = '443'] = endpoint.split(':');

// 0. Raw TCP per address family. This is the layer beneath TLS and websockets: if one family
//    hangs and the other connects, the whole failure is address selection, not the port.
console.log('[0] raw TCP connect to each resolved address...');
const addresses = await dnsPromises.lookup(host as string, { all: true });
const tcpResults: Array<{ family: number; connected: boolean }> = [];

for (const { address, family } of addresses) {
  const startedAt = Date.now();
  const probe = await new Promise<{ label: string; connected: boolean }>((resolve) => {
    const socket = net.connect({ host: address, port: Number(port), family });
    const done = (label: string, connected: boolean): void => {
      socket.destroy();
      resolve({ label: `${label} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`, connected });
    };
    socket.setTimeout(6_000, () => done('TIMEOUT', false));
    socket.once('connect', () => done('connected', true));
    socket.once('error', (error) =>
      done(`error (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`, false),
    );
  });
  tcpResults.push({ family, connected: probe.connected });
  console.log(`    IPv${family} ${address.padEnd(28)} ${probe.label}`);
}

// 1. Plain HTTPS from inside Bun. A voice host legitimately refuses ordinary requests, so ANY
//    status back means the transport works — only a hang or throw is a real failure.
console.log('\n[1] fetch() over HTTPS to the voice host...');
const fetchStarted = Date.now();
try {
  const res = await fetch(`https://${host}:${port}/`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  const blocked = body.includes('you have been blocked') || body.includes('Attention Required');
  console.log(`    HTTP ${res.status} in ${((Date.now() - fetchStarted) / 1000).toFixed(1)}s` +
    `${blocked ? '  <-- Cloudflare WAF block page' : ''}`);
} catch (error) {
  console.log(`    FAILED in ${((Date.now() - fetchStarted) / 1000).toFixed(1)}s: ${(error as Error).message}`);
}

// 2. The actual thing that fails in a real call: the voice websocket upgrade.
console.log('\n[2] WebSocket upgrade (what @discordjs/voice does)...');
const wsStarted = Date.now();
const elapsed = (): string => `${((Date.now() - wsStarted) / 1000).toFixed(1)}s`;

const outcome = await new Promise<string>((resolve) => {
  const socket = new WebSocket(`wss://${host}:${port}/?v=8`);
  const timer = setTimeout(() => {
    socket.close();
    resolve(`HUNG — no open, no error after ${elapsed()}`);
  }, 15_000);

  socket.addEventListener('open', () => {
    clearTimeout(timer);
    socket.close();
    resolve(`OPEN in ${elapsed()} — the upgrade succeeded`);
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    resolve(`ERROR in ${elapsed()}`);
  });
  socket.addEventListener('close', (event) => {
    clearTimeout(timer);
    resolve(`CLOSED in ${elapsed()} — code ${event.code}${event.reason ? ` (${event.reason})` : ''}`);
  });
});

console.log(`    ${outcome}`);

console.log('\n--- Diagnosis ---');

// Reason from what the three probes actually did. (An earlier version of this script asserted
// "plain HTTPS works" in a branch reached even when fetch had failed — a wrong verdict is worse
// than none, so every claim below is tied to a recorded result.)
const ipv4Works = tcpResults.some((r) => r.family === 4 && r.connected);
const ipv6Works = tcpResults.some((r) => r.family === 6 && r.connected);
const wsOpened = outcome.startsWith('OPEN');

if (wsOpened) {
  console.log('The voice websocket opens from this machine. The transport is fine;');
  console.log('=> re-run a real call and trace it with scripts/voice-trace.ts.');
} else if (ipv4Works && !ipv6Works) {
  console.log('TCP to IPv4 connects; every IPv6 address hangs or fails.');
  console.log('This network advertises IPv6 that does not route, and Bun tries IPv6 first.');
  console.log('ETPH_PREFER_IPV4 steers node:dns but NOT Bun\'s native fetch/WebSocket, so it');
  console.log('cannot fix this on its own. Options:');
  console.log('  - disable IPv6 on the adapter (admin):');
  console.log('      Disable-NetAdapterBinding -Name "Wi-Fi" -ComponentID ms_tcpip6');
  console.log('  - or run under Node 22, which falls back to IPv4 on its own (Happy Eyeballs).');
} else if (!ipv4Works && !ipv6Works) {
  console.log('No TCP connection succeeded on any address — the port really is unreachable.');
  console.log('=> A firewall/VPN between this machine and *.discord.media.');
} else {
  console.log('TCP connects but the websocket does not open.');
  console.log('=> The transport is fine; suspect Cloudflare/Discord rejecting the upgrade, or');
  console.log('   the runtime. Compare against `curl.exe -v` to the same host and port.');
}

void client.destroy();
process.exit(0);
