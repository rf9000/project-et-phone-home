# Switchboard Daemon — Design

**Date:** 2026-08-20
**Status:** Approved (design review in chat)

## Problem

Multiple independent agents want to place calls concurrently. The concrete driver: an agent
workflow that picks up ADO coding assignments and specs them — up to ~10 work items running
independently, each owned by a *different* human, each needing a call when questions arise
during spec'ing.

Today each `ask()` logs in its own Discord client with the same bot token. A Discord bot can
occupy only one voice channel per guild, so a second concurrent call moves the bot and destroys
the first call's voice connection. Same-process concurrent asks additionally race on
`@discordjs/voice`'s global connection registry. Concurrent calling is therefore undefined
behavior today.

## Decisions already made (with rationale)

- **Queue, not parallelism.** Agents are long-running async workflows; waiting tens of minutes
  is acceptable. One bot, one conversation at a time. (Parallelism would require a pool of bot
  applications + voice channels; deferred until queue latency demonstrably hurts.)
- **Coordinator daemon, not lock files.** Callers may be same-machine processes, tasks inside
  one process, or distributed machines — only a network-reachable coordinator covers all three.
- **Owner→Discord mapping stays out of et-phone-home.** The ADO workflow resolves work-item
  owner → Discord user ID itself and passes the ID per ask. This tool routes calls; it does not
  do identity.
- **The daemon composes the existing `askHuman` verbatim.** The live-verified call path is not
  reimplemented or modified.

## Architecture

```
agents (any machine) --HTTP--> switchboard daemon --> FIFO queue --> worker (serial) --> askHuman()
```

- New `src/server/` module (the switchboard): HTTP server on `Bun.serve` (no new deps),
  in-memory FIFO queue, single worker loop.
- Started via new CLI command: `et-phone-home serve`.
- The daemon owns all credentials (Discord bot token, ElevenLabs key). Agents never see them.

## HTTP API

Submit-then-poll. (A held-open request for a call that may queue 30+ minutes fights every HTTP
timeout between client and server, so no synchronous mode.)

```
POST   /ask
       body: { question, userId, textChannelId?, voiceChannelId?, queueTimeoutMs?, call?: {...} }
       -> 202 { id, position }

GET    /ask/:id            optional ?waitMs=30000 long-poll
       -> { state, position?, result? }

DELETE /ask/:id
       -> cancels if still queued; 409 if the call is in progress
```

- `userId` is the Discord user ID of the human to call. Any field not overridden falls back to
  the daemon's own settings.
- `waitMs` long-poll is capped at 60 000 ms per request; the response returns the current
  state when the cap elapses and the client simply polls again.
- Job id: `crypto.randomUUID()`.
- Job state machine: `queued -> calling -> done | expired | cancelled`.
- When `done`, `result` is a verbatim `HumanResponse` (including the `error` cause-chain field).
  The `HumanResponse` public contract is untouched; job state is a separate wrapper.

### Auth & binding

- Optional shared bearer token: `ETPH_SERVER_AUTH_TOKEN`. When set, every request must carry
  `Authorization: Bearer <token>`; otherwise 401.
- Default bind `127.0.0.1`. Binding to a non-loopback host with no auth token set is refused at
  startup (prevents an accidental open "ring anyone" endpoint on the network).

### Settings

New `server` group in the Zod schema (additive; `settingsFields` introspection and CLI help pick
it up automatically):

| Field | Env var | Default | Notes |
|---|---|---|---|
| `server.host` | `ETPH_SERVER_HOST` | `127.0.0.1` | |
| `server.port` | `ETPH_SERVER_PORT` | `3117` | |
| `server.authToken` | `ETPH_SERVER_AUTH_TOKEN` | `""` (off) | secret; required for non-loopback bind |

## Queue semantics

- In-memory FIFO, single worker. Worker takes the head job, merges its overrides onto daemon
  settings, runs `askHuman`, stores the result, moves on.
- No priorities, no coalescing, no batching (YAGNI at ~10 items).
- **Two distinct clocks:**
  - `queueTimeoutMs` (caller-set, default infinite): max wait *before the call starts*. Checked
    when the worker would pick the job up — an expired job never rings anyone. State -> `expired`.
  - Existing per-call clocks (`joinTimeoutMs`, `maxListenMs`, `confirmRounds`...) govern the call
    itself, unchanged. A `no_pickup` is a *completed* job whose result says `no_pickup`; the
    agent decides whether to re-submit.
- Worst-case latency is accepted: each job ahead can burn ring + joinTimeoutMs (default 2 min)
  + conversation time.
- **Result retention:** finished jobs kept 1 hour, then GC'd. Polling a GC'd/unknown id -> 404.
- **Daemon restart loses the queue** (in-memory by design, v1). The failure is loud: pollers get
  connection-refused and treat it as infrastructure failure — re-submit or proceed. A persistence
  journal (SQLite/JSONL) is a clean later addition behind the queue interface; explicitly out of
  scope for v1.

## Error handling

| Case | Response |
|---|---|
| Invalid body | 400 with field errors from the same Zod validation used elsewhere |
| Missing/bad bearer token | 401 |
| Unknown/GC'd job id | 404 |
| Cancel while `calling` | 409 (never hang up on a human mid-sentence) |
| Crash inside a call | job `done` with `status:"error"` + `error` cause chain on the result |

## Client mode

- **CLI:** `ask` gains `--server <url>`, `--user <discordUserId>`, `--queue-timeout <seconds>`.
  Submits, long-polls, prints answer/JSON with the same stdout purity and exit codes as today
  (0 answered / 2 not answered / 1 usage-config-or-unreachable). Without `--server`, direct
  local behavior is unchanged.
- **Library:** `SwitchboardClient` with `ask(question, opts): Promise<HumanResponse>` doing the
  same submit+poll for TypeScript agents.

## Testing

All offline, mirroring the existing loopback pattern:

- Switchboard takes `deps` injection like everything else. Tests boot a real `Bun.serve` on
  port 0 with `LoopbackChannel`/`LoopbackTts`/`LoopbackStt` and exercise real HTTP.
- Coverage: serialization (job 2 starts only after job 1 completes), queue-timeout expiry,
  cancel races (queued vs calling), auth on/off, non-loopback-bind-without-token startup
  refusal, 400/404 paths, long-poll behavior, result retention/404 after GC, client submit+poll
  round trip, CLI exit codes in server mode.
- No Discord, no ElevenLabs, no credentials in any of it. The live integration test stays as-is
  (gated on `ETPH_LIVE_TEST=1`).

## Out of scope (v1)

- Queue persistence across daemon restarts.
- Bot-token pool for parallel conversations (the queue worker is the seam: N workers x N bot
  identities later).
- Question batching into one call session per human.
- Owner->Discord identity mapping.
- Inbound calls (human rings the agent) — `ChannelCapabilities.inbound` remains reserved.
