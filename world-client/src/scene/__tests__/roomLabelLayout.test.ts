/**
 * Offline proof for the room-label placement rule added 2026-08-09 (see ../roomLabelLayout.ts
 * and ../RoomLabels.tsx). The labels used to be drei <Html> nodes with `distanceFactor={10}` and
 * no layout pass at all, which produced the two defects this fixes: they piled into an
 * unreadable stack in dense areas (worst case the three washrooms), and they had no usable size
 * because distanceFactor pins a label to a size in WORLD meters, so it became a speck when the
 * camera framed the whole floor and a banner when it framed one room.
 *
 * This environment cannot be relied on to composite a WebGL frame (the same limitation
 * floorGeometry.test.ts documents), so "the washroom cluster is readable" is proven here
 * numerically instead of by screenshot: the washroom rectangles are built from floor-14.json's
 * REAL room centres at three real pixels-per-meter zoom levels, and the test asserts exactly
 * which of the three survive at each. That is the same function the component calls, on the same
 * shape of input, so it is the actual shipped decision and not a restatement of it.
 *
 * Plain node:assert script, run with tsx -- matches this package's test convention.
 * Run with: npx tsx src/scene/__tests__/roomLabelLayout.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { FloorPlan } from '../floorPlanTypes'
import {
  ESTIMATED_LABEL_HEIGHT_PX,
  LABEL_GAP_PX,
  estimateLabelWidthPx,
  labelsCollide,
  selectVisibleLabels,
  type LabelCandidate,
} from '../roomLabelLayout'

const FLOOR_PLAN_PATH = fileURLToPath(new URL('../../../public/data/floor-14.json', import.meta.url))
const VIEWPORT = { width: 1600, height: 900 }

/** Terse candidate builder so the interesting numbers in each case stay visible. */
function candidate(
  key: string,
  priority: number,
  centerX: number,
  centerY: number,
  width = 100,
  height = 20,
  eligible = true,
): LabelCandidate {
  return { key, priority, centerX, centerY, width, height, eligible }
}

// ---------------------------------------------------------------------------------------------
// 1. Non-overlapping labels all draw. The baseline: culling must not be trigger-happy.
// ---------------------------------------------------------------------------------------------
{
  const visible = selectVisibleLabels(
    [candidate('a', 0, 200, 200), candidate('b', 1, 600, 200), candidate('c', 2, 1000, 700)],
    VIEWPORT,
  )
  assert.deepEqual(visible, ['a', 'b', 'c'], 'well-separated labels should all draw')
}

// ---------------------------------------------------------------------------------------------
// 2. Overlapping pair: the HIGHER priority (lower number) label wins, and it wins regardless of
//    the order the candidates arrive in. Input-order dependence is exactly the bug that would
//    make labels flicker as R3F reorders work, so it is pinned explicitly.
// ---------------------------------------------------------------------------------------------
{
  const winner = candidate('important', 0, 400, 300)
  const loser = candidate('crowded-out', 5, 430, 300)

  assert.deepEqual(selectVisibleLabels([winner, loser], VIEWPORT), ['important'])
  assert.deepEqual(
    selectVisibleLabels([loser, winner], VIEWPORT),
    ['important'],
    'placement must depend on priority, never on input order',
  )
}

// ---------------------------------------------------------------------------------------------
// 3. Equal priorities still resolve deterministically, via the key tie-break. Without this a
//    same-priority pair could swap which one is hidden between ticks and visibly strobe.
// ---------------------------------------------------------------------------------------------
{
  const alpha = candidate('alpha', 3, 400, 300)
  const beta = candidate('beta', 3, 430, 300)
  assert.deepEqual(selectVisibleLabels([alpha, beta], VIEWPORT), ['alpha'])
  assert.deepEqual(selectVisibleLabels([beta, alpha], VIEWPORT), ['alpha'])
}

// ---------------------------------------------------------------------------------------------
// 4. Chain case: A blocks B, B would block C, but A and C do not touch. Greedy first-fit must
//    still draw C. A naive "drop everything a hidden label touches" rule would lose it.
// ---------------------------------------------------------------------------------------------
{
  const visible = selectVisibleLabels(
    [candidate('A', 0, 400, 300), candidate('B', 1, 480, 300), candidate('C', 2, 560, 300)],
    VIEWPORT,
  )
  assert.deepEqual(visible, ['A', 'C'], 'a hidden middle label must not suppress the far one')
}

