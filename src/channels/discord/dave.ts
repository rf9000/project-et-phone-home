/**
 * DAVE (Discord's end-to-end voice encryption) readiness.
 *
 * Once Discord negotiates DAVE protocol v1 for a channel, every media frame a participant sends
 * must be MLS-encrypted or the other clients discard it. @discordjs/voice reports the connection
 * Ready as soon as the transport handshake finishes — *before* the MLS group has formed — and
 * until `DAVESession.session.ready` flips, `DAVESession.encrypt()` passes opus frames through in
 * plaintext. A clip played in that window goes Playing -> Idle exactly like a good one, the call
 * reports a normal status, and the human hears nothing.
 *
 * These helpers read that state off a live connection so speak() can wait for it. They take a
 * structural view of the connection rather than @discordjs/voice types so they stay unit-testable.
 */

/** How often the readiness poll re-reads the connection state. */
export const E2EE_POLL_INTERVAL_MS = 50;

/** Minimal structural view of the @discordjs/voice DAVE session wrapper. */
export interface DaveSessionLike {
  /** 0 means the channel is not end-to-end encrypted; frames use transport encryption only. */
  readonly protocolVersion: number;
  /** The native MLS session; undefined until the wrapper has created one. */
  readonly session?: { readonly ready: boolean } | undefined;
}

/** Minimal structural view of a VoiceConnection's state, down to the DAVE session. */
export interface VoiceConnectionLike {
  readonly state: {
    readonly status: string;
    readonly networking?:
      | {
          readonly state: {
            readonly code: number;
            readonly dave?: DaveSessionLike | undefined;
          };
        }
      | undefined;
  };
}

/** A snapshot of the connection's E2EE state, shaped for logging and diagnosis. */
export interface E2eeState {
  /** Voice connection status ('ready', 'destroyed', ...). */
  connection: string;
  /** Negotiated DAVE protocol version; 0 when the channel has no E2EE; -1 when no DAVE session exists. */
  protocolVersion: number;
  /** Whether the MLS session can encrypt right now. Always true when protocolVersion is 0. */
  sessionReady: boolean;
}

/** Reads the current E2EE state without touching anything. */
export function describeE2ee(connection: VoiceConnectionLike): E2eeState {
  const dave = connection.state.networking?.state.dave;

  if (dave === undefined) {
    return { connection: connection.state.status, protocolVersion: -1, sessionReady: true };
  }

  return {
    connection: connection.state.status,
    protocolVersion: dave.protocolVersion,
    sessionReady: dave.protocolVersion === 0 || dave.session?.ready === true,
  };
}

/**
 * True when frames sent right now would be decodable by the other participants: either the
 * channel has no E2EE (protocol 0, or DAVE disabled/unavailable) or the MLS session is ready.
 */
export function isE2eeReady(connection: VoiceConnectionLike): boolean {
  return describeE2ee(connection).sessionReady;
}

/**
 * Resolves true as soon as isE2eeReady() holds, false once timeoutMs elapses first. Polls rather
 * than subscribing because @discordjs/voice exposes no readiness event — the MLS state lives on
 * a native object that the wrapper only consults at encrypt time. A destroyed connection resolves
 * false immediately; there is nothing left to wait for.
 */
export function waitForE2eeReady(connection: VoiceConnectionLike, timeoutMs: number): Promise<boolean> {
  if (isE2eeReady(connection)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const poll = setInterval(() => {
      if (isE2eeReady(connection)) {
        clearInterval(poll);
        resolve(true);
        return;
      }

      if (connection.state.status === 'destroyed' || Date.now() >= deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, E2EE_POLL_INTERVAL_MS);
  });
}

/**
 * The stderr warning for a call that had to speak before E2EE was ready. The call goes on — the
 * frames still reach Discord and a v0 downgrade may make them audible — but a silent call needs
 * this line in the log or it is indistinguishable from a working one.
 */
export function e2eeNotReadyMessage(state: E2eeState, waitedMs: number): string {
  return (
    `[voice] DAVE end-to-end encryption did not become ready within ${waitedMs} ms ` +
    `(protocol v${state.protocolVersion}, connection ${state.connection}); speaking anyway. ` +
    'The human will most likely hear silence. Run `bun run scripts/playback-trace.ts` to see where the MLS handshake stops.'
  );
}
