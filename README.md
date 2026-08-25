# et-phone-home

Your agent workflow hits a human-in-the-loop step. Instead of posting a notification and
waiting for someone to notice it, **et-phone-home makes the agent call you**: it rings you on
Discord voice, speaks the question out loud, listens to your spoken answer, transcribes it, and
hands the text back to the workflow. No dashboard to check, no ticket to remember — just pick up
and talk.

## How it works

1. `ask()` (or the CLI) posts a text mention of you in a configured Discord text channel — bots
   can't ring a DM the way a real phone call rings, so a text ping plus a voice channel is the
   closest equivalent.
2. You join the configured voice channel; the bot detects this and joins too.
3. The bot speaks your question aloud via text-to-speech (ElevenLabs).
4. It listens and captures your spoken answer.
5. Your answer is transcribed to text (ElevenLabs Scribe) and read back to you: *"I heard: '…' —
   is that correct?"* You confirm or correct it, for up to a few rounds.
6. Once you confirm, the confirmed transcript is returned to the workflow as plain text (along
   with a status and duration) — no built-in fallback if you never pick up or never confirm; the
   calling workflow decides what to do next.

## Quickstart

### Prerequisites

- Bun ≥ 1.3
- An ElevenLabs account and API key (for TTS + STT)
- A Discord server where you can create and invite a bot

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create
   a new application, then add a Bot to it.
2. Copy the bot token (`ETPH_DISCORD_BOT_TOKEN` below).
3. No privileged intents are required. The bot only needs `Guilds`, `GuildVoiceStates`, and
   `GuildMessages` (none of these are privileged/gateway-restricted intents that need enabling in
   the portal).
4. Generate an invite URL with scope `bot` and permissions **View Channels**, **Send Messages**,
   **Connect**, **Speak**, then invite the bot to your server.

### 2. Get the IDs you'll need

Enable Developer Mode in Discord (User Settings → Advanced), then right-click to copy:

- Your server → **Copy Server ID** (`ETPH_DISCORD_GUILD_ID`)
- A text channel → **Copy Channel ID** (`ETPH_DISCORD_TEXT_CHANNEL_ID`)
- A voice channel → **Copy Channel ID** (`ETPH_DISCORD_VOICE_CHANNEL_ID`)
- Your own user → **Copy User ID** (`ETPH_DISCORD_USER_ID`)

### 3. Install and configure

```bash
bun install
```

Set environment variables (or use a JSON file / plain object — see "Settings for integrators"
below). Every setting has an `ETPH_`-prefixed env var, generated straight from the settings
schema:

| Env var | Description | Notes |
|---|---|---|
| `ETPH_DISCORD_BOT_TOKEN` | Discord bot token used to authenticate the bot. | secret, required |
| `ETPH_DISCORD_GUILD_ID` | Discord server (guild) ID the bot operates in. | required |
| `ETPH_DISCORD_TEXT_CHANNEL_ID` | Discord text channel ID used to notify the human that a question is waiting. | required |
| `ETPH_DISCORD_VOICE_CHANNEL_ID` | Discord voice channel ID the bot joins to speak the question and listen for an answer. | required |
| `ETPH_DISCORD_USER_ID` | Discord user ID of the human to call. | required |
| `ETPH_ELEVENLABS_API_KEY` | ElevenLabs API key. | secret, required |
| `ETPH_ELEVENLABS_VOICE_ID` | ElevenLabs voice ID used to synthesize the question. | required |
| `ETPH_ELEVENLABS_TTS_MODEL` | ElevenLabs text-to-speech model ID. | default: `"eleven_multilingual_v2"` |
| `ETPH_ELEVENLABS_STT_MODEL` | ElevenLabs speech-to-text model ID. | default: `"scribe_v1"` |
| `ETPH_CALL_JOIN_TIMEOUT_MS` | Milliseconds to wait for the human to join the voice channel before giving up. | default: `120000` |
| `ETPH_CALL_SILENCE_MS` | Milliseconds of silence that marks the end of the human speaking. | default: `1500` |
| `ETPH_CALL_MAX_LISTEN_MS` | Maximum milliseconds to listen for a response before giving up. | default: `60000` |
| `ETPH_CALL_CONFIRM_ROUNDS` | Maximum number of rounds spent confirming the transcribed answer with the human. | default: `3` |
| `ETPH_CALL_AFFIRMATIVE_WORDS` | Words treated as an affirmative confirmation from the human. | default: `["yes","yeah","yep","correct","right","ja"]` |
| `ETPH_CHANNEL` | Communication channel to use for asking the human. Currently only `"discord"` is supported. | default: `"discord"` |
| `ETPH_SERVER_HOST` | Host interface the switchboard server binds to. | default: `"127.0.0.1"` |
| `ETPH_SERVER_PORT` | Port the switchboard server listens on. | default: `3117` |
| `ETPH_SERVER_AUTH_TOKEN` | Bearer token the switchboard server requires on every request. Empty disables auth, which is only allowed on loopback binds. | secret, default: `""` |

