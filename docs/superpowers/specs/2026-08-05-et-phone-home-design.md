# et-phone-home — Design Doc

## Overview

Autonomous agent workflows regularly hit human-in-the-loop steps. Today that typically means a
comment, notification, or ticket the human must notice and type a reply to. **et-phone-home**
makes the agent **call the human instead**: it receives a question as text, rings the human over
a voice channel, speaks the question aloud (TTS), listens to the spoken answer, transcribes it
(STT), and returns the text to the agent workflow.

It ships as a TypeScript library with one entry function (`ask`), plus a thin CLI so
non-TypeScript workflows can shell out instead of importing a package.

## Design goals

Decisions confirmed during brainstorming, in force throughout the implementation:

- **Easy to embed**: a single library entry function (`ask`) that resolves settings, wires
  default production dependencies, and drives the call; a CLI (`et-phone-home ask "<question>"`)
  for workflows that aren't TypeScript.
- **Interface-driven**: communication channels (Discord first; Teams/phone later), text-to-speech,
  and speech-to-text are all pluggable behind interfaces, injected as dependencies rather than
  hardwired.
- **MVP channel: Discord voice**, subject to the constraint that Discord bots cannot ring a DM —
  see "Discord channel specifics" below.
- **Speech provider: ElevenLabs** for both TTS and STT (Scribe), behind the same interfaces any
  other provider would implement.
- **Call flow: question → answer → confirmation** ("I heard: … — is that correct?"), capped at a
  configurable number of rounds (default 3).
- **No built-in fallback on no-answer**: the result carries `answered: boolean` and a specific
  `status`; the calling workflow decides what to do next (retry, escalate, proceed without input).
- **Settings are introspectable**: a Zod schema is the single source of truth, with per-field
  metadata (`description`, `secret`, `default`, `required`) exported so integrators can render
  their own settings UI, plus loaders for env vars, a JSON file, and a plain object.
- **Architecture: per-call session**, not a long-running daemon. Each `ask()` call is stateless:
  connect, ask, disconnect. A future daemon mode enabling inbound calls is documented but not
  built — the interfaces are shaped so it can be added without breaking changes (see Future work).

## Architecture

### Per-call session model

Every call to `askHuman` (or the `ask` convenience wrapper) is self-contained: it asks a
`CommunicationChannel` to create a fresh `ChannelSession`, drives that session through the
question/answer/confirm flow, and tears it down. No state is held between calls — the channel
implementation owns whatever connection setup and teardown it needs (for Discord: log in, join
a voice channel, then destroy the client). This keeps the orchestrator trivially testable (fakes
in, deterministic assertions out) and keeps a crashed or hung call from poisoning the next one.

### `askHuman` state machine

`askHuman(question, settings, opts, deps)` in `src/core/ask-human.ts` is a pure function over its
`AskDeps` (`channel`, `tts`, `stt`) — there is no default wiring inside it; `buildDefaultDeps` in
`src/index.ts` supplies the production instances (`DiscordChannel` + `ElevenLabsTts` +
`ElevenLabsStt`) for the `ask()` one-liner.

Flow:

