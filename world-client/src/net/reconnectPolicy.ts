/**
 * Pure, dependency-free reconnect policy for useWorldRoom.ts's Colyseus connection: how long to
 * wait before the Nth retry (computeReconnectDelayMs) and whether a disconnect should trigger a
 * retry at all (shouldReconnect). Kept free of React/Colyseus imports on purpose -- this project
 * can't mount React or open a real socket in its headless test setup (see every other file in
 * src/scene/__tests__/), so this is the one place the actual retry MATH and the
 * intentional-vs-unexpected DECISION are pinned down and verified by a real test, rather than
 * living inline in the hook where only a human reading the code (or a live demo going wrong)
 * would ever exercise them.
 */

export type DisconnectReason = 'intentional' | 'unexpected'

export interface ReconnectPolicyConfig {
  /** Delay before the first retry, in ms. */
  baseDelayMs: number
  /** Hard ceiling on the delay, however many attempts have piled up. */
  maxDelayMs: number
  /** +/- fraction of the (pre-jitter) delay that jitter can move it, e.g. 0.3 = +/-30%. */
  jitterRatio: number
}

/**
 * Kiosk hardware (see KioskMode.ts and the virtual-world-guide-fleet section of the repo's
 * CLAUDE.md) is meant to run unattended for HOURS, and the world-server can go down for
 * anywhere from a sub-second wifi blip to a multi-second container restart
 * (agent_service/deploy/redeploy.sh). Numbers, and why:
 *  - baseDelayMs 500: the first retry is fast enough that a sub-second network hiccup resolves
 *    before a human watching the screen would even register the freeze.
 *  - doubling each attempt, capped at maxDelayMs 15_000 (15s): by attempt 5 the delay has
 *    already hit the cap (0.5+1+2+4+8s elapsed), so a slow redeploy or a multi-minute outage
 *    doesn't make the gap between retries climb into minutes -- it settles into a steady ~15s
 *    poll and keeps knocking.
 *  - jitterRatio 0.3: if the world-server restarts, EVERY kiosk screen in the venue drops its
 *    connection in the same instant and would otherwise retry in perfect lockstep -- a
 *    synchronized reconnect storm hitting the server the moment it comes back up. +/-30% jitter
 *    spreads that out.
 * There is deliberately NO attempt cap here -- computeReconnectDelayMs never refuses to produce
 * a delay, and useWorldRoom.ts never stops calling it. Retries continue forever at the 15s
 * ceiling; giving up permanently after one attempt is the exact bug this file exists to fix.
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicyConfig = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterRatio: 0.3,
}

/**
 * Number of consecutive failed (re)connect attempts after which the UI status should escalate
 * from 'reconnecting' (still well within the range a quick blip resolves in) to 'failed' (this
 * has been down long enough that a human glancing at the big screen should notice and act). At
 * DEFAULT_RECONNECT_POLICY's numbers, attempt 5 fires at t ~= 0.5+1+2+4+8 = 15.5s of elapsed
 * downtime -- long enough that anything shorter reads as a normal blip, short enough that a real
 * outage shows 'failed' well within the first 20 seconds. Retries keep going past this
 * threshold -- crossing it changes the status shown, not whether useWorldRoom.ts keeps trying
 * (see DEFAULT_RECONNECT_POLICY's doc comment).
 */
export const FAILED_STATUS_ATTEMPT_THRESHOLD = 5

/**
 * Exponential backoff with a cap and jitter. `attempt` is 1-based (the first retry after a drop
 * is attempt 1). `randomFn` defaults to Math.random but is injectable so tests can assert the
 * exact jitter bound deterministically instead of just "ran N times and stayed in range"
 * (see reconnectPolicy.test.ts).
 */
export function computeReconnectDelayMs(
  attempt: number,
  config: ReconnectPolicyConfig = DEFAULT_RECONNECT_POLICY,
  randomFn: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const exponential = config.baseDelayMs * 2 ** (safeAttempt - 1)
  const capped = Math.min(exponential, config.maxDelayMs)
  // Full jitter within +/- jitterRatio of the (post-cap) delay -- e.g. jitterRatio 0.3 at
  // capped=1000 draws uniformly from [700, 1300]. randomFn() is documented (Math.random) to
  // return a value in [0, 1); (2*r - 1) maps that to [-1, 1).
  const jitterSpan = capped * config.jitterRatio
  const jitter = (randomFn() * 2 - 1) * jitterSpan
  return Math.max(0, Math.round(capped + jitter))
}

/**
 * Whether losing the room connection should trigger a reconnect attempt. This is THE
 * correctness trap useWorldRoom.ts's reconnect logic exists to get right: a deliberate
 * teardown -- React effect cleanup on unmount, or anything else that calls room.leave() itself
 * -- must NOT reconnect, or the hook leaks a fresh WebSocket connection (and a fresh room on the
 * server) on every unmount. Only an unexpected drop (server restart, network blip, the server
 * closing the room out from under the client) should retry.
 */
export function shouldReconnect(reason: DisconnectReason): boolean {
  return reason === 'unexpected'
}

/**
 * Maps a 1-based, still-in-progress reconnect attempt count to the status the UI should show.
 * See FAILED_STATUS_ATTEMPT_THRESHOLD's doc comment for the exact number and why.
 */
export function statusForAttempt(attempt: number): 'reconnecting' | 'failed' {
  return attempt >= FAILED_STATUS_ATTEMPT_THRESHOLD ? 'failed' : 'reconnecting'
}
