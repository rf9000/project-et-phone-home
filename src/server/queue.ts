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