// ---------------------------------------------------------------------------------------------
// 5. An ineligible label (behind the camera, or drei's occlude raycast found a wall in front of
//    it) must not reserve screen space. If it did, the map would show a hole with NOTHING drawn
//    in it: the occluded label is invisible and the label it displaced is culled.
// ---------------------------------------------------------------------------------------------
{
  const occluded = candidate('behind-wall', 0, 400, 300, 100, 20, false)
  const shouldShow = candidate('in-the-open', 1, 430, 300)
  assert.deepEqual(selectVisibleLabels([occluded, shouldShow], VIEWPORT), ['in-the-open'])
}

// ---------------------------------------------------------------------------------------------
// 6. Fully off-screen labels are dropped (and, like case 5, do not reserve space); a label
//    straddling the canvas edge is KEPT, because a room half out of frame should still be named.
// ---------------------------------------------------------------------------------------------
{
  assert.deepEqual(
    selectVisibleLabels([candidate('far-left', 0, -400, 300), candidate('onscreen', 1, 800, 300)], VIEWPORT),
    ['onscreen'],
  )
  // Centre 20px left of the canvas edge with a 100px-wide pill: 30px of it is still visible.
  assert.deepEqual(selectVisibleLabels([candidate('straddling', 0, -20, 300)], VIEWPORT), ['straddling'])
  // Same label pushed just past the edge: right edge at -1px, nothing visible.
  assert.deepEqual(selectVisibleLabels([candidate('just-out', 0, -51, 300)], VIEWPORT), [])
}

// ---------------------------------------------------------------------------------------------
// 7. The gutter is real: rectangles that clear each other by less than LABEL_GAP_PX still count
//    as colliding, so two labels never end up drawn pixel-adjacent and reading as one blob.
// ---------------------------------------------------------------------------------------------
{
  const a = candidate('a', 0, 400, 300, 100, 20)
  const bTouching = candidate('b', 1, 400 + 100 + LABEL_GAP_PX - 1, 300, 100, 20)
  const bClear = candidate('b', 1, 400 + 100 + LABEL_GAP_PX, 300, 100, 20)
  assert.equal(labelsCollide(a, bTouching), true, 'sub-gap separation must count as a collision')
  assert.equal(labelsCollide(a, bClear), false, 'exactly one gap of clearance is enough')
  assert.deepEqual(selectVisibleLabels([a, bTouching], VIEWPORT), ['a'])
  assert.deepEqual(selectVisibleLabels([a, bClear], VIEWPORT), ['a', 'b'])
}

// ---------------------------------------------------------------------------------------------
// 8. Vertical separation alone resolves a horizontal overlap. Two labels stacked above each
//    other with the same x must both draw, otherwise a whole column of the map would go blank.
// ---------------------------------------------------------------------------------------------
{
  const visible = selectVisibleLabels(
    [candidate('top', 0, 400, 300, 100, 20), candidate('bottom', 1, 400, 300 + 20 + LABEL_GAP_PX, 100, 20)],
    VIEWPORT,
  )
  assert.deepEqual(visible, ['top', 'bottom'])
}

