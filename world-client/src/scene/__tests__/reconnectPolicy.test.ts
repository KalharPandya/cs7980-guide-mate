/**
 * Unit tests for net/reconnectPolicy.ts -- the pure retry-math and intentional-vs-unexpected
 * decision that useWorldRoom.ts's reconnect logic is built on. Extracted specifically because
 * useWorldRoom.ts itself can't be exercised headlessly here (no React mount, no real
 * WebSocket/Colyseus server) -- see every other file in this directory for the same convention.
 * Plain node:assert script, run with tsx -- matches world/'s test convention.
 *
 * Run with: npx tsx src/scene/__tests__/reconnectPolicy.test.ts
 */
import assert from 'node:assert/strict'

import {
  computeReconnectDelayMs,
  shouldReconnect,
  statusForAttempt,
  DEFAULT_RECONNECT_POLICY,
  FAILED_STATUS_ATTEMPT_THRESHOLD,
} from '../../net/reconnectPolicy'

// --- computeReconnectDelayMs: backoff grows ------------------------------------------------

function testDelayGrowsExponentiallyBeforeTheCap(): void {
  // Jitter disabled (randomFn returns 0.5, the exact midpoint, so (2*0.5 - 1) = 0 jitter) so the
  // raw exponential curve can be pinned down exactly.
  const noJitter = () => 0.5
  const d1 = computeReconnectDelayMs(1, DEFAULT_RECONNECT_POLICY, noJitter)
  const d2 = computeReconnectDelayMs(2, DEFAULT_RECONNECT_POLICY, noJitter)
  const d3 = computeReconnectDelayMs(3, DEFAULT_RECONNECT_POLICY, noJitter)
  const d4 = computeReconnectDelayMs(4, DEFAULT_RECONNECT_POLICY, noJitter)
  assert.equal(d1, 500, 'attempt 1 should be baseDelayMs (500ms)')
  assert.equal(d2, 1000, 'attempt 2 should double to 1000ms')
  assert.equal(d3, 2000, 'attempt 3 should double again to 2000ms')
  assert.equal(d4, 4000, 'attempt 4 should double again to 4000ms')
  assert.ok(d2 > d1 && d3 > d2 && d4 > d3, 'each successive attempt must produce a strictly larger delay before the cap')
  console.log('PASS: computeReconnectDelayMs grows exponentially (500 -> 1000 -> 2000 -> 4000ms) before the cap')
}

// --- computeReconnectDelayMs: respects the cap ---------------------------------------------

function testDelayRespectsTheCapForLargeAttempts(): void {
  const noJitter = () => 0.5
  // 500 * 2^(attempt-1) first exceeds maxDelayMs (15000) at attempt=6 (500*2^5=16000); attempt=5
  // (8000ms) is still below the cap, so the cap-respecting sweep starts at 6.
  for (const attempt of [6, 10, 50, 1000]) {
    const delay = computeReconnectDelayMs(attempt, DEFAULT_RECONNECT_POLICY, noJitter)
    assert.equal(
      delay,
      DEFAULT_RECONNECT_POLICY.maxDelayMs,
      `attempt ${attempt} should be clamped to maxDelayMs (${DEFAULT_RECONNECT_POLICY.maxDelayMs}ms), got ${delay}`,
    )
  }
  console.log('PASS: computeReconnectDelayMs clamps to maxDelayMs for large attempt counts, including attempt=1000 (never grows unbounded)')
}

// --- computeReconnectDelayMs: jitter stays in range -----------------------------------------

