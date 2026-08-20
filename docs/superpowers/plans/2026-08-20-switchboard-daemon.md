# Switchboard Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running daemon that serializes calls from many independent agents through one Discord bot, exposed over HTTP with submit-then-poll semantics.

**Architecture:** New `src/server/` module: an in-memory FIFO `AskQueue` with a single worker that invokes the existing `askHuman` verbatim (injectable `runAsk` for tests), fronted by a `Bun.serve` HTTP layer with three endpoints, plus a `SwitchboardClient` and CLI wiring (`serve` command, `ask --server`). No new dependencies.

**Tech Stack:** Bun (runtime, `Bun.serve`, `bun:test`), TypeScript, Zod (validation only — already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-20-switchboard-daemon-design.md`

## Global Constraints

- Runtime is Bun; tests run with `bun test`, typecheck with `bun run typecheck` (tsc --noEmit).
- No new runtime dependencies. HTTP server is `Bun.serve`; validation is Zod.
- Never import `@discordjs/opus` directly (existing repo constraint; this plan touches no audio code).
- CLI stdout purity: stdout carries only the machine-readable result; usage/diagnostics/errors go to stderr.
- `src/settings/schema.ts` is the single source of truth for settings; new fields are added there only.
- The `HumanResponse` public contract is NOT modified. Job state is a separate wrapper.
- The live integration test gate (`ETPH_LIVE_TEST=1`) is untouched; every test in this plan is offline.
- Run the full offline verification before each commit: `bun run typecheck && bun test` (integration tests self-skip).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `src/settings/schema.ts` (modify) | New `server` settings group (host/port/authToken) |
| `src/deps.ts` (create) | `buildDefaultDeps` moved here from `src/index.ts` (breaks an import cycle: server needs it, index re-exports server) |
| `src/server/queue.ts` (create) | Job model + `AskQueue`: FIFO, single worker, expiry, cancel, GC, long-poll wait |
| `src/server/run-ask.ts` (create) | `makeDefaultRunAsk(settings)`: merges a job request onto daemon settings, calls `askHuman` |
| `src/server/http.ts` (create) | `startSwitchboard(settings, deps?)`: routes, body validation, auth, bind guard |
| `src/server/client.ts` (create) | `SwitchboardClient`: submit + long-poll, returns `HumanResponse` |
| `src/cli/index.ts` (modify) | `serve` command; `--server`, `--user`, `--queue-timeout` flags on `ask` |
| `src/index.ts` (modify) | Re-export deps.ts + server modules |
| `.env.example`, `README.md`, `CLAUDE.md` (modify) | Document the server settings and commands |
| `tests/server/queue.test.ts`, `tests/server/http.test.ts`, `tests/server/client.test.ts` (create); `tests/settings/schema.test.ts`, `tests/cli/args.test.ts` (modify) | Offline coverage |

---

### Task 1: `server` settings group

**Files:**
- Modify: `src/settings/schema.ts` (inside the `settingsSchema` object, after the `channel` field; and the `SECRET_PATHS` set)
- Modify: `tests/settings/schema.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `settingsSchema` / `settingsFields` machinery.
- Produces: `settings.server: { host: string; port: number; authToken: string }` with defaults `'127.0.0.1'` / `3117` / `''`. Env vars `ETPH_SERVER_HOST`, `ETPH_SERVER_PORT`, `ETPH_SERVER_AUTH_TOKEN` (auto-derived by the existing loader). `server.authToken` is secret.

- [ ] **Step 1: Write the failing tests**

In `tests/settings/schema.test.ts`, extend the expected path list in the `'contains an entry for every leaf field'` test — add these three entries next to `'channel'`:

```ts
        'server.host',
        'server.port',
        'server.authToken',
```

And add these tests at the end of the `describe('settingsFields', ...)` block:

```ts
  test('server fields have defaults and correct types', () => {
    expect(findField('server.host').default).toBe('127.0.0.1');
    expect(findField('server.port').default).toBe(3117);
    expect(findField('server.port').type).toBe('number');
    expect(findField('server.authToken').default).toBe('');
  });

  test('server.authToken is secret', () => {
    expect(findField('server.authToken').secret).toBe(true);
    expect(findField('server.authToken').required).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/settings/schema.test.ts`
Expected: FAIL — path-list mismatch and `no settingsField for path server.host`.

- [ ] **Step 3: Implement the schema group**

In `src/settings/schema.ts`, after the `channel` field (still inside `settingsSchema`'s object), add:

```ts
  server: z
    .object({
      host: z
        .string()
        .min(1)
        .default('127.0.0.1')
        .describe('Host interface the switchboard server binds to.'),
      port: z.number().default(3117).describe('Port the switchboard server listens on.'),
      authToken: z
        .string()
        .default('')
        .describe(
          'Bearer token the switchboard server requires on every request. Empty disables auth, which is only allowed on loopback binds.',
        ),
    })
    .default({ host: '127.0.0.1', port: 3117, authToken: '' })
    .describe('Switchboard server settings (used by `et-phone-home serve`).'),
```

And extend `SECRET_PATHS`:

```ts
const SECRET_PATHS = new Set<string>(['discord.botToken', 'elevenlabs.apiKey', 'server.authToken']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass (the full-object test in schema.test.ts does not assert on `server`, so no other edits needed).

- [ ] **Step 5: Document env vars**

Append to `.env.example`:

```
# Host interface the switchboard server binds to.
# ETPH_SERVER_HOST=127.0.0.1

# Port the switchboard server listens on.
# ETPH_SERVER_PORT=3117

# Bearer token the switchboard server requires on every request. Empty disables auth (loopback binds only). (secret)
# ETPH_SERVER_AUTH_TOKEN=
```

- [ ] **Step 6: Commit**

```bash
git add src/settings/schema.ts tests/settings/schema.test.ts .env.example
git commit -m "feat: server settings group (host/port/authToken) for the switchboard"
```

---

### Task 2: Extract `buildDefaultDeps` to `src/deps.ts`

Pure move, no behavior change. Reason: `src/server/run-ask.ts` (Task 5) needs `buildDefaultDeps`, and `src/index.ts` will re-export the server modules (Task 8) — importing index from server would create a cycle.

**Files:**
- Create: `src/deps.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `buildDefaultDeps(settings: Settings): AskDeps` importable from `src/deps.ts`. `src/index.ts` re-exports it unchanged, so all existing imports keep working.

- [ ] **Step 1: Create `src/deps.ts`**

Move the entire `buildDefaultDeps` function body (and only it) from `src/index.ts`, with its imports:

```ts
// Default production wiring, in its own module so src/server/* can use it without importing
// src/index.ts (which re-exports the server modules — that would be an import cycle).

import type { AskDeps } from './core/ask-human.ts';
import type { Settings } from './settings/schema.ts';
import { DiscordChannel } from './channels/discord/channel.ts';
import { ElevenLabsTts } from './speech/elevenlabs/tts.ts';
import { ElevenLabsStt } from './speech/elevenlabs/stt.ts';
import { DumpingStt } from './speech/debug.ts';

/**
 * Builds the production dependency set implied by `settings`: the channel named by
 * `settings.channel` (currently only 'discord') plus ElevenLabs TTS/STT. This is the wiring
 * `ask()` uses; exported separately so callers who want askHuman directly can still get the
 * default deps without re-deriving them.
 */
export function buildDefaultDeps(settings: Settings): AskDeps {
  const channel = new DiscordChannel(settings.discord);
  const tts = new ElevenLabsTts({
    apiKey: settings.elevenlabs.apiKey,
    voiceId: settings.elevenlabs.voiceId,
    model: settings.elevenlabs.ttsModel,
  });
  const elevenLabsStt = new ElevenLabsStt({
    apiKey: settings.elevenlabs.apiKey,
    model: settings.elevenlabs.sttModel,
  });
  // With debugAudioDir set, every captured utterance is also written to disk as a WAV so a
  // human can hear exactly what the bot heard when a transcript comes back wrong.
  const stt =
    settings.call.debugAudioDir === ''
      ? elevenLabsStt
      : new DumpingStt(elevenLabsStt, settings.call.debugAudioDir);

  return { channel, tts, stt };
}
```

- [ ] **Step 2: Update `src/index.ts`**

Delete the moved function. Add the re-export and use the import inside `ask()`:

```ts
export { buildDefaultDeps } from './deps.ts';
```

```ts
import { buildDefaultDeps } from './deps.ts';
```

Remove imports that became unused in `src/index.ts` (`DiscordChannel`, `ElevenLabsTts`, `ElevenLabsStt`, `DumpingStt` as *value* imports — the `export { ... } from` re-export lines for these classes stay untouched).

- [ ] **Step 3: Verify no behavior change**

Run: `bun run typecheck && bun test`
Expected: all pass, no test edits needed.

- [ ] **Step 4: Commit**

```bash
git add src/deps.ts src/index.ts
git commit -m "refactor: move buildDefaultDeps to src/deps.ts to pre-empt server import cycle"
```

---

### Task 3: `AskQueue` core — submit, serial worker, results

**Files:**
- Create: `src/server/queue.ts`
- Test: `tests/server/queue.test.ts`

**Interfaces:**
- Consumes: `HumanResponse` from `src/types/index.ts`.
- Produces (used by Tasks 4-6):

```ts
export type JobState = 'queued' | 'calling' | 'done' | 'expired' | 'cancelled';
export interface AskJobRequest {
  question: string;
  userId: string;
  textChannelId?: string;
  voiceChannelId?: string;
  queueTimeoutMs?: number;
  call?: {
    joinTimeoutMs?: number;
    silenceMs?: number;
    maxListenMs?: number;
    confirmRounds?: number;
    affirmativeWords?: string[];
  };
}
export interface AskJob {
  id: string;
  state: JobState;
  request: AskJobRequest;
  enqueuedAt: number;
  finishedAt?: number;
  result?: HumanResponse; // present when state === 'done'
}
export interface AskQueueOptions {
  runAsk: (request: AskJobRequest) => Promise<HumanResponse>;
  resultTtlMs?: number; // default 3_600_000
  now?: () => number;   // injectable clock; default Date.now
}
export class AskQueue {
  constructor(opts: AskQueueOptions);
  submit(request: AskJobRequest): { id: string; position: number };
  get(id: string): AskJob | undefined;
  position(id: string): number | undefined; // 1 = next up or in progress; undefined when not queued
  stop(): void; // no new jobs start; in-flight call finishes
}
```

Position semantics: `position` = jobs that must finish before this one starts, plus one — i.e. submitting to an empty, idle queue returns 1; submitting while one call is in progress and none queued returns 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/queue.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { AskQueue } from '../../src/server/queue.ts';
import type { AskJobRequest } from '../../src/server/queue.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

/** runAsk fake whose promises resolve only when the test says so. */
function deferredRunAsk() {
  const calls: Array<{ request: AskJobRequest; resolve: (r: HumanResponse) => void }> = [];
  const runAsk = (request: AskJobRequest): Promise<HumanResponse> =>
    new Promise<HumanResponse>((resolve) => {
      calls.push({ request, resolve });
    });
  return { calls, runAsk };
}

const REQ: AskJobRequest = { question: 'q?', userId: 'user-1' };

describe('AskQueue core', () => {
  test('submit returns id and 1-based position', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });

    const first = queue.submit(REQ);
    await Bun.sleep(0); // let the worker pick it up
    const second = queue.submit({ ...REQ, userId: 'user-2' });

    expect(first.id).not.toBe(second.id);
    expect(first.position).toBe(1);
    expect(second.position).toBe(2); // one call in progress ahead of it
    expect(calls.length).toBe(1);
    expect(queue.get(first.id)?.state).toBe('calling');
    expect(queue.get(second.id)?.state).toBe('queued');
    expect(queue.position(second.id)).toBe(2);
  });

  test('strictly serial: second call starts only after the first resolves', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });

    const a = queue.submit(REQ);
    const b = queue.submit({ ...REQ, userId: 'user-2' });
    await Bun.sleep(0);
    expect(calls.length).toBe(1); // b not started

    calls[0]!.resolve(answered('A'));
    await Bun.sleep(0);
    expect(calls.length).toBe(2); // b started only now
    expect(queue.get(a.id)?.state).toBe('done');
    expect(queue.get(a.id)?.result).toEqual(answered('A'));
    expect(queue.get(b.id)?.state).toBe('calling');

    calls[1]!.resolve(answered('B'));
    await Bun.sleep(0);
    expect(queue.get(b.id)?.result?.answer).toBe('B');
  });

  test('a rejecting runAsk becomes a done job with an error-status result', async () => {
    const queue = new AskQueue({
      runAsk: () => Promise.reject(new Error('guild not found')),
    });
    const { id } = queue.submit(REQ);
    await Bun.sleep(0);

    const job = queue.get(id);
    expect(job?.state).toBe('done');
    expect(job?.result?.status).toBe('error');
    expect(job?.result?.error).toContain('guild not found');
  });

  test('get of unknown id returns undefined', () => {
    const queue = new AskQueue({ runAsk: () => Promise.resolve(answered('x')) });
    expect(queue.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/queue.test.ts`
Expected: FAIL — cannot resolve `src/server/queue.ts`.

- [ ] **Step 3: Implement `src/server/queue.ts`**

```ts
import type { HumanResponse } from '../types/index.ts';

export type JobState = 'queued' | 'calling' | 'done' | 'expired' | 'cancelled';

/** One ask as submitted over the wire. `call` fields mirror AskOptions. */
export interface AskJobRequest {
  question: string;
  userId: string;
  textChannelId?: string;
  voiceChannelId?: string;
  queueTimeoutMs?: number;
  call?: {
    joinTimeoutMs?: number;
    silenceMs?: number;
    maxListenMs?: number;
    confirmRounds?: number;
    affirmativeWords?: string[];
  };
}

export interface AskJob {
  id: string;
  state: JobState;
  request: AskJobRequest;
  enqueuedAt: number;
  finishedAt?: number;
  /** Present when state === 'done' — a verbatim HumanResponse. */
  result?: HumanResponse;
}

export interface AskQueueOptions {
  /** Places the actual call. Injectable so tests never touch Discord/ElevenLabs. */
  runAsk: (request: AskJobRequest) => Promise<HumanResponse>;
  /** How long finished jobs stay pollable before GC. Default 1 hour. */
  resultTtlMs?: number;
  /** Injectable clock for expiry/GC tests. */
  now?: () => number;
}

const DEFAULT_RESULT_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory FIFO with a single worker: one conversation at a time, per the design spec.
 * The human is a single-threaded resource; this queue is where that constraint lives.
 */
export class AskQueue {
  private readonly jobs = new Map<string, AskJob>();
  private readonly pendingIds: string[] = [];
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly runAsk: AskQueueOptions['runAsk'];
  private readonly resultTtlMs: number;
  private readonly now: () => number;
  private working = false;
  private stopped = false;

  constructor(opts: AskQueueOptions) {
    this.runAsk = opts.runAsk;
    this.resultTtlMs = opts.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  submit(request: AskJobRequest): { id: string; position: number } {
    this.gc();
    const job: AskJob = {
      id: crypto.randomUUID(),
      state: 'queued',
      request,
      enqueuedAt: this.now(),
    };
    this.jobs.set(job.id, job);
    this.pendingIds.push(job.id);
    const position = this.pendingIds.length + (this.working ? 1 : 0);
    void this.pump();
    return { id: job.id, position };
  }

  get(id: string): AskJob | undefined {
    this.gc();
    return this.jobs.get(id);
  }

  /** 1 = next up or currently in progress. Undefined when the job is not waiting. */
  position(id: string): number | undefined {
    const index = this.pendingIds.indexOf(id);
    if (index === -1) return undefined;
    return index + 1 + (this.working ? 1 : 0);
  }

  /** No new jobs start; an in-flight call is allowed to finish. */
  stop(): void {
    this.stopped = true;
  }

  private hasExpired(job: AskJob): boolean {
    if (job.request.queueTimeoutMs === undefined) return false;
    return this.now() - job.enqueuedAt >= job.request.queueTimeoutMs;
  }

  private finish(job: AskJob, state: JobState): void {
    job.state = state;
    job.finishedAt = this.now();
    this.notify(job.id);
  }

  private notify(id: string): void {
    const list = this.waiters.get(id);
    if (list === undefined) return;
    this.waiters.delete(id);
    for (const wake of list) wake();
  }

  private gc(): void {
    const cutoff = this.now() - this.resultTtlMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && job.finishedAt <= cutoff) this.jobs.delete(id);
    }
  }

  private async pump(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      for (;;) {
        if (this.stopped) break;
        const nextId = this.pendingIds.shift();
        if (nextId === undefined) break;
        const job = this.jobs.get(nextId);
        if (job === undefined || job.state !== 'queued') continue; // cancelled while waiting
        // Spec: expiry is checked when the worker would pick the job up, so an expired job
        // never rings anyone.
        if (this.hasExpired(job)) {
          this.finish(job, 'expired');
          continue;
        }
        job.state = 'calling';
        this.notify(job.id);
        try {
          job.result = await this.runAsk(job.request);
        } catch (error) {
          // askHuman itself never rejects mid-call; this is a config/session-creation error.
          // Surface it in the same shape a call failure would have.
          job.result = {
            answered: false,
            answer: null,
            status: 'error',
            channel: 'unknown',
            durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        this.finish(job, 'done');
      }
    } finally {
      this.working = false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test tests/server/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/queue.ts tests/server/queue.test.ts
git commit -m "feat: AskQueue — serial FIFO worker over an injectable runAsk"
```

---

### Task 4: `AskQueue` — expiry, cancel, GC, long-poll wait

**Files:**
- Modify: `src/server/queue.ts`
- Test: `tests/server/queue.test.ts` (append)

**Interfaces:**
- Produces (added to `AskQueue`; used by Task 5):

```ts
cancel(id: string): 'cancelled' | 'not_found' | JobState; // 'cancelled' on success, else current state
waitForUpdate(id: string, waitMs: number): Promise<AskJob | undefined>;
// resolves early on any state change; resolves with current job at waitMs; undefined = unknown id
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/queue.test.ts` (same imports; `REQ`, `answered`, `deferredRunAsk` are already in the file from Task 3):

```ts
describe('AskQueue expiry, cancel, GC, waitForUpdate', () => {
  test('queued job past its queueTimeoutMs expires at pickup and never runs', async () => {
    let t = 0;
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk, now: () => t });

    queue.submit(REQ); // occupies the worker
    const b = queue.submit({ ...REQ, userId: 'user-2', queueTimeoutMs: 500 });
    await Bun.sleep(0);

    t = 1000; // b is now past its queue timeout
    calls[0]!.resolve(answered('A'));
    await Bun.sleep(0);

    expect(queue.get(b.id)?.state).toBe('expired');
    expect(calls.length).toBe(1); // b never rang anyone
  });

  test('cancel while queued works; cancel while calling is refused', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });

    const a = queue.submit(REQ);
    const b = queue.submit({ ...REQ, userId: 'user-2' });
    await Bun.sleep(0);

    expect(queue.cancel(b.id)).toBe('cancelled');
    expect(queue.get(b.id)?.state).toBe('cancelled');
    expect(queue.cancel(a.id)).toBe('calling'); // in progress: refused
    expect(queue.cancel('00000000-0000-0000-0000-000000000000')).toBe('not_found');

    calls[0]!.resolve(answered('A'));
    await Bun.sleep(0);
    expect(calls.length).toBe(1); // cancelled b never started
    expect(queue.cancel(a.id)).toBe('done'); // terminal: refused, reports state
  });

  test('finished jobs are GCd after resultTtlMs', async () => {
    let t = 0;
    const queue = new AskQueue({
      runAsk: () => Promise.resolve(answered('x')),
      resultTtlMs: 100,
      now: () => t,
    });
    const { id } = queue.submit(REQ);
    await Bun.sleep(0);
    expect(queue.get(id)?.state).toBe('done');

    t = 200;
    expect(queue.get(id)).toBeUndefined();
  });

  test('waitForUpdate resolves early when the job finishes', async () => {
    const { calls, runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });
    const { id } = queue.submit(REQ);
    await Bun.sleep(0);

    const wait = queue.waitForUpdate(id, 60_000);
    calls[0]!.resolve(answered('done!'));
    const job = await wait; // must not take 60s
    expect(job?.state).toBe('done');
  });

  test('waitForUpdate times out returning the current state', async () => {
    const { runAsk } = deferredRunAsk();
    const queue = new AskQueue({ runAsk });
    queue.submit(REQ);
    const b = queue.submit({ ...REQ, userId: 'user-2' });
    await Bun.sleep(0);

    const job = await queue.waitForUpdate(b.id, 20);
    expect(job?.state).toBe('queued');
  });

  test('waitForUpdate on unknown id resolves undefined', async () => {
    const queue = new AskQueue({ runAsk: () => Promise.resolve(answered('x')) });
    expect(await queue.waitForUpdate('00000000-0000-0000-0000-000000000000', 10)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/queue.test.ts`
Expected: FAIL — `cancel` / `waitForUpdate` are not functions.

- [ ] **Step 3: Implement `cancel` and `waitForUpdate`**

Add to `AskQueue` (public methods, after `position`):

```ts
  /** 'cancelled' on success; otherwise the state that blocked it ('not_found' for unknown ids). */
  cancel(id: string): 'cancelled' | 'not_found' | JobState {
    const job = this.jobs.get(id);
    if (job === undefined) return 'not_found';
    if (job.state !== 'queued') return job.state;
    const index = this.pendingIds.indexOf(id);
    if (index !== -1) this.pendingIds.splice(index, 1);
    this.finish(job, 'cancelled');
    return 'cancelled';
  }

  /**
   * Long-poll primitive: resolves as soon as the job's state changes (queued->calling counts),
   * or with the current job once waitMs elapses. Undefined = unknown/GCd id.
   */
  async waitForUpdate(id: string, waitMs: number): Promise<AskJob | undefined> {
    const job = this.jobs.get(id);
    if (job === undefined) return undefined;
    const isTerminal = job.state !== 'queued' && job.state !== 'calling';
    if (isTerminal || waitMs <= 0) return job;

    await new Promise<void>((resolve) => {
      let settled = false;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      const list = this.waiters.get(id) ?? [];
      list.push(wake);
      this.waiters.set(id, list);
    });

    return this.jobs.get(id);
  }
```

Note: `notify` already fires on `finish` and on the `queued -> calling` transition in `pump` (Task 3 code calls `this.notify(job.id)` there), so no other changes are needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test tests/server/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/queue.ts tests/server/queue.test.ts
git commit -m "feat: AskQueue expiry, cancel, result GC, and long-poll waitForUpdate"
```

---

### Task 5: HTTP layer — `startSwitchboard`

**Files:**
- Create: `src/server/run-ask.ts`
- Create: `src/server/http.ts`
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `AskQueue`, `AskJobRequest`, `AskJob` (Tasks 3-4); `buildDefaultDeps` from `src/deps.ts` (Task 2); `askHuman`; `settings.server` (Task 1).
- Produces (used by Tasks 6-7):

```ts
// run-ask.ts
export function makeDefaultRunAsk(settings: Settings): (request: AskJobRequest) => Promise<HumanResponse>;

// http.ts
export interface SwitchboardDeps { runAsk?: (request: AskJobRequest) => Promise<HumanResponse>; }
export interface Switchboard { port: number; queue: AskQueue; stop(): Promise<void>; }
export function startSwitchboard(settings: Settings, deps?: SwitchboardDeps): Switchboard;
// throws at startup when settings.server.host is non-loopback and authToken is ''
```

HTTP contract (spec): `POST /ask` -> 202 `{id, position}`; `GET /ask/:id?waitMs=N` -> 200 `{state, position?, result?}` (waitMs capped at 60000); `DELETE /ask/:id` -> 200 `{state:'cancelled'}` | 409 | 404; 400 invalid body; 401 bad token; 404 unknown route/id. All bodies JSON.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/http.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import type { AskJobRequest } from '../../src/server/queue.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(overrides: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken: '' },
    ...overrides,
  });
}

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

let sb: Switchboard | undefined;
afterEach(async () => {
  await sb?.stop();
  sb = undefined;
});

function base(): string {
  return `http://127.0.0.1:${sb!.port}`;
}

async function postAsk(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base()}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('switchboard HTTP API', () => {
  test('POST /ask -> 202 with id+position; GET returns the verbatim result when done', async () => {
    const seen: AskJobRequest[] = [];
    sb = startSwitchboard(testSettings(), {
      runAsk: async (request) => {
        seen.push(request);
        return answered('four');
      },
    });

    const res = await postAsk({ question: 'What is 2+2?', userId: 'user-1' });
    expect(res.status).toBe(202);
    const { id, position } = (await res.json()) as { id: string; position: number };
    expect(position).toBe(1);

    const poll = await fetch(`${base()}/ask/${id}?waitMs=5000`);
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { state: string; result?: HumanResponse };
    expect(body.state).toBe('done');
    expect(body.result).toEqual(answered('four'));
    expect(seen[0]?.userId).toBe('user-1');
  });

  test('invalid body -> 400 with field errors; unknown route and id -> 404', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('x') });

    const res = await postAsk({ question: '' }); // empty question, missing userId
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('question');
    expect(body.error).toContain('userId');

    expect((await fetch(`${base()}/nope`)).status).toBe(404);
    expect(
      (await fetch(`${base()}/ask/00000000-0000-0000-0000-000000000000`)).status,
    ).toBe(404);
  });

  test('auth: configured token required on every route', async () => {
    sb = startSwitchboard(testSettings({ server: { host: '127.0.0.1', port: 0, authToken: 's3cret' } }), {
      runAsk: async () => answered('x'),
    });

    expect((await postAsk({ question: 'q', userId: 'u' })).status).toBe(401);
    const ok = await postAsk({ question: 'q', userId: 'u' }, { authorization: 'Bearer s3cret' });
    expect(ok.status).toBe(202);
  });

  test('DELETE cancels a queued job; refuses an in-progress one with 409', async () => {
    let release: ((r: HumanResponse) => void) | undefined;
    sb = startSwitchboard(testSettings(), {
      runAsk: () => new Promise<HumanResponse>((resolve) => { release = resolve; }),
    });

    const a = (await (await postAsk({ question: 'a', userId: 'u1' })).json()) as { id: string };
    const b = (await (await postAsk({ question: 'b', userId: 'u2' })).json()) as { id: string };
    await Bun.sleep(0);

    const cancelB = await fetch(`${base()}/ask/${b.id}`, { method: 'DELETE' });
    expect(cancelB.status).toBe(200);
    expect(((await cancelB.json()) as { state: string }).state).toBe('cancelled');

    const cancelA = await fetch(`${base()}/ask/${a.id}`, { method: 'DELETE' });
    expect(cancelA.status).toBe(409);

    release!(answered('a'));
  });

  test('startup is refused on a non-loopback bind without an auth token', () => {
    expect(() =>
      startSwitchboard(testSettings({ server: { host: '0.0.0.0', port: 0, authToken: '' } }), {
        runAsk: async () => answered('x'),
      }),
    ).toThrow(/auth token/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/http.test.ts`
Expected: FAIL — cannot resolve `src/server/http.ts`.

- [ ] **Step 3: Implement `src/server/run-ask.ts`**

```ts
import { askHuman } from '../core/ask-human.ts';
import { buildDefaultDeps } from '../deps.ts';
import type { Settings } from '../settings/schema.ts';
import type { HumanResponse } from '../types/index.ts';
import type { AskJobRequest } from './queue.ts';

/**
 * Production runAsk for the switchboard: merges one job's per-ask routing overrides onto the
 * daemon's settings and places the call with the existing (live-verified) askHuman. The job's
 * `call` overrides travel as AskOptions — field names match by design.
 */
export function makeDefaultRunAsk(settings: Settings): (request: AskJobRequest) => Promise<HumanResponse> {
  return async (request) => {
    const merged: Settings = {
      ...settings,
      discord: {
        ...settings.discord,
        userId: request.userId,
        ...(request.textChannelId !== undefined ? { textChannelId: request.textChannelId } : {}),
        ...(request.voiceChannelId !== undefined ? { voiceChannelId: request.voiceChannelId } : {}),
      },
    };
    const deps = buildDefaultDeps(merged);
    return askHuman(request.question, merged, request.call, deps);
  };
}
```

- [ ] **Step 4: Implement `src/server/http.ts`**

```ts
import { z } from 'zod';
import type { Settings } from '../settings/schema.ts';
import type { HumanResponse } from '../types/index.ts';
import { AskQueue } from './queue.ts';
import type { AskJob, AskJobRequest } from './queue.ts';
import { makeDefaultRunAsk } from './run-ask.ts';

/** Long-poll cap per request (spec): the client simply polls again. */
const MAX_WAIT_MS = 60_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const askBodySchema = z.object({
  question: z.string().min(1),
  userId: z.string().min(1),
  textChannelId: z.string().min(1).optional(),
  voiceChannelId: z.string().min(1).optional(),
  queueTimeoutMs: z.number().int().positive().optional(),
  call: z
    .object({
      joinTimeoutMs: z.number().positive(),
      silenceMs: z.number().positive(),
      maxListenMs: z.number().positive(),
      confirmRounds: z.number().int().positive(),
      affirmativeWords: z.array(z.string().min(1)),
    })
    .partial()
    .optional(),
});

export interface SwitchboardDeps {
  /** Injectable call-placer so tests never touch Discord/ElevenLabs. */
  runAsk?: (request: AskJobRequest) => Promise<HumanResponse>;
}

export interface Switchboard {
  /** The actual bound port (settings.server.port may be 0 in tests). */
  port: number;
  queue: AskQueue;
  stop(): Promise<void>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jobView(job: AskJob, queue: AskQueue): Record<string, unknown> {
  const position = queue.position(job.id);
  return {
    state: job.state,
    ...(job.state === 'queued' && position !== undefined ? { position } : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
  };
}

async function handleAskPost(req: Request, queue: AskQueue): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { error: 'Body must be JSON.' });
  }
  const parsed = askBodySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return json(400, { error: `Invalid ask request: ${details}` });
  }
  const { id, position } = queue.submit(parsed.data);
  return json(202, { id, position });
}

async function handleJobGet(id: string, url: URL, queue: AskQueue): Promise<Response> {
  const waitRaw = url.searchParams.get('waitMs');
  const waitMs = waitRaw === null ? 0 : Math.min(Math.max(Number(waitRaw) || 0, 0), MAX_WAIT_MS);
  const job = await queue.waitForUpdate(id, waitMs);
  if (job === undefined) return json(404, { error: `No such ask: ${id}` });
  return json(200, jobView(job, queue));
}

function handleJobDelete(id: string, queue: AskQueue): Response {
  const outcome = queue.cancel(id);
  if (outcome === 'not_found') return json(404, { error: `No such ask: ${id}` });
  if (outcome !== 'cancelled') {
    return json(409, { error: `Ask is ${outcome}; only queued asks can be cancelled.`, state: outcome });
  }
  return json(200, { state: 'cancelled' });
}

/**
 * Boots the switchboard: validates the bind (non-loopback requires an auth token), builds the
 * queue over the injected or default runAsk, and serves the three-endpoint API.
 */
export function startSwitchboard(settings: Settings, deps: SwitchboardDeps = {}): Switchboard {
  const { host, port, authToken } = settings.server;

  if (!LOOPBACK_HOSTS.has(host) && authToken === '') {
    throw new Error(
      `Refusing to bind the switchboard to non-loopback host ${host} without an auth token; ` +
        'set ETPH_SERVER_AUTH_TOKEN (settings.server.authToken) first.',
    );
  }

  const queue = new AskQueue({ runAsk: deps.runAsk ?? makeDefaultRunAsk(settings) });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (req: Request): Promise<Response> => {
      if (authToken !== '' && req.headers.get('authorization') !== `Bearer ${authToken}`) {
        return json(401, { error: 'Missing or invalid bearer token.' });
      }

      const url = new URL(req.url);

      if (url.pathname === '/ask' && req.method === 'POST') {
        return handleAskPost(req, queue);
      }

      const jobMatch = url.pathname.match(/^\/ask\/([0-9a-fA-F-]{36})$/);
      if (jobMatch !== null) {
        const id = jobMatch[1] as string;
        if (req.method === 'GET') return handleJobGet(id, url, queue);
        if (req.method === 'DELETE') return handleJobDelete(id, queue);
      }

      return json(404, { error: 'Not found.' });
    },
  });

  return {
    port: server.port,
    queue,
    stop: async (): Promise<void> => {
      queue.stop();
      await server.stop(true);
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run typecheck && bun test tests/server/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/run-ask.ts src/server/http.ts tests/server/http.test.ts
git commit -m "feat: switchboard HTTP API (submit/poll/cancel, auth, bind guard)"
```

---

### Task 6: `SwitchboardClient`

**Files:**
- Create: `src/server/client.ts`
- Test: `tests/server/client.test.ts`

**Interfaces:**
- Consumes: the HTTP contract from Task 5; `AskJobRequest['call']` shape.
- Produces (used by Task 7):

```ts
export interface SwitchboardClientOptions {
  baseUrl: string;        // e.g. 'http://127.0.0.1:3117'
  authToken?: string;
  fetchFn?: typeof fetch; // injectable for tests
  pollWaitMs?: number;    // long-poll window per GET; default 30_000
}
export interface RemoteAskOptions {
  userId: string;
  textChannelId?: string;
  voiceChannelId?: string;
  queueTimeoutMs?: number;
  call?: AskJobRequest['call'];
}
export class SwitchboardJobEndedError extends Error { readonly state: 'expired' | 'cancelled'; }
export class SwitchboardClient {
  constructor(opts: SwitchboardClientOptions);
  ask(question: string, opts: RemoteAskOptions): Promise<HumanResponse>;
  // resolves with the verbatim HumanResponse when done;
  // throws SwitchboardJobEndedError on expired/cancelled;
  // throws plain Error on HTTP/network failures (message includes status + body)
}
```

- [ ] **Step 1: Write the failing tests**

Create `tests/server/client.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import { SwitchboardClient, SwitchboardJobEndedError } from '../../src/server/client.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(authToken = ''): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken },
  });
}

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

