import { z } from 'zod';
import type { Settings } from '../settings/schema.ts';
import type { HumanResponse } from '../types/index.ts';
import { AskQueue } from './queue.ts';
import type { AskJob, AskJobRequest } from './queue.ts';
import { makeDefaultRunAsk } from './run-ask.ts';

/** Long-poll cap per request (spec): the client simply polls again. */
const MAX_WAIT_MS = 60_000;

/** Socket idle timeout, in seconds: MAX_WAIT_MS plus headroom so a full-length poll survives. */
const IDLE_TIMEOUT_SECONDS = MAX_WAIT_MS / 1000 + 10;

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
    // Bun.serve idles a connection out after 10 s by default, which would kill every long-poll
    // that actually waits. Give it headroom over MAX_WAIT_MS so the server, not the socket,
    // decides when a poll ends. Bun takes seconds here and caps the value at 255.
    idleTimeout: IDLE_TIMEOUT_SECONDS,
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
    port: server.port as number,
    queue,
    stop: async (): Promise<void> => {
      queue.stop();
      await server.stop(true);
    },
  };
}