function testJitterStaysWithinTheConfiguredRatio(): void {
  const config = DEFAULT_RECONNECT_POLICY
  // Sweep the full [0, 1) domain randomFn can return (inclusive of the two extremes and the
  // midpoint) rather than relying on Math.random, so the bound is checked deterministically.
  const randomSamples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999]
  for (const attempt of [1, 2, 3, 5, 10]) {
    const capped = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs)
    const jitterSpan = capped * config.jitterRatio
    const lowerBound = Math.max(0, capped - jitterSpan)
    const upperBound = capped + jitterSpan
    for (const r of randomSamples) {
      const delay = computeReconnectDelayMs(attempt, config, () => r)
      assert.ok(
        delay >= lowerBound - 1 && delay <= upperBound + 1, // +/-1 for Math.round
        `attempt ${attempt}, randomFn=${r}: delay ${delay} should be within [${lowerBound}, ${upperBound}] (capped=${capped}, jitterRatio=${config.jitterRatio})`,
      )
    }
  }
  console.log('PASS: computeReconnectDelayMs jitter always stays within +/- jitterRatio of the capped delay, across the full randomFn domain')
}

function testDelayNeverNegative(): void {
  // randomFn=0 is the minimum jitter draw (full negative jitter): (2*0 - 1) = -1, so delay =
  // capped - jitterSpan. With jitterRatio 0.3 that's never negative for these numbers, but this
  // pins the floor down explicitly rather than assuming it.
  const delay = computeReconnectDelayMs(1, DEFAULT_RECONNECT_POLICY, () => 0)
  assert.ok(delay >= 0, `delay must never be negative, got ${delay}`)
  console.log('PASS: computeReconnectDelayMs never returns a negative delay even at the minimum jitter draw')
}

function testAttemptIsTreatedAsAtLeastOne(): void {
  const noJitter = () => 0.5
  const zero = computeReconnectDelayMs(0, DEFAULT_RECONNECT_POLICY, noJitter)
  const negative = computeReconnectDelayMs(-5, DEFAULT_RECONNECT_POLICY, noJitter)
  const one = computeReconnectDelayMs(1, DEFAULT_RECONNECT_POLICY, noJitter)
  assert.equal(zero, one, 'attempt 0 should behave the same as attempt 1 (clamped, not treated as "before the first attempt")')
  assert.equal(negative, one, 'a negative attempt should also clamp to attempt 1, not throw or go negative')
  console.log('PASS: computeReconnectDelayMs clamps attempt <= 0 to behave like attempt 1')
}

// --- shouldReconnect: the intentional-vs-unexpected correctness trap -----------------------

function testIntentionalTeardownNeverReconnects(): void {
  assert.equal(
    shouldReconnect('intentional'),
    false,
    'an intentional teardown (effect cleanup / unmount / our own leave() call) must NEVER trigger a reconnect -- doing so leaks a connection on every unmount',
  )
  console.log('PASS: shouldReconnect(\'intentional\') is false -- unmount/deliberate leave never reconnects')
}

function testUnexpectedDropAlwaysReconnects(): void {
  assert.equal(
    shouldReconnect('unexpected'),
    true,
    'an unexpected drop (server restart, network blip, server-initiated close) must always trigger a reconnect attempt',
  )
  console.log('PASS: shouldReconnect(\'unexpected\') is true -- a real drop always reconnects')
}

// --- statusForAttempt -----------------------------------------------------------------------

function testStatusEscalatesToFailedAtTheThreshold(): void {
  assert.equal(statusForAttempt(1), 'reconnecting')
  assert.equal(statusForAttempt(FAILED_STATUS_ATTEMPT_THRESHOLD - 1), 'reconnecting')
  assert.equal(statusForAttempt(FAILED_STATUS_ATTEMPT_THRESHOLD), 'failed')
  assert.equal(statusForAttempt(FAILED_STATUS_ATTEMPT_THRESHOLD + 10), 'failed')
  console.log('PASS: statusForAttempt stays \'reconnecting\' below FAILED_STATUS_ATTEMPT_THRESHOLD and escalates to \'failed\' at and beyond it')
}

function main(): void {
  testDelayGrowsExponentiallyBeforeTheCap()
  testDelayRespectsTheCapForLargeAttempts()
  testJitterStaysWithinTheConfiguredRatio()
  testDelayNeverNegative()
  testAttemptIsTreatedAsAtLeastOne()
  testIntentionalTeardownNeverReconnects()
  testUnexpectedDropAlwaysReconnects()
  testStatusEscalatesToFailedAtTheThreshold()
  console.log('ALL PASS: reconnectPolicy.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
