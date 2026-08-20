# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

et-phone-home is a library + CLI that calls a human on Discord voice from an agent workflow: it
speaks a question via text-to-speech, listens for a spoken reply, transcribes it, and returns the
confirmed answer as text. It ships as a TypeScript library with one entry function (`ask`) plus a
thin CLI (`et-phone-home ask "<question>"`) for non-TypeScript workflows.

## Architecture

- **Runtime:** Bun (TypeScript), Node 22 as a verified fallback runtime for the Discord voice stack.
- **Validation:** Zod is the single source of truth for settings (`src/settings/schema.ts`); no
  other runtime dependency beyond Zod and the Discord voice stack (`discord.js`,
  `@discordjs/voice`, `prism-media`, `opusscript`, `libsodium-wrappers`, `@snazzah/davey`) and
  ElevenLabs (called over plain `fetch`, no SDK dependency).
- **Interface-driven DI**: `CommunicationChannel`/`ChannelSession`, `TextToSpeech`, `SpeechToText`
  are all pluggable interfaces (`src/types/index.ts`). `askHuman` takes its dependencies as an
  explicit `deps` parameter (deps-last pattern) — it is a pure function with no default wiring;
  `buildDefaultDeps` (`src/index.ts`) is what supplies the production instances.
- **Testing:** Bun's built-in test framework. `LoopbackChannel`/`LoopbackTts`/`LoopbackStt`
  (`src/channels/loopback.ts`) are scriptable fakes used for all orchestrator unit tests so no
  test touches Discord or ElevenLabs.

## Commands

- `bun test` — run all unit tests (no credentials required)
- `bun run typecheck` — TypeScript type checking
- `bun run ask "<question>"` — run a real call via the CLI

## File Layout

- `src/types/` — shared interfaces (`CommunicationChannel`, `ChannelSession`, `TextToSpeech`,
  `SpeechToText`, `AudioData`, `HumanResponse`)
- `src/settings/` — Zod schema (`schema.ts`) and env/file/object loader (`load.ts`)
- `src/core/` — `askHuman` orchestrator (ring → wait → speak → listen → confirm loop → hang up)
- `src/speech/` — ElevenLabs TTS/STT clients (`speech/elevenlabs/`), plus shared HTTP and WAV
  helpers
- `src/channels/discord/` — Discord channel/session implementation
- `src/channels/loopback.ts` — in-memory fake channel/TTS/STT for tests and integrators
- `src/cli/` — CLI entry point (arg parsing, `help`/`ask` commands, exit codes)
- `src/index.ts` — public library entry point (`ask`, `buildDefaultDeps`, and all re-exports)
- `tests/` — mirrors `src/` structure; `tests/integration/` holds the live Discord/ElevenLabs
  test, skipped unless `ETPH_LIVE_TEST=1` is set on top of all required `ETPH_*` credentials
  (the explicit opt-in exists because Bun auto-loads `.env`, so credentials alone would make
  every bare `bun test` place a real call)

## Key Constraints

- **Never import `@discordjs/opus` directly.** Its native N-API addon fails to load under Bun on
  Windows (Node-ABI mismatch between what Bun reports and what the package's prebuilds target).
  Opus traffic must go through `prism-media`, which falls back to the pure JS/WASM `opusscript`
  codec automatically once it finds the native addon unusable.
- **stdout purity in the CLI**: stdout carries only the machine-readable result (the plain-text
  answer, or the JSON blob with `--json`); everything else — usage, help, diagnostics — goes to
  stderr.
- **`settingsFields` introspection is a public contract.** It is derived from `settingsSchema` and
  used both by the CLI's `help` text and by any host tool that wants to render its own settings
  UI. Changing a field's `.describe()`, default, or shape changes that contract — keep
  `src/settings/schema.ts` as the single source of truth rather than duplicating field lists
  elsewhere.
- **Confirm-loop prompt strings are load-bearing.** `src/core/ask-human.ts` speaks exact strings
  (`I heard: "<transcript>" — is that correct? Please answer yes or no.` and `Okay, please repeat
  your answer.`) that tests assert on directly — do not reword them without updating
  `tests/core/ask-human.test.ts`.
