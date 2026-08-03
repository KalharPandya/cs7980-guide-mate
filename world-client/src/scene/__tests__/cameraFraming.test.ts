/**
 * Camera-framing sanity, against the real, shipped floor-14.json.
 *
 * App.tsx derives the camera position and MapControls target entirely from
 * computeOutlineBounds(floorPlan.walkableOutline) (see App.tsx's "floor-14.json's real
 * footprint is NOT centered on the origin" comment) -- there is no hardcoded fallback. The
 * floor plate's footprint changed shape mid-project (from a ~36x21 axis-aligned box to a
 * ~35.6x27.4 "pinwheel" outline after a re-trace); this test is the guard that whatever
 * computeOutlineBounds derives from the CURRENT outline actually contains the whole building
 * -- every wall, room, and the entrance -- so the rendered view can't silently end up
 * off-centre or clipping part of the plate on the next re-trace.
 *
 * Plain node:assert script, run with tsx -- matches world/'s test convention.
 * Run with: npx tsx src/scene/__tests__/cameraFraming.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { computeOutlineBounds } from '../floorPlanUtils'
import type { FloorPlan, Point2D } from '../floorPlanTypes'

const FLOOR_PLAN_PATH = fileURLToPath(new URL('../../../public/data/floor-14.json', import.meta.url))

// Small slack for points that legitimately sit a few centimeters outside the outline
// polygon's own bounding box (e.g. a wall centerline running flush along the building edge
// can poke a few cm past the nearest outline vertex). Verified against the real floor-14.json
// (2026-08-02 re-trace): the worst observed overhang is ~0.074m. 0.5m stays generous
// (over 6x that) while still catching a real "wall coordinates are meters away from the
// building" bug, which is what this test exists to catch.
const CONTAINMENT_SLACK_M = 0.5

function loadPlan(): FloorPlan {
  const raw = readFileSync(FLOOR_PLAN_PATH, 'utf-8')
  return JSON.parse(raw) as FloorPlan
}

function testBoundsAreNonDegenerate(): void {
  const plan = loadPlan()
  const bounds = computeOutlineBounds(plan.walkableOutline)
  assert.ok(bounds.sizeX > 0, `bounds.sizeX should be positive, got ${bounds.sizeX}`)
  assert.ok(bounds.sizeZ > 0, `bounds.sizeZ should be positive, got ${bounds.sizeZ}`)
  // Sanity band around the two footprints this project has actually had (~36x21 axis-aligned,
  // then ~35.6x27.4 pinwheel) -- wide enough to not fight a reasonable future re-trace, tight
  // enough to catch "the outline came back as a handful of degenerate/duplicated points".
  assert.ok(
    bounds.sizeX > 5 && bounds.sizeX < 200,
    `bounds.sizeX (${bounds.sizeX.toFixed(2)}) is outside the plausible band (5-200m) for this floor`,
  )
  assert.ok(
    bounds.sizeZ > 5 && bounds.sizeZ < 200,
    `bounds.sizeZ (${bounds.sizeZ.toFixed(2)}) is outside the plausible band (5-200m) for this floor`,
  )
  console.log(
    `PASS: camera bounds are non-degenerate (sizeX=${bounds.sizeX.toFixed(2)}m, sizeZ=${bounds.sizeZ.toFixed(2)}m)`,
  )
}

function testTargetLiesInsideBounds(): void {
  const plan = loadPlan()
  const bounds = computeOutlineBounds(plan.walkableOutline)
  assert.ok(
    bounds.centerX >= bounds.minX && bounds.centerX <= bounds.maxX,
    `MapControls target X (${bounds.centerX}) should lie within [${bounds.minX}, ${bounds.maxX}]`,
  )
  assert.ok(
    bounds.centerZ >= bounds.minZ && bounds.centerZ <= bounds.maxZ,
    `MapControls target Z (${bounds.centerZ}) should lie within [${bounds.minZ}, ${bounds.maxZ}]`,
  )
  console.log(
    `PASS: camera/MapControls target (${bounds.centerX.toFixed(2)}, ${bounds.centerZ.toFixed(2)}) lies inside the outline's own bounds`,
  )
}

/**
 * The actual regression this guards: camera framing is derived ONLY from walkableOutline
 * (App.tsx), but everything else rendered (walls, rooms, entrance) must actually live inside
 * that same footprint, or the "frame the outline" strategy silently clips real geometry that
 * sits outside it. A future data change that adds a wall/room far outside the traced outline
 * (e.g. a coordinate typo, or a rebuild that emits stale/duplicated points) would render off
 * the edge of the screen without this check.
 */
function testEveryWallRoomAndEntranceLiesWithinOutlineBounds(): void {
  const plan = loadPlan()
  const bounds = computeOutlineBounds(plan.walkableOutline)

  const outside: string[] = []
  const checkPoint = (p: Point2D, label: string) => {
    const [x, z] = p
    if (
      x < bounds.minX - CONTAINMENT_SLACK_M ||
      x > bounds.maxX + CONTAINMENT_SLACK_M ||
      z < bounds.minZ - CONTAINMENT_SLACK_M ||
      z > bounds.maxZ + CONTAINMENT_SLACK_M
    ) {
      outside.push(`${label} = (${x}, ${z})`)
    }
  }

  for (const wall of plan.walls) {
    checkPoint(wall.a, `wall[${wall.note ?? '?'}].a`)
    checkPoint(wall.b, `wall[${wall.note ?? '?'}].b`)
  }
  for (const room of plan.rooms) {
    checkPoint(room.center, `room "${room.name}".center`)
    checkPoint(room.door, `room "${room.name}".door`)
  }
  checkPoint(plan.entrance.point, 'entrance.point')

  assert.equal(
    outside.length,
    0,
    `${outside.length} point(s) fall outside the outline's bounds by more than ${CONTAINMENT_SLACK_M}m ` +
      `(camera framing would clip them): ${outside.join('; ')}`,
  )
  console.log(
    `PASS: every wall endpoint, room center/door, and the entrance lies within ${CONTAINMENT_SLACK_M}m of the ` +
      'outline bounds the camera frames on',
  )
}

function main(): void {
  testBoundsAreNonDegenerate()
  testTargetLiesInsideBounds()
  testEveryWallRoomAndEntranceLiesWithinOutlineBounds()
  console.log('ALL PASS: cameraFraming.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
