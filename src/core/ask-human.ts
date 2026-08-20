import type { Settings } from '../settings/schema.ts';
import type {
  AskStatus,
  CommunicationChannel,
  HumanResponse,
  SpeechToText,
  TextToSpeech,
} from '../types/index.ts';

export interface AskDeps {
  channel: CommunicationChannel;
  tts: TextToSpeech;
  stt: SpeechToText;
}

export interface AskOptions {
  joinTimeoutMs?: number;
  silenceMs?: number;
  maxListenMs?: number;
  confirmRounds?: number;
  affirmativeWords?: string[];
}

/** Escapes regex metacharacters so a word can be safely embedded in a \b...\b pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flattens an error and its `cause` chain into one line. Every layer here wraps the one below it
 * with `{ cause }` (voice connect wraps entersState, the HTTP helper wraps fetch), so the topmost
 * message alone routinely says "request failed" while the cause says *why*. Depth is capped and
 * visited errors tracked so a self-referential cause cannot loop.
 */
function describeError(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && parts.length < maxDepth && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      parts.push(current.message === '' ? current.name : `${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }

    parts.push(typeof current === 'string' ? current : JSON.stringify(current) ?? String(current));
    break;
  }

  return parts.length === 0 ? 'Unknown error' : parts.join(' <- caused by: ');
}

/** Case-insensitive, word-boundary match against any of the affirmative words (e.g. 'yesterday' must NOT match 'yes'). */
function isAffirmative(reply: string, affirmativeWords: string[]): boolean {
  if (reply.trim() === '') return false;
  return affirmativeWords.some((word) => {
    const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    return pattern.test(reply);
  });
}

/**
 * Channel-agnostic call flow: createSession, ring, wait for pickup, speak the question,
 * listen for an answer, then run a confirm loop until the human affirms the transcript or
 * rounds run out. ring() notifies the human a question is waiting (e.g. Discord text
 * mention) and must happen before waitForHuman, or real calls will always time out.
 * Pure function: deps are required (no default wiring yet). Always resolves — never rejects —
 * except for configuration errors thrown before a session exists.
 */
export async function askHuman(
  question: string,
  settings: Settings,
  opts: AskOptions | undefined,
  deps: AskDeps,
): Promise<HumanResponse> {
  const joinTimeoutMs = opts?.joinTimeoutMs ?? settings.call.joinTimeoutMs;
  const silenceMs = opts?.silenceMs ?? settings.call.silenceMs;
  const maxListenMs = opts?.maxListenMs ?? settings.call.maxListenMs;
  const confirmRounds = opts?.confirmRounds ?? settings.call.confirmRounds;
  const affirmativeWords = opts?.affirmativeWords ?? settings.call.affirmativeWords;

  const { channel, tts, stt } = deps;
  const start = Date.now();

  // Configuration/session-creation errors happen before a session exists; let them propagate.
  const session = await channel.createSession({ question });

  let status: AskStatus;
  let answer: string | null = null;
  let failure: string | undefined;

  try {
    await session.ring();
    const pickedUp = await session.waitForHuman(joinTimeoutMs);

    if (!pickedUp) {
      status = 'no_pickup';
    } else {
      await session.speak(await tts.synthesize(question));
      const initialAudio = await session.listen({ silenceMs, maxMs: maxListenMs });

      if (initialAudio === null) {
        status = 'no_speech';
      } else {
        let transcript = (await stt.transcribe(initialAudio)).trim();
        let confirmedAnswer: string | null = null;

        for (let round = 0; round < confirmRounds; round++) {
          if (transcript === '') {
            // Empty/whitespace transcript: treat like a failed confirmation (consumes a round).
            await session.speak(await tts.synthesize('Okay, please repeat your answer.'));
            const repeatAudio = await session.listen({ silenceMs, maxMs: maxListenMs });
            transcript = repeatAudio === null ? '' : (await stt.transcribe(repeatAudio)).trim();
            continue;
          }

          const confirmPrompt = `I heard: "${transcript}" — is that correct? Please answer yes or no.`;
          await session.speak(await tts.synthesize(confirmPrompt));
          const confirmAudio = await session.listen({ silenceMs, maxMs: maxListenMs });

          if (confirmAudio === null) {
            // Silence during confirm: consume the round, re-confirm the same transcript.
            continue;
          }

          const confirmReply = (await stt.transcribe(confirmAudio)).trim();

          if (isAffirmative(confirmReply, affirmativeWords)) {
            confirmedAnswer = transcript;
            break;
          }

          // Negative/other reply: ask for a fresh answer, which the next round will confirm.
          await session.speak(await tts.synthesize('Okay, please repeat your answer.'));
          const repeatAudio = await session.listen({ silenceMs, maxMs: maxListenMs });
          transcript = repeatAudio === null ? '' : (await stt.transcribe(repeatAudio)).trim();
        }

        if (confirmedAnswer !== null) {
          status = 'answered';
          answer = confirmedAnswer;
        } else {
          status = 'not_confirmed';
        }
      }
    }
  } catch (error) {
    status = 'error';
    answer = null;
    // Without this the caller gets a bare 'error' status with nothing to act on.
    failure = describeError(error);
  } finally {
    await session.hangUp();
  }

  return {
    answered: status === 'answered',
    answer,
    status,
    channel: channel.name,
    durationMs: Date.now() - start,
    ...(failure === undefined ? {} : { error: failure }),
  };
}