// ---------------------------------------------------------------------------------------------
// 9. THE REPORTED DEFECT: the washroom cluster, from floor-14.json's real coordinates.
//
//    "Female Washroom" (x=14.291), "Male Washroom" (x=19.556) and "Gender Neutral Washroom"
//    (x=22.3) share a z, so they land on one horizontal screen row and their pills are 115 /
//    102 / 168 px wide. Because the labels no longer scale with distance, the ONLY thing that
//    changes with zoom is how far apart the anchors project, so this is exactly a
//    pixels-per-meter sweep. Asserted per zoom level:
//      - zoomed out and mid: the two widest neighbours cannot both fit, so the lower-priority
//        one is dropped and what remains is legible and non-overlapping,
//      - zoomed in: all three fit and all three draw.
//    Priority is floor-plan authoring order (Female 9, Male 10, Gender Neutral 11), which is
//    what makes "which one is dropped" stable rather than camera-dependent.
// ---------------------------------------------------------------------------------------------
{
  const floorPlan: FloorPlan = JSON.parse(readFileSync(FLOOR_PLAN_PATH, 'utf8'))
  const washrooms = floorPlan.rooms
    .map((room, index) => ({ room, priority: index }))
    .filter(({ room }) => room.name.endsWith('Washroom'))

  assert.deepEqual(
    washrooms.map(({ room }) => room.name),
    ['Female Washroom', 'Male Washroom', 'Gender Neutral Washroom'],
    'floor-14.json still has the three-washroom cluster this case is about',
  )
  assert.deepEqual(
    washrooms.map(({ priority }) => priority),
    [9, 10, 11],
    'authoring order (and so label priority) inside the cluster is unchanged',
  )
  // They really are on one screen row: their z values agree to within 8cm, which is a couple of
  // pixels at any zoom this scene reaches, so there is no vertical separation to save them and
  // the collision is purely horizontal.
  const zs = washrooms.map(({ room }) => room.center[1])
  assert.ok(
    Math.max(...zs) - Math.min(...zs) < 0.1,
    `washroom anchors should share a screen row, z spread was ${Math.max(...zs) - Math.min(...zs)}m`,
  )

  /** Projects the cluster at a given screen scale, anchored so the first one sits at (400, 450). */
  function clusterAt(pixelsPerMeter: number): LabelCandidate[] {
    const [originX, originZ] = washrooms[0].room.center
    return washrooms.map(({ room, priority }) => ({
      key: room.name,
      priority,
      centerX: 400 + (room.center[0] - originX) * pixelsPerMeter,
      centerY: 450 - (room.center[1] - originZ) * pixelsPerMeter,
      width: estimateLabelWidthPx(room.name),
      height: ESTIMATED_LABEL_HEIGHT_PX,
      eligible: true,
    }))
  }

  // Widths this case depends on, pinned so a future style change that widens the pill shows up
  // here as a failing width rather than as a silently different cull.
  assert.deepEqual(
    clusterAt(40).map((c) => c.width),
    [115, 102, 168],
  )

  // Whole floor in frame (~25 px/m): the two right-hand labels are 68px apart and need 141px.
  assert.deepEqual(
    selectVisibleLabels(clusterAt(25), VIEWPORT),
    ['Female Washroom', 'Male Washroom'],
    'zoomed out: the pair that fits draws, the third is dropped rather than piled on top',
  )

  // Mid zoom (~40 px/m): Female/Male now clear each other easily, Male/Gender Neutral still do not.
  assert.deepEqual(
    selectVisibleLabels(clusterAt(40), VIEWPORT),
    ['Female Washroom', 'Male Washroom'],
    'mid zoom: same two, so nothing flickers between the zoomed-out and mid views',
  )

  // Zoomed in on the cluster (~70 px/m): 192px between the last pair, 141px needed. All three.
  assert.deepEqual(
    selectVisibleLabels(clusterAt(70), VIEWPORT),
    ['Female Washroom', 'Male Washroom', 'Gender Neutral Washroom'],
    'zoomed in: every washroom is named',
  )

  // Monotonicity: zooming IN never removes a label that was visible zoomed out. This is what
  // makes the culling feel like a map instead of like flicker.
  for (const [outer, inner] of [
    [25, 40],
    [40, 70],
    [25, 70],
  ] as const) {
    const outerVisible = selectVisibleLabels(clusterAt(outer), VIEWPORT)
    const innerVisible = new Set(selectVisibleLabels(clusterAt(inner), VIEWPORT))
    for (const key of outerVisible) {
      assert.ok(innerVisible.has(key), `${key} disappeared when zooming ${outer} -> ${inner} px/m`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 10. Whole floor, all 18 rooms, at the zoom that frames the building: whatever survives must be
//     mutually non-overlapping (the actual user-visible requirement), the input must not be
//     mutated, and repeating the call must give an identical answer.
// ---------------------------------------------------------------------------------------------
{
  const floorPlan: FloorPlan = JSON.parse(readFileSync(FLOOR_PLAN_PATH, 'utf8'))
  const pixelsPerMeter = 30
  const all: LabelCandidate[] = floorPlan.rooms.map((room, index) => ({
    key: room.name,
    priority: index,
    centerX: room.center[0] * pixelsPerMeter + 100,
    centerY: 800 - room.center[1] * pixelsPerMeter,
    width: estimateLabelWidthPx(room.name),
    height: ESTIMATED_LABEL_HEIGHT_PX,
    eligible: true,
  }))
  const before = JSON.stringify(all)

  const visible = selectVisibleLabels(all, VIEWPORT)
  assert.equal(JSON.stringify(all), before, 'selectVisibleLabels must not mutate its input')
  assert.deepEqual(selectVisibleLabels(all, VIEWPORT), visible, 'repeated calls must agree')

  const drawn = all.filter((c) => visible.includes(c.key))
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      assert.ok(
        !labelsCollide(drawn[i], drawn[j]),
        `${drawn[i].key} and ${drawn[j].key} were both drawn but overlap`,
      )
    }
  }
  assert.ok(
    drawn.length >= 12,
    `expected most of the 18 rooms to still be named at building zoom, got ${drawn.length}`,
  )
  console.log(`  whole-floor @ ${pixelsPerMeter} px/m: ${drawn.length}/18 labels drawn`)
  console.log(`  dropped: ${all.filter((c) => !visible.includes(c.key)).map((c) => c.key).join(', ') || '(none)'}`)
}

console.log('roomLabelLayout.test.ts: all assertions passed')