1. `channel.createSession({ question })` — configuration/connection errors here are allowed to
   propagate (they mean the setup is broken, not that the human didn't answer).
2. `session.ring()` — notify the human a question is waiting. Must run before `waitForHuman`, or
   a real call will always time out.
3. `session.waitForHuman(joinTimeoutMs)` — resolves `false` on timeout → status `no_pickup`.
4. `session.speak(tts.synthesize(question))`, then `session.listen({ silenceMs, maxMs })` —
   `null` (nothing said) → status `no_speech`.
5. **Confirm loop**, up to `confirmRounds` iterations: transcribe what was heard, speak back
   `I heard: "<transcript>" — is that correct? Please answer yes or no.`, listen again.
   - Affirmative reply (case-insensitive, word-boundary match against `affirmativeWords`, e.g.
     `yesterday` does not match `yes`) → status `answered`, `answer` = the confirmed transcript.
   - Empty transcript or silence during confirm → consumes a round, re-prompts.
   - Negative/other reply → asks for a fresh answer, which the next round attempts to confirm.
   - Rounds exhausted without an affirmation → status `not_confirmed`.
6. Any exception during the ring/wait/speak/listen/confirm sequence is caught → status `error`.
7. `session.hangUp()` always runs (`finally`), and must be idempotent.

The function never rejects once a session exists — every path returns a typed `HumanResponse`.
It only throws before that point, for configuration/connection failures.

`HumanResponse` fields (`src/types/index.ts`):

```ts
interface HumanResponse {
  answered: boolean;   // true only when status === 'answered'
  answer: string | null; // confirmed transcript; null when !answered
  status: 'answered' | 'no_pickup' | 'no_speech' | 'not_confirmed' | 'error';
  channel: string;      // channel name, e.g. 'discord'
  durationMs: number;   // wall time of the whole ask
}
```

### Interfaces

```ts
interface CommunicationChannel {
  readonly name: string;
  readonly capabilities: { outbound: true; inbound: boolean };
  createSession(req: AskRequest): Promise<ChannelSession>;
}

interface ChannelSession {
  ring(): Promise<void>;
  waitForHuman(timeoutMs: number): Promise<boolean>;
  speak(audio: AudioData): Promise<void>;
  listen(opts: { silenceMs: number; maxMs: number }): Promise<AudioData | null>;
  hangUp(): Promise<void>;
}

interface TextToSpeech { synthesize(text: string): Promise<AudioData>; }
interface SpeechToText { transcribe(audio: AudioData): Promise<string>; }
```

- `CommunicationChannel` is the channel-level handle: a name for reporting, a capability
  descriptor (`outbound` is always `true`; `inbound` is a forward-looking flag — see Future work),
  and a factory for sessions. `DiscordChannel` is the only implementation today.
- `ChannelSession` is the per-call handle a channel hands back: notify, wait for pickup, play
  audio, capture audio, tear down. `askHuman` only ever talks to this interface, never to
  Discord-specific types, which is what keeps the orchestrator and its tests channel-agnostic
  (`LoopbackChannel` in `src/channels/loopback.ts` is a scriptable fake implementing the same
  interface, used for all orchestrator unit tests).
- `TextToSpeech` / `SpeechToText` are single-method interfaces around `AudioData` (raw PCM plus
  `sampleRate`/`channels`), implemented today by `ElevenLabsTts`/`ElevenLabsStt`
  (`src/speech/elevenlabs/`) and by `LoopbackTts`/`LoopbackStt` for tests.

### Settings introspection contract

`src/settings/schema.ts` defines one Zod object (`settingsSchema`) covering `discord.*`,
`elevenlabs.*`, `call.*`, and `channel`. Walking that schema at module load time produces
`settingsFields: SettingsField[]`, one entry per leaf field:

```ts
interface SettingsField {
  path: string;      // e.g. 'discord.botToken', 'call.joinTimeoutMs'
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description: string; // from the schema's .describe()
  secret: boolean;     // true for discord.botToken, elevenlabs.apiKey
  default?: unknown;   // present when the field has a Zod default
  required: boolean;   // true when there is no default
}
```

This lets an integrator render a settings UI (or CLI help text — `et-phone-home help` uses it
directly) without hand-maintaining a second list of fields. `resolveSettings` (`src/settings/
load.ts`) uses the same `settingsFields` list to map each path to an `ETPH_`-prefixed
upper-snake-case env var (`discord.botToken` → `ETPH_DISCORD_BOT_TOKEN`), then merges
env → JSON file → plain object (later sources win) and validates the result with
`settingsSchema.safeParse`, throwing a formatted `Invalid configuration:\n  - path: message`
error on failure.

## Discord channel specifics

Discord bots **cannot ring a DM** — there is no API to make a bot-initiated voice call ring a
user's client the way a person-to-person call does. `DiscordChannel`/`DiscordSession`
(`src/channels/discord/`) work around this with the only mechanism Discord bots do have:

1. `ring()` posts a text mention of the user in a configured text channel
   (`settings.discord.textChannelId`), pointing at the configured voice channel.
2. `waitForHuman()` watches gateway `voiceStateUpdate` events (and checks whether the user is
   already present) for that user joining the configured voice channel
   (`settings.discord.voiceChannelId`); once they do, the bot itself joins via
   `joinVoiceChannel`.

This means the "call" is really "text ping, then meet in a voice channel" — closer to a
scheduled meeting than a phone ring, and it is why `capabilities.inbound` is `false` for this
channel: the bot can only place outbound asks, never receive an unsolicited voice connection
from the human (that requires a persistent gateway connection — see Future work).

**Bun/opusscript constraint.** A throwaway feasibility spike (`scratch/spike-voice-offline.ts`,
recorded in `task-0a-report.md`) verified the Discord voice dependency stack — `discord.js`,
`@discordjs/voice`, opus encode/decode, the sodium encryption library, and DAVE E2EE — under Bun
on Windows before any production code was written. On that tested runtime, `@discordjs/opus`'s
native N-API addon **does not load at all**: it fails deterministically with a Node-ABI-version
mismatch (Bun reports `process.versions.modules = 137`; the package's prebuild packaging ships/
resolves the `node-v127` binary instead, and no matching `node-v137` prebuild exists), not an
occasional or environment-flaky failure. `opusscript` — a pure JS/WASM opus codec with no native
binary to load — is the only proven-working opus path on Bun/Windows, and it is what carries
**all** opus traffic in this project today via `prism-media`'s own loader, which falls through to
it automatically once it finds the native addon unusable. `opusscript`'s WASM encode/decode has
different CPU and latency characteristics than the native codec would; that overhead was not
benchmarked beyond a single-frame roundtrip in the spike. The native addon remains a possible
faster path only under Node (where the same spike verified it loads and works with zero
workarounds) or under a future Bun release / `@discordjs/opus` prebuild matrix that closes the
ABI gap — re-run the spike to re-verify before assuming either has changed. `session.ts` itself
only calls into `prism-media`'s `opus.Decoder` (for incoming audio) and hands raw PCM to
`@discordjs/voice`'s `createAudioResource` with `StreamType.Raw` (for outgoing audio) — it never
talks to an opus library directly, so whichever backend `prism-media` resolves to is transparent
to the session code.

## Future work

- **Daemon mode / inbound calls**: a persistent process holding the Discord gateway connection
  open (rather than the current per-call login/destroy cycle), with `capabilities.inbound = true`.
  This would let the human call/speak to the agent's Discord identity directly instead of only
  ever being the one who gets pinged, with a local HTTP/IPC surface for thin clients to register
  handlers for inbound speech. The `CommunicationChannel`/`ChannelSession` interfaces were shaped
  with this in mind — nothing about `ring`/`waitForHuman`/`speak`/`listen`/`hangUp` assumes a
  short-lived connection, so a daemon-backed implementation should be additive rather than
  requiring interface changes.
- **More channels**: a Teams channel (Microsoft Graph communications API) and a Twilio phone
  channel, both implementing the same `CommunicationChannel` contract — real phone calls in
  particular would sidestep the no-DM-ring constraint entirely.
- **Streaming STT**: swapping the current record-then-transcribe `SpeechToText.transcribe` call
  for a streaming provider (e.g. Deepgram) to cut the latency between the human finishing speaking
  and the confirmation prompt.