let sb: Switchboard | undefined;
afterEach(async () => {
  await sb?.stop();
  sb = undefined;
});

describe('SwitchboardClient', () => {
  test('ask round-trips: submit, poll, return the verbatim HumanResponse', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('four') });
    const client = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 100 });

    const result = await client.ask('What is 2+2?', { userId: 'user-1' });
    expect(result).toEqual(answered('four'));
  });

  test('sends the bearer token when configured', async () => {
    sb = startSwitchboard(testSettings('s3cret'), { runAsk: async () => answered('x') });
    const noToken = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 100 });
    await expect(noToken.ask('q', { userId: 'u' })).rejects.toThrow(/401/);

    const withToken = new SwitchboardClient({
      baseUrl: `http://127.0.0.1:${sb.port}`,
      authToken: 's3cret',
      pollWaitMs: 100,
    });
    expect((await withToken.ask('q', { userId: 'u' })).answer).toBe('x');
  });

  test('a cancelled job surfaces as SwitchboardJobEndedError', async () => {
    let release: ((r: HumanResponse) => void) | undefined;
    sb = startSwitchboard(testSettings(), {
      runAsk: () => new Promise<HumanResponse>((resolve) => { release = resolve; }),
    });
    const client = new SwitchboardClient({ baseUrl: `http://127.0.0.1:${sb.port}`, pollWaitMs: 50 });

    // First ask occupies the worker; second sits queued so we can cancel it mid-poll.
    const blocked = client.ask('a', { userId: 'u1' });
    await Bun.sleep(10);
    const pending = client.ask('b', { userId: 'u2' });
    await Bun.sleep(10);

    // The only cancellable job right now is the client's queued second ask ('b') — the first
    // occupies the worker ('calling', not cancellable). Cancel everything cancellable.
    let cancelled = 0;
    for (const [id] of (sb.queue as unknown as { jobs: Map<string, unknown> })['jobs']) {
      if (sb.queue.cancel(id) === 'cancelled') cancelled += 1;
    }
    expect(cancelled).toBe(1);

    await expect(pending).rejects.toBeInstanceOf(SwitchboardJobEndedError);
    release!(answered('a'));
    await blocked;
  });

  test('unreachable server rejects with a plain Error', async () => {
    const client = new SwitchboardClient({ baseUrl: 'http://127.0.0.1:9', pollWaitMs: 50 });
    await expect(client.ask('q', { userId: 'u' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/client.test.ts`
Expected: FAIL — cannot resolve `src/server/client.ts`.

- [ ] **Step 3: Implement `src/server/client.ts`**

```ts
import type { HumanResponse } from '../types/index.ts';
import type { AskJobRequest, JobState } from './queue.ts';

export interface SwitchboardClientOptions {
  baseUrl: string;
  authToken?: string;
  fetchFn?: typeof fetch;
  /** Long-poll window per GET; the server caps at 60s. Default 30s. */
  pollWaitMs?: number;
}

export interface RemoteAskOptions {
  userId: string;
  textChannelId?: string;
  voiceChannelId?: string;
  queueTimeoutMs?: number;
  call?: AskJobRequest['call'];
}

/** The job ended without an answer for queue reasons (never rang, or was cancelled). */
export class SwitchboardJobEndedError extends Error {
  readonly state: 'expired' | 'cancelled';

  constructor(state: 'expired' | 'cancelled') {
    super(`Ask ended without an answer: job ${state}.`);
    this.name = 'SwitchboardJobEndedError';
    this.state = state;
  }
}

interface JobViewBody {
  state: JobState;
  position?: number;
  result?: HumanResponse;
}

/** Submit-then-poll client for the switchboard HTTP API. */
export class SwitchboardClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly pollWaitMs: number;

  constructor(opts: SwitchboardClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollWaitMs = opts.pollWaitMs ?? 30_000;
  }

  async ask(question: string, opts: RemoteAskOptions): Promise<HumanResponse> {
    const submit = await this.request('POST', '/ask', { question, ...opts });
    const { id } = (await submit.json()) as { id: string };

    for (;;) {
      const poll = await this.request('GET', `/ask/${id}?waitMs=${this.pollWaitMs}`);
      const body = (await poll.json()) as JobViewBody;

      if (body.state === 'done') return body.result as HumanResponse;
      if (body.state === 'expired' || body.state === 'cancelled') {
        throw new SwitchboardJobEndedError(body.state);
      }
      // queued / calling: poll again.
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.authToken !== undefined && this.authToken !== ''
          ? { authorization: `Bearer ${this.authToken}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Switchboard request failed with status ${response.status}: ${text}`);
    }
    return response;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test tests/server/`
Expected: PASS. If the cancelled-job test proves flaky from its private-map access, simplify it: submit the second ask directly with `sb.queue.submit(...)`, cancel by the returned id, and drive `SwitchboardClient` polling against that id via `fetch` assertions instead — the client contract under test is only "non-done terminal state throws `SwitchboardJobEndedError`".

- [ ] **Step 5: Commit**

```bash
git add src/server/client.ts tests/server/client.test.ts
git commit -m "feat: SwitchboardClient — submit-then-poll HTTP client"
```

---

### Task 7: CLI — `serve` command and remote `ask`

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/args.test.ts` (append)

**Interfaces:**
- Consumes: `startSwitchboard` (Task 5), `SwitchboardClient` / `SwitchboardJobEndedError` (Task 6).
- Produces: `et-phone-home serve [--config <path>]`; `et-phone-home ask "<q>" --server <url> --user <discordUserId> [--queue-timeout <s>] [--timeout <s>] [--json]`. `ParsedArgs` gains `server?: string`, `user?: string`, `queueTimeoutSeconds?: number`; `CliCommand` gains `'serve'`. Exit codes unchanged: 0 answered, 2 not answered (including expired/cancelled), 1 usage/config/unreachable.

- [ ] **Step 1: Write the failing parser tests**

Append to `tests/cli/args.test.ts` (it already imports `parseArgs`):

```ts
describe('parseArgs — serve and remote ask', () => {
  test('serve command parses with optional --config', () => {
    const parsed = parseArgs(['serve', '--config', 'x.json']);
    expect(parsed.command).toBe('serve');
    expect(parsed.configPath).toBe('x.json');
    expect(parsed.errors).toEqual([]);
  });

  test('ask --server, --user, --queue-timeout parse', () => {
    const parsed = parseArgs(['ask', 'q?', '--server', 'http://h:1', '--user', 'u1', '--queue-timeout', '120']);
    expect(parsed.server).toBe('http://h:1');
    expect(parsed.user).toBe('u1');
    expect(parsed.queueTimeoutSeconds).toBe(120);
    expect(parsed.errors).toEqual([]);
  });

  test('--server without a value is an error', () => {
    expect(parseArgs(['ask', 'q', '--server']).errors).toContain('--server requires a value');
  });

  test('--queue-timeout must be a positive number', () => {
    expect(parseArgs(['ask', 'q', '--queue-timeout', '-2']).errors.length).toBe(1);
  });

  test('--user without --server is an error', () => {
    expect(parseArgs(['ask', 'q', '--user', 'u']).errors).toContain('--user requires --server');
  });

  test('--server with --config is an error (the server has its own settings)', () => {
    expect(parseArgs(['ask', 'q', '--server', 'http://h:1', '--user', 'u', '--config', 'x.json']).errors).toContain(
      '--config cannot be combined with --server',
    );
  });

  test('ask --server without --user is an error', () => {
    expect(parseArgs(['ask', 'q', '--server', 'http://h:1']).errors).toContain('--user is required with --server');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/args.test.ts`
Expected: FAIL — unknown flags produce `Unknown flag: --server` errors instead.

- [ ] **Step 3: Extend the parser**

In `src/cli/index.ts`:

```ts
export type CliCommand = 'ask' | 'help' | 'serve';
```

Add to `ParsedArgs`:

```ts
  server?: string;
  user?: string;
  queueTimeoutSeconds?: number;
```

In `parseArgs`, accept the command (before the `ask` branch):

```ts
  } else if (first === 'serve') {
    command = 'serve';
    rest.shift();
  } else if (first === 'ask') {
```

Declare `let server: string | undefined;`, `let user: string | undefined;`, `let queueTimeoutSeconds: number | undefined;` alongside the existing locals, then add flag handling in the loop (same pattern as `--config`):

```ts
    if (arg === '--server') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--server requires a value');
      } else {
        server = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--user') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--user requires a value');
      } else {
        user = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--queue-timeout') {
      const value = rest[i + 1];
      if (value === undefined) {
        errors.push('--queue-timeout requires a value');
      } else {
        const parsedSeconds = Number(value);
        if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
          errors.push(`--queue-timeout must be a positive number, got: ${value}`);
        } else {
          queueTimeoutSeconds = parsedSeconds;
        }
        i += 1;
      }
      continue;
    }
```

After the loop, add cross-flag validation:

```ts
  if (user !== undefined && server === undefined) errors.push('--user requires --server');
  if (server !== undefined && configPath !== undefined) errors.push('--config cannot be combined with --server');
  if (command === 'ask' && server !== undefined && user === undefined) {
    errors.push('--user is required with --server');
  }
```

and include `server`, `user`, `queueTimeoutSeconds` in the returned object.

- [ ] **Step 4: Run parser tests to verify they pass**

Run: `bun test tests/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the commands**

In `src/cli/index.ts` add imports:

```ts
import { startSwitchboard } from '../server/http.ts';
import { SwitchboardClient, SwitchboardJobEndedError } from '../server/client.ts';
```

Extract the existing result-printing tail of `runAsk` (the `result.error` stderr write, the json/plain stdout write, and `exitCodeFor`) into a helper used by both branches:

```ts
function printResult(result: HumanResponse, parsed: ParsedArgs): 0 | 2 {
  // Diagnostics go to stderr in both modes so stdout stays purely machine-readable.
  if (result.error !== undefined) {
    process.stderr.write(`Call failed: ${result.error}\n`);
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.answered && result.answer !== null) {
    process.stdout.write(`${result.answer}\n`);
  } else {
    process.stderr.write(`Not answered (status: ${result.status}).\n`);
  }

  return exitCodeFor(result);
}
```

Add a remote branch in `runAsk`, right after the empty-question guard:

```ts
  if (parsed.server !== undefined) {
    const client = new SwitchboardClient({
      baseUrl: parsed.server,
      authToken: process.env.ETPH_SERVER_AUTH_TOKEN,
    });

    let result: HumanResponse;
    try {
      result = await client.ask(question, {
        userId: parsed.user as string, // parser guarantees presence with --server
        ...(parsed.queueTimeoutSeconds !== undefined
          ? { queueTimeoutMs: parsed.queueTimeoutSeconds * 1000 }
          : {}),
        ...(parsed.timeoutSeconds !== undefined
          ? { call: { joinTimeoutMs: parsed.timeoutSeconds * 1000 } }
          : {}),
      });
    } catch (error) {
      if (error instanceof SwitchboardJobEndedError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }

    return printResult(result, parsed);
  }
```

Add the serve runner and dispatch it from `main()` (`if (parsed.command === 'serve') return runServe(parsed);` before the ask dispatch):

```ts
async function runServe(parsed: ParsedArgs): Promise<number> {
  let settings: Settings;
  try {
    settings = resolveSettings({ filePath: parsed.configPath });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  let switchboard: ReturnType<typeof startSwitchboard>;
  try {
    switchboard = startSwitchboard(settings);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  process.stderr.write(`switchboard listening on http://${settings.server.host}:${switchboard.port}\n`);
  // Serve until the process is terminated (Ctrl+C / service manager).
  await new Promise<never>(() => {});
  return 0;
}
```

Finally extend `usage()` — add under Usage:

```ts
    '  et-phone-home serve               Run the switchboard daemon (queue + HTTP API)',
```

and under Flags:

```ts
    '  --server <url>        Send the ask to a running switchboard instead of calling directly',
    '  --user <id>           Discord user ID to call (required with --server)',
    '  --queue-timeout <s>   Seconds the ask may wait in the switchboard queue before expiring',
```

- [ ] **Step 6: Write the remote-mode exit-code e2e test**

Create `tests/cli/remote.test.ts` (spec requires CLI exit codes covered in server mode; this runs the real CLI as a subprocess against an in-test switchboard):

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { settingsSchema } from '../../src/settings/schema.ts';
import type { Settings } from '../../src/settings/schema.ts';
import { startSwitchboard } from '../../src/server/http.ts';
import type { Switchboard } from '../../src/server/http.ts';
import type { HumanResponse } from '../../src/types/index.ts';

function testSettings(): Settings {
  return settingsSchema.parse({
    discord: {
      botToken: 'bot-token',
      guildId: 'guild-id',
      textChannelId: 'text-channel-id',
      voiceChannelId: 'voice-channel-id',
      userId: 'default-user',
    },
    elevenlabs: { apiKey: 'api-key', voiceId: 'voice-id' },
    server: { host: '127.0.0.1', port: 0, authToken: '' },
  });
}

function answered(answer: string): HumanResponse {
  return { answered: true, answer, status: 'answered', channel: 'loopback', durationMs: 1 };
}

let sb: Switchboard | undefined;
afterEach(async () => {
  await sb?.stop();
  sb = undefined;
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe('CLI remote mode (subprocess)', () => {
  test('answered remote ask: exit 0, pure JSON on stdout', async () => {
    sb = startSwitchboard(testSettings(), { runAsk: async () => answered('four') });

    const run = await runCli([
      'ask', 'What is 2+2?',
      '--server', `http://127.0.0.1:${sb.port}`,
      '--user', 'user-1',
      '--json',
    ]);

    expect(run.exitCode).toBe(0);
    const body = JSON.parse(run.stdout) as HumanResponse;
    expect(body.answer).toBe('four');
  }, 20_000);

  test('unreachable server: exit 1, diagnostics on stderr, empty stdout', async () => {
    const run = await runCli(['ask', 'q?', '--server', 'http://127.0.0.1:9', '--user', 'u']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr.length).toBeGreaterThan(0);
  }, 20_000);
});
```

Run: `bun test tests/cli/remote.test.ts` — Expected: PASS (subprocess spawns need the wired CLI from Step 5).

- [ ] **Step 7: Full verification**

Run: `bun run typecheck && bun test`
Expected: all pass. Also smoke-check help renders: `bun run src/cli/index.ts help` (exit 0, shows serve + new flags).

- [ ] **Step 8: Commit**

```bash
git add src/cli/index.ts tests/cli/args.test.ts tests/cli/remote.test.ts
git commit -m "feat: CLI serve command and remote ask via --server/--user/--queue-timeout"
```

---

### Task 8: Public exports and documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md` (new "Switchboard" section; follow the file's existing tone/structure)
- Modify: `CLAUDE.md` (architecture + file layout + commands)

**Interfaces:**
- Produces: `startSwitchboard`, `Switchboard`, `SwitchboardDeps`, `AskQueue`, `AskJob`, `AskJobRequest`, `AskQueueOptions`, `JobState`, `SwitchboardClient`, `SwitchboardClientOptions`, `RemoteAskOptions`, `SwitchboardJobEndedError`, `makeDefaultRunAsk` all importable from the package root.

- [ ] **Step 1: Add re-exports to `src/index.ts`**

```ts
export { AskQueue } from './server/queue.ts';
export type { AskJob, AskJobRequest, AskQueueOptions, JobState } from './server/queue.ts';
export { startSwitchboard } from './server/http.ts';
export type { Switchboard, SwitchboardDeps } from './server/http.ts';
export { SwitchboardClient, SwitchboardJobEndedError } from './server/client.ts';
export type { RemoteAskOptions, SwitchboardClientOptions } from './server/client.ts';
export { makeDefaultRunAsk } from './server/run-ask.ts';
```

- [ ] **Step 2: Document**

README.md: add a "Switchboard (concurrent agents)" section covering: why (one bot = one conversation; FIFO queue), `et-phone-home serve`, the three endpoints with one curl example each, `ask --server --user` usage, the auth/bind rule, and the restart-loses-queue caveat. CLAUDE.md: add `src/server/` to File Layout ("switchboard daemon: FIFO queue + HTTP API + client"), a Commands line for `bun run src/cli/index.ts serve`, and note in Key Constraints that job state is a wrapper and `HumanResponse` stays untouched.

- [ ] **Step 3: Full verification**

Run: `bun run typecheck && bun test`
Expected: all pass (all pre-existing tests plus the new server suites; integration still skipped without `ETPH_LIVE_TEST=1`).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md CLAUDE.md
git commit -m "docs: export switchboard API and document serve/remote-ask usage"
```