These `server.*` settings are only consumed by `et-phone-home serve` — see
["Switchboard (concurrent agents)"](#switchboard-concurrent-agents) below.

This same table is generated at runtime — run `bun run src/cli/index.ts help` to print it
straight from the code.

### 4. Make your first call

```bash
bun run ask "What is two plus two?"
```

The bot pings you in the text channel, you join the voice channel, it asks the question out
loud, you answer out loud, it reads the answer back for confirmation, and once you say "yes" the
confirmed answer prints to stdout. Exit code is `0` if answered, `2` if not answered (timeout, no
speech, or never confirmed), `1` on a usage or configuration error.

## Library usage

The one-liner:

```ts
import { ask } from 'et-phone-home';

const result = await ask('What is two plus two?');
if (result.answered) {
  console.log(result.answer);
}
```

`ask()` resolves settings from environment variables (optionally overlaid with a partial object
you pass in), wires up the default production dependencies (Discord channel + ElevenLabs
TTS/STT), and drives the call.

For full control over settings resolution and dependencies, use `resolveSettings`,
`buildDefaultDeps`, and `askHuman` directly:

```ts
import { resolveSettings, buildDefaultDeps, askHuman } from 'et-phone-home';

const settings = resolveSettings({ filePath: './settings.json' });
const deps = buildDefaultDeps(settings);
const result = await askHuman('What is two plus two?', settings, undefined, deps);

// et-phone-home never assumes what "no answer" should mean — you decide.
if (result.answered) {
  proceedWith(result.answer);
} else {
  // result.status is one of: 'no_pickup' | 'no_speech' | 'not_confirmed' | 'error'
  escalateOrRetry(result.status);
}
```

`HumanResponse`, the shape every call resolves to:

```ts
interface HumanResponse {
  answered: boolean;         // true only when status === 'answered'
  answer: string | null;     // confirmed transcript; null when !answered
  status: 'answered' | 'no_pickup' | 'no_speech' | 'not_confirmed' | 'error';
  channel: string;           // channel name, e.g. 'discord'
  durationMs: number;        // wall time of the whole ask
}
```

`askHuman` never rejects once a session exists — every outcome, including timeouts and silence,
comes back as a typed result. It only throws before that, for configuration/connection failures
(bad token, missing channel, etc.).

## CLI usage

```bash
# Question as an argument
bun run src/cli/index.ts ask "What is two plus two?"

# Question piped via stdin
echo "What is two plus two?" | bun run src/cli/index.ts ask

# Full HumanResponse as JSON instead of plain text
bun run src/cli/index.ts ask "What is two plus two?" --json

# Override settings from a JSON file
bun run src/cli/index.ts ask "..." --config ./settings.json

# Override the join timeout (seconds) for this call only
bun run src/cli/index.ts ask "..." --timeout 60
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Answered — the confirmed answer was printed |
| `2` | Not answered — `no_pickup`, `no_speech`, `not_confirmed`, or `error` |
| `1` | Usage error (no question given) or configuration error (invalid/missing settings) |

**stdout purity**: stdout carries only the machine-readable result (the plain-text answer, or the
JSON blob with `--json`) — nothing else is ever written there. All usage text, help output, and
diagnostics go to stderr, so a caller can safely pipe stdout into another program.

## Switchboard (concurrent agents)

A Discord bot can hold only one voice call per guild at a time — a second concurrent `ask()`
would steal the bot out of the first call's voice channel. If several independent agents need to
place calls at once (for example, a workflow that specs out a batch of work items owned by
different people), they need a single coordinator serializing calls, not each agent dialing out
on its own. The switchboard is that coordinator: one long-running daemon, an in-memory FIFO
queue, one call at a time. Callers submit a question and poll for the result; they never touch
Discord or ElevenLabs credentials directly.

### Run the daemon

```bash
bun run src/cli/index.ts serve
```

This binds `settings.server.host`/`settings.server.port` (`ETPH_SERVER_HOST` /
`ETPH_SERVER_PORT`, default `127.0.0.1:3117`) and serves until you stop the process. The daemon
owns the Discord bot token and ElevenLabs key; agents talking to it never see either.

### HTTP API

Submit-then-poll, not a held-open request — a call can queue for tens of minutes, which would
fight every HTTP timeout between client and server.

**`POST /ask`** — submit a question, returns `202` immediately with the job's queue position:

```bash
curl -X POST http://127.0.0.1:3117/ask \
  -H 'content-type: application/json' \
  -d '{"question": "Ship it?", "userId": "123456789012345678"}'
# -> 202 {"id":"...","position":1}
```

**`GET /ask/:id`** — poll for the result; `waitMs` (capped at 60000) long-polls instead of
returning immediately:

```bash
curl "http://127.0.0.1:3117/ask/<id>?waitMs=30000"
# -> {"state":"queued","position":1}
# -> {"state":"done","result":{"answered":true,"answer":"Yes","status":"answered", ...}}
```

**`DELETE /ask/:id`** — cancel a job that hasn't started calling yet:

```bash
curl -X DELETE http://127.0.0.1:3117/ask/<id>
# -> 200 {"state":"cancelled"}   (or 409 if the call is already in progress, 404 if unknown)
```

### `userId` and identity

`userId` is the Discord user ID of the human to call — the switchboard routes calls, it doesn't
resolve identity. Mapping a work-item owner or task assignee to a Discord user ID is the caller's
job.

### CLI: ask through the switchboard

```bash
bun run src/cli/index.ts ask "Ship it?" --server http://127.0.0.1:3117 --user 123456789012345678

# Cap how long this ask may sit in the queue before it expires unanswered
bun run src/cli/index.ts ask "Ship it?" --server http://127.0.0.1:3117 --user 123456789012345678 \
  --queue-timeout 600
```

Same stdout purity and exit codes as a direct `ask` (`0` answered, `2` not answered, `1`
usage/config/unreachable). `--server` requires `--user`; without `--server`, `ask` behaves exactly
as it always has, calling Discord directly.

The same round trip is available as a library call: `new SwitchboardClient({ baseUrl }).ask(...)`
returns a `Promise<HumanResponse>`.

### Auth and binding

Set `ETPH_SERVER_AUTH_TOKEN` to require every request to carry `Authorization: Bearer <token>`
(otherwise `401`). The daemon binds `127.0.0.1` by default; binding to any other host **without**
an auth token set is refused at startup, so an unauthenticated "ring anyone" endpoint can't end
up open on the network by accident. On the client side, `bun run src/cli/index.ts ask --server ...`
reads that same bearer token from the `ETPH_SERVER_AUTH_TOKEN` environment variable directly (not
via `--config`, which `--server` mode rejects).

### Restarts lose the queue

The queue is in-memory by design in v1: restarting the daemon drops whatever was queued or
in-flight. Pollers see connection-refused and should treat it as an infrastructure failure —
re-submit or give up, same as any other backend restart. Finished job results are kept for one
hour after completion, then garbage-collected (polling an unknown or expired id returns `404`).

See the full design doc: [`docs/superpowers/specs/2026-08-20-switchboard-daemon-design.md`](docs/superpowers/specs/2026-08-20-switchboard-daemon-design.md).

## Settings for integrators

`src/settings/schema.ts` defines a single Zod object as the source of truth for every setting.
Walking that schema produces `settingsFields: SettingsField[]` — one entry per leaf field:

```ts
interface SettingsField {
  path: string;       // e.g. 'discord.botToken', 'call.joinTimeoutMs'
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description: string; // human-readable description
  secret: boolean;     // true for discord.botToken, elevenlabs.apiKey
  default?: unknown;   // present when the field has a default
  required: boolean;   // true when there is no default
}
```

Any host tool can import `settingsFields` to render its own settings UI (labels, secret masking,
required/default badges) without hand-maintaining a duplicate list — the CLI's own `help` output
is generated from the exact same array.

Env var naming: each field path maps to an `ETPH_`-prefixed, upper-snake-case name
(`discord.botToken` → `ETPH_DISCORD_BOT_TOKEN`, `call.joinTimeoutMs` → `ETPH_CALL_JOIN_TIMEOUT_MS`).

`resolveSettings({ object, filePath, env })` merges sources with later sources winning:
**env → JSON file → plain object** (an in-memory `object` override beats a `--config` file, which
beats environment variables), then validates the merged result against the schema.

## Architecture

- **`CommunicationChannel` / `ChannelSession`** — a channel (Discord today) hands back a
  per-call session exposing `ring`, `waitForHuman`, `speak`, `listen`, `hangUp`. `askHuman` only
  ever talks to this interface, never to Discord-specific types.
- **`TextToSpeech` / `SpeechToText`** — single-method interfaces around `AudioData` (raw PCM +
  sample rate + channels), implemented by `ElevenLabsTts`/`ElevenLabsStt`.
- **Per-call session model** — every `ask()`/`askHuman()` call is stateless: create a session,
  drive it through ring/wait/speak/listen/confirm, tear it down. No state persists between calls.
- **`LoopbackChannel`/`LoopbackTts`/`LoopbackStt`** (`src/channels/loopback.ts`) — scriptable
  fakes implementing the same interfaces, used for all orchestrator unit tests and available to
  integrators who want to test their own workflow without touching Discord or ElevenLabs.

See the full design doc: [`docs/superpowers/specs/2026-08-05-et-phone-home-design.md`](docs/superpowers/specs/2026-08-05-et-phone-home-design.md).

## Runtime notes

- Verified running under **Bun on Windows**.
- The native `@discordjs/opus` addon **does not load under Bun** on this platform (a Node-ABI
  mismatch between what Bun reports and what the package's prebuilt binaries target) — the
  working opus path is `opusscript` (pure JS/WASM), which `prism-media`'s own loader falls back
  to automatically once it finds the native addon unusable.
- **Node 22** runs the entire stack natively, including the native `@discordjs/opus` binary, as a
  working fallback runtime if needed.
- No FFmpeg installation is required.

## Troubleshooting a failed call

Every failure comes back as a `HumanResponse` with `status: "error"` and an `error` field holding
the message plus its whole `cause` chain, printed to stderr by the CLI. Start there — it usually
names the problem outright (an invalid ElevenLabs key, a voice the plan cannot use, a channel the
bot was never invited to).

**"voice connection … was not ready within 20000 ms"** is the one failure that is almost never
about the bot. Login, the text ping, and ElevenLabs all run over ordinary HTTPS; the voice
websocket connects to a `*.discord.media` host on its own port, so it is the single leg a
restrictive or broken network breaks by itself. To find out which phase stalls:

```bash
bun run scripts/voice-trace.ts
```

It reports how long the handshake spent in each phase and what a stall there means, then prints a
reachability check for the exact endpoint Discord assigned. Common causes:

- **A firewall or VPN blocking `*.discord.media`** — the trace stalls in `OpeningWs`.
- **IPv6 that is advertised but does not route.** Also stalls in `OpeningWs`: hosts resolve
  IPv6-first, and packets are dropped rather than rejected, so each attempt hangs until the TCP
  timeout even though IPv4 to the same host works. Set `ETPH_PREFER_IPV4=true` to resolve IPv4
  first. It is off by default because flipping the order unconditionally would break IPv6-only
  networks the same way, and because a dead IPv6 route is a real fault worth seeing.
- **Blocked outbound UDP** — the trace stalls in `UdpHandshaking`.
- **A wedged voice session** — the trace never leaves `Signalling`; try a brand-new voice channel.

Because the whole voice path depends on the network it runs on, a bot that works on one network
can fail on another with no code change at all.

## Testing

```bash
bun test              # unit tests — no credentials required, no network calls
bun run typecheck      # TypeScript type checking
```

A credential-gated live integration test (`tests/integration/discord-call.test.ts`) places a real
Discord call and makes real ElevenLabs API calls; it costs money and needs a human present to
answer. It's skipped automatically unless these env vars are all set:

```
ETPH_DISCORD_BOT_TOKEN
ETPH_DISCORD_GUILD_ID
ETPH_DISCORD_TEXT_CHANNEL_ID
ETPH_DISCORD_VOICE_CHANNEL_ID
ETPH_DISCORD_USER_ID
ETPH_ELEVENLABS_API_KEY
ETPH_ELEVENLABS_VOICE_ID
```

## Roadmap / future work

- **Inbound calls** — the switchboard daemon still only rings out; a human calling the agent's
  Discord identity directly (rather than only ever being the one who gets pinged) would need the
  gateway connection to accept that direction too. The `CommunicationChannel` interface already
  carries a `capabilities.inbound` flag (`false` for the current Discord channel) reserved for
  this.
- **Concurrent conversations** — the switchboard queues one call at a time by design (one bot,
  one voice channel per guild). A pool of bot identities/voice channels behind the same queue
  worker seam would allow true parallelism if queue latency ever becomes a real problem.
- **Teams channel** — a `CommunicationChannel` implementation over the Microsoft Graph
  communications API.
- **Twilio phone channel** — a real phone call, sidestepping Discord's no-DM-ring constraint
  entirely.
- **Streaming STT** — swap the current record-then-transcribe call for a streaming provider to
  cut latency between the human finishing speaking and the confirmation prompt.
