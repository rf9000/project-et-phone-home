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
