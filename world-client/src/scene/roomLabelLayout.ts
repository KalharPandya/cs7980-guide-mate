/**
 * Screen-space label placement for RoomLabels.tsx, kept as PURE functions on plain numbers.
 *
 * Why this is a separate module and not inline in the component: the placement rule ("which of
 * 18 room labels are allowed to draw this tick") is the only part of the label work that can be
 * wrong in an interesting way, and it is the only part that does not need a renderer. This
 * environment cannot composite a WebGL frame reliably (see floorGeometry.test.ts's note on the
 * risk register's #1 documented limitation), so the collision/priority rule is proven by feeding
 * known screen rectangles to selectVisibleLabels() and asserting exactly which keys survive. The
 * component keeps only the parts that genuinely need three.js: projecting a world point to CSS
 * pixels, measuring a DOM node, and writing a style.
 *
 * The model is deliberately the simplest one that reads cleanly, NOT a general label-layout
 * engine (no leader lines, no candidate-position search, no simulated annealing):
 *
 *   1. Every label is an axis-aligned rectangle centred on its room's projected anchor, at a
 *      CONSTANT CSS pixel size (RoomLabels.tsx drops drei's `distanceFactor`, so a label never
 *      scales with camera distance and its rectangle is the same every tick).
 *   2. Labels are considered in a FIXED priority order, not in draw order and not in
 *      camera-dependent order. Camera-dependent priority is what makes naive label culling
 *      flicker: two labels that trade places as the camera drifts would swap which one is
 *      hidden every few frames. With a fixed order the loser of a given pair is ALWAYS the same
 *      label, so the only thing that changes as the camera moves is whether the pair overlaps at
 *      all, which changes once and stays changed.
 *   3. First-fit greedy: walk the priority order, draw a label if its rectangle clears every
 *      already-placed rectangle by LABEL_GAP_PX, otherwise drop it for this tick.
 *
 * Dropping rather than nudging is a deliberate call. A nudged label on a floor plan can drift
 * over a NEIGHBOURING room and read as that room's name, which is worse than the label simply
 * not being there: an absent label is unambiguous, a misplaced one is wrong. Zooming in makes
 * the anchors spread apart and the dropped labels come back on their own, which is how map
 * annotation is expected to behave.
 *
 * Cost: O(n^2) over 18 rooms is at most 153 rectangle comparisons, each a handful of float ops.
 * RoomLabels.tsx runs this ~10 times a second, so the whole layout budget is well under the cost
 * of a single agent's per-frame matrix update.
 */

/**
 * Clear space required between two drawn labels, in CSS pixels. Zero would let two labels sit
 * pixel-adjacent, which reads as one smeared block; a few pixels of guaranteed gutter is what
 * makes two nearby labels read as two labels.
 */
export const LABEL_GAP_PX = 6

/**
 * Fallback metrics used only for the very first layout tick, before the labels' DOM nodes have
 * been laid out and can report a real offsetWidth/offsetHeight. RoomLabels.tsx caches the real
 * measurement as soon as it is non-zero, so these numbers only decide one frame's worth of
 * placement. They are deliberately a touch WIDE (a 12px system sans-serif averages nearer 6.0px
 * per character for mixed-case text): over-estimating hides a borderline label for one tick,
 * under-estimating lets two labels visibly collide for one tick, and the second is the failure
 * this whole module exists to prevent.
 */
export const ESTIMATED_CHAR_WIDTH_PX = 6.6
/** Horizontal padding + border of the label pill, in CSS pixels. See ESTIMATED_CHAR_WIDTH_PX. */
export const ESTIMATED_LABEL_PADDING_X_PX = 16
/** Full pill height (text line + vertical padding + border), in CSS pixels. */
export const ESTIMATED_LABEL_HEIGHT_PX = 21

/** First-tick width guess for a label showing `text`. See ESTIMATED_CHAR_WIDTH_PX. */
export function estimateLabelWidthPx(text: string): number {
  return Math.ceil(text.length * ESTIMATED_CHAR_WIDTH_PX + ESTIMATED_LABEL_PADDING_X_PX)
}

