/**
 * Display names for the floating agent name tags (see AgentLabels.tsx), kept as PURE string
 * functions on a plain id so they can be proven offline, exactly like roomLabelLayout.ts holds
 * the placement rule the tags reuse.
 *
 * ## Why a derivation at all, instead of a server field
 *
 * There is no human-readable name anywhere in the synced state to show. `AgentSnapshot`
 * (net/useWorldRoom.ts) carries only what world/src/rooms/schema/WorldState.ts's `Agent` syncs:
 * id, kind, x, z, heading, state, route. The ids the world-server actually mints are machine
 * ids, verified against the server rather than guessed:
 *
 *   - robots come from the virtual fleet as `virtual/1` ... `virtual/50`
 *     (world/src/iot/messages.ts and the wire-conformance fixture both pin that shape),
 *   - simulated visitors come from the slot pool as `sim-visitor-0`, `sim-visitor-1`, ...
 *     (world/src/rooms/simulatedVisitorSpawner.ts's SIM_VISITOR_ID_PREFIX),
 *   - a visitor created by an agent command carries whatever `visitor_id` the caller sent,
 *     which is an arbitrary opaque string.
 *
 * Adding a name field would mean changing the world-server, which this change deliberately does
 * not do. So the name is DERIVED from the id here, on the client, as presentation.
 *
 * ## The two rules
 *
 * Robots keep their real identity, because a robot's number is meaningful to an operator
 * ("which unit is escorting?"): `virtual/5` reads as "Robot 5". The number is taken as the
 * TRAILING digits of the id, not by matching the literal `virtual/` prefix, so an id from any
 * other fleet naming scheme still works (`turtlebot468` reads as "Robot 468"). That generality
 * is the point: nothing here may be pinned to one vendor's id format.
 *
 * Visitors get a human first name, because a person's tag saying `sim-visitor-3` communicates
 * nothing a viewer of a lobby kiosk cares about, and showing a raw opaque id is worse than
 * showing no tag. The name is picked from a fixed list by an index derived FROM THE ID, so it
 * is deterministic: the same visitor is the same person on every frame, after a reconnect, and
 * on every machine rendering the same world. It must never be `Math.random()` at spawn, which
 * would rename people mid-walk on any component remount.
 *
 * The index prefers the id's trailing number when there is one, so the slot-pooled
 * `sim-visitor-0..N` visitors map onto the first N names one-to-one and cannot collide while
 * the concurrent count stays under VISITOR_NAMES.length. Ids without a trailing number fall
 * back to a hash, which can collide, and that is accepted: two people briefly sharing a first
 * name is a real-world occurrence and reads as such, whereas a mangled hash string does not.
 */

/**
 * The name pool. Short, so the tag pill stays narrow enough not to hog screen space above a
 * moving person (the tags are culled on collision, so a wide pill costs its neighbours their
 * tags), and deliberately varied, since this stands in for the public walking through a
 * university building.
 */
export const VISITOR_NAMES: readonly string[] = [
  'Ava',
  'Ben',
  'Chloe',
  'Diego',
  'Elena',
  'Farid',
  'Grace',
  'Hana',
  'Ivan',
  'Julia',
  'Kai',
  'Lena',
  'Mateo',
  'Nina',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Umar',
  'Vera',
  'Wes',
  'Yuki',
]

/** Prefix for a robot's tag. Also what makes a robot tag readable as a robot in plain text, on
 * top of the colour difference AgentLabels.tsx applies. */
export const ROBOT_NAME_PREFIX = 'Robot '

/**
 * The id's trailing run of digits as a number, or null when it does not end in digits.
 *
 * Trailing rather than "the first number found" so `virtual/1` and `sim-visitor-1` both yield 1
 * while an id that happens to contain a number earlier (`floor14-guide-3`) still resolves by
 * its own suffix. Bounded by Number.MAX_SAFE_INTEGER in practice; a pathologically long digit
 * run parses to Infinity, which is handled by the callers below (both guard with
 * Number.isSafeInteger before using it as an index).
 */
export function trailingNumber(id: string): number | null {
  const match = /(\d+)$/.exec(id)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

/**
 * FNV-1a over the id, as an unsigned 32-bit number. Used only to pick a name for an id that has
 * no trailing number. Chosen because it is a handful of ops, has no dependencies, and is
 * DETERMINISTIC across machines and runs, which is the whole requirement here (this is not a
 * security or collision-resistance use). Math.imul keeps the multiply in 32-bit integer space
 * rather than drifting through float53.
 */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * The name shown on `id`'s tag. Total: every string maps to something readable, including the
 * empty string, so a malformed id can never render an empty pill.
 *
 * `kind` is compared against 'robot' rather than 'visitor' because the server's `Agent.kind` is
 * a plain string and visitors are the default population of this world; anything that is not
 * explicitly a robot is treated as a person, which fails toward a friendly name rather than
 * toward a machine id leaking onto the screen.
 */
export function displayNameForAgent(id: string, kind: string): string {
  if (kind === 'robot') {
    const number = trailingNumber(id)
    if (number !== null) return `${ROBOT_NAME_PREFIX}${number}`
    // No trailing number: fall back to the id's last path segment so a fleet id like
    // `virtual/spare` still reads as "Robot spare" instead of repeating the whole topic path.
    const segment = id.split('/').pop() ?? ''
    return segment ? `${ROBOT_NAME_PREFIX}${segment}` : ROBOT_NAME_PREFIX.trim()
  }

  const index = trailingNumber(id) ?? stableHash(id)
  return VISITOR_NAMES[index % VISITOR_NAMES.length]
}