/**
 * One label's bid to be drawn this tick, already projected to CSS pixels by the caller.
 *
 * `centerX`/`centerY` are canvas-relative CSS pixels with the origin at the top-left, matching
 * exactly what drei's Html positions its wrapper at (see drei's defaultCalculatePosition:
 * `ndc.x * w/2 + w/2`, `-(ndc.y * h/2) + h/2`). RoomLabels.tsx reproduces that formula rather
 * than reading it back off the DOM so the layout decision and the thing drawn cannot disagree.
 */
export interface LabelCandidate {
  /** Stable identity, used for output and to break priority ties deterministically. */
  key: string
  /** Lower wins. Must not depend on the camera. See the module comment, point 2. */
  priority: number
  centerX: number
  centerY: number
  width: number
  height: number
  /**
   * False when the caller already knows this label must not draw for a NON-geometric reason:
   * the anchor is behind the camera, or drei's `occlude` raycast found a wall in front of it.
   *
   * Such a label is skipped entirely rather than placed-then-hidden, which matters: a label
   * hidden behind a wall must NOT reserve screen space, or it would suppress a visible
   * lower-priority neighbour and leave a hole in the map with nothing drawn in it.
   */
  eligible: boolean
}

export interface Viewport {
  width: number
  height: number
}

/**
 * True when two label rectangles are closer than `gap` on both axes, i.e. drawing both would
 * leave less than `gap` of clear space between them. Separating-axis test on centre distance,
 * which is the cheapest correct form for axis-aligned boxes.
 */
export function labelsCollide(
  a: Pick<LabelCandidate, 'centerX' | 'centerY' | 'width' | 'height'>,
  b: Pick<LabelCandidate, 'centerX' | 'centerY' | 'width' | 'height'>,
  gap: number = LABEL_GAP_PX,
): boolean {
  const overlapsX = Math.abs(a.centerX - b.centerX) < (a.width + b.width) / 2 + gap
  const overlapsY = Math.abs(a.centerY - b.centerY) < (a.height + b.height) / 2 + gap
  return overlapsX && overlapsY
}

/**
 * True when a rectangle is entirely outside the canvas. Partly-visible labels are kept (the
 * browser clips them at the canvas edge, which is the correct look for a label anchored to a
 * room that is half off-screen) but fully-off-screen ones are dropped, both to save comparisons
 * and, more importantly, so an off-screen label cannot reserve space against an on-screen one.
 */
function isOffscreen(candidate: LabelCandidate, viewport: Viewport): boolean {
  const halfW = candidate.width / 2
  const halfH = candidate.height / 2
  return (
    candidate.centerX + halfW < 0 ||
    candidate.centerX - halfW > viewport.width ||
    candidate.centerY + halfH < 0 ||
    candidate.centerY - halfH > viewport.height
  )
}

/**
 * Decides which labels draw this tick. Returns their keys IN PLACEMENT ORDER (i.e. sorted by
 * priority), which makes the result directly assertable in tests.
 *
 * Pure and total: same input always gives the same output, `candidates` is not mutated, and the
 * input order is irrelevant because the first thing this does is sort a copy by
 * (priority, key). The key tie-break exists so that two rooms that were somehow given the same
 * priority still resolve the same way every tick instead of depending on array order.
 */
export function selectVisibleLabels(
  candidates: readonly LabelCandidate[],
  viewport: Viewport,
  gap: number = LABEL_GAP_PX,
): string[] {
  const ordered = [...candidates].sort(
    (a, b) => a.priority - b.priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )

  const placed: LabelCandidate[] = []
  const visible: string[] = []

  for (const candidate of ordered) {
    if (!candidate.eligible) continue
    if (isOffscreen(candidate, viewport)) continue
    if (placed.some((other) => labelsCollide(candidate, other, gap))) continue
    placed.push(candidate)
    visible.push(candidate.key)
  }

  return visible
}
