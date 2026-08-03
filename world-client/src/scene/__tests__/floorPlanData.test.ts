/**
 * Validates the real, shipped world-client/public/data/floor-14.json against the client's
 * TypeScript view of it (floorPlanTypes.ts) and the specific geometric invariants the scene
 * components (Floor.tsx/Walls.tsx) depend on.
 *
 * The server has loadFloorPlan.ts's validateFloorPlan() as a guard against a malformed file;
 * the client has none (floorPlanTypes.ts is a type-only mirror, no runtime check -- see its
 * doc comment). This test is that missing guard, run against the file the client actually
 * fetches at runtime, not just against the server's copy.
 *
 * This is also the regression test for the exact incident this task was written to prevent:
 * an algorithmic floor-14.json rebuild once silently dropped every `glass: true` wall (all
 * the glass partitions disappeared from the render, caught only by a human eyeballing it).
 * testGlassWallsSurvive() below fails loudly if that happens again.
 *
 * Plain node:assert script, run with tsx -- matches world/'s test convention.
 * Run with: npx tsx src/scene/__tests__/floorPlanData.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { FloorPlan, FloorPlanHole, FloorPlanRoom, FloorPlanWall, Point2D } from '../floorPlanTypes'

const FLOOR_PLAN_PATH = fileURLToPath(new URL('../../../public/data/floor-14.json', import.meta.url))

// A minimum a real building floor should clear -- generous enough to never false-positive on
// legitimate map edits, tight enough to catch "the walls array came back empty/near-empty"
// (e.g. a rebuild step silently producing a near-blank file).
const MIN_GLASS_WALLS = 1
const MIN_TOTAL_WALLS = 10
const MIN_ROOMS = 1

/**
 * Runtime validator for the FloorPlan shape (floorPlanTypes.ts), independent from the
 * server's validateFloorPlan (world/src/nav/loadFloorPlan.ts) -- world-client is a separate
 * package that doesn't import world/'s sources (see floorPlanTypes.ts's doc comment), so this
 * is a fresh, self-contained check of the same shape rather than a shared import. Deliberately
 * stricter than "typeof === 'number'" on every coordinate: Number.isFinite rejects NaN and
 * +/-Infinity too, which `typeof x === 'number'` alone would let through silently.
 */
function assertPoint(value: unknown, label: string): asserts value is Point2D {
  assert.ok(Array.isArray(value), `${label} should be an array`)
  assert.equal((value as unknown[]).length, 2, `${label} should be a [x, z] pair`)
  const [x, z] = value as unknown[]
  assert.ok(typeof x === 'number' && Number.isFinite(x), `${label}[0] (x) should be a finite number, got ${JSON.stringify(x)}`)
  assert.ok(typeof z === 'number' && Number.isFinite(z), `${label}[1] (z) should be a finite number, got ${JSON.stringify(z)}`)
}

function assertPointArray(value: unknown, label: string): asserts value is Point2D[] {
  assert.ok(Array.isArray(value), `${label} should be an array`)
  ;(value as unknown[]).forEach((p, i) => assertPoint(p, `${label}[${i}]`))
}

function validateClientFloorPlan(data: unknown): FloorPlan {
  assert.ok(typeof data === 'object' && data !== null, 'floor plan root should be an object')
  const obj = data as Record<string, unknown>

  assert.equal(typeof obj.units, 'string', 'units should be a string')
  assert.equal(typeof obj.floor, 'number', 'floor should be a number')

  assertPointArray(obj.walkableOutline, 'walkableOutline')
  assert.ok((obj.walkableOutline as Point2D[]).length >= 3, 'walkableOutline needs >= 3 points')

  assert.ok(Array.isArray(obj.holes), 'holes should be an array')
  ;(obj.holes as unknown[]).forEach((h, i) => {
    assert.ok(typeof h === 'object' && h !== null, `holes[${i}] should be an object`)
    const hole = h as Record<string, unknown>
    assert.equal(typeof hole.name, 'string', `holes[${i}].name should be a string`)
    assertPointArray(hole.polygon, `holes[${i}].polygon`)
    assert.ok((hole.polygon as Point2D[]).length >= 3, `holes[${i}].polygon needs >= 3 points`)
  })

  assert.ok(Array.isArray(obj.walls), 'walls should be an array')
  ;(obj.walls as unknown[]).forEach((w, i) => {
    assert.ok(typeof w === 'object' && w !== null, `walls[${i}] should be an object`)
    const wall = w as Record<string, unknown>
    assertPoint(wall.a, `walls[${i}].a`)
    assertPoint(wall.b, `walls[${i}].b`)
    assert.ok(typeof wall.height === 'number' && Number.isFinite(wall.height) && wall.height > 0, `walls[${i}].height should be a positive finite number`)
    assert.equal(typeof wall.glass, 'boolean', `walls[${i}].glass should be a boolean`)
    if (wall.note !== undefined) {
      assert.equal(typeof wall.note, 'string', `walls[${i}].note should be a string if present`)
    }
  })

  assert.ok(Array.isArray(obj.rooms), 'rooms should be an array')
  ;(obj.rooms as unknown[]).forEach((r, i) => {
    assert.ok(typeof r === 'object' && r !== null, `rooms[${i}] should be an object`)
    const room = r as Record<string, unknown>
    assert.equal(typeof room.name, 'string', `rooms[${i}].name should be a string`)
    if (room.aliases !== undefined) {
      assert.ok(Array.isArray(room.aliases), `rooms[${i}].aliases should be an array if present`)
      ;(room.aliases as unknown[]).forEach((a, j) =>
        assert.equal(typeof a, 'string', `rooms[${i}].aliases[${j}] should be a string`),
      )
    }
    assertPoint(room.center, `rooms[${i}].center`)
    assertPoint(room.door, `rooms[${i}].door`)
  })

  assert.ok(typeof obj.entrance === 'object' && obj.entrance !== null, 'entrance should be an object')
  const entrance = obj.entrance as Record<string, unknown>
  assert.equal(typeof entrance.name, 'string', 'entrance.name should be a string')
  assertPoint(entrance.point, 'entrance.point')

  return data as FloorPlan
}

function loadPlan(): FloorPlan {
  const raw = readFileSync(FLOOR_PLAN_PATH, 'utf-8')
  const data = JSON.parse(raw)
  return validateClientFloorPlan(data)
}

function testShapeMatchesFloorPlanTypes(): void {
  const plan = loadPlan()
  assert.equal(plan.units, 'meters')
  assert.equal(plan.floor, 14)
  assert.ok(plan.rooms.length >= MIN_ROOMS, `expected >= ${MIN_ROOMS} rooms, got ${plan.rooms.length}`)
  assert.ok(plan.walls.length >= MIN_TOTAL_WALLS, `expected >= ${MIN_TOTAL_WALLS} walls, got ${plan.walls.length}`)
  console.log(
    `PASS: world-client/public/data/floor-14.json satisfies FloorPlan (${plan.rooms.length} rooms, ` +
      `${plan.walls.length} walls, ${plan.holes.length} holes)`,
  )
}

function testGlassWallsSurvive(): void {
  const plan = loadPlan()
  const glass = plan.walls.filter((w: FloorPlanWall) => w.glass === true)
  const solid = plan.walls.filter((w: FloorPlanWall) => w.glass === false)

  assert.ok(
    glass.length >= MIN_GLASS_WALLS,
    `expected at least ${MIN_GLASS_WALLS} glass wall(s) to survive in floor-14.json, found ${glass.length} ` +
      `-- this is the exact regression an algorithmic rebuild once caused (every glass:true wall silently dropped)`,
  )
  assert.equal(
    glass.length + solid.length,
    plan.walls.length,
    `solid (${solid.length}) + glass (${glass.length}) walls should sum to the total wall count (${plan.walls.length}) ` +
      '-- every wall.glass should be a real boolean, not something falling through both filters',
  )
  console.log(
    `PASS: ${glass.length} glass + ${solid.length} solid = ${plan.walls.length} total walls (glass walls present and accounted for)`,
  )
}

function testNoDegenerateWallSegments(): void {
  const plan = loadPlan()
  const degenerate: string[] = []
  for (const wall of plan.walls) {
    const [ax, az] = wall.a
    const [bx, bz] = wall.b
    const length = Math.hypot(bx - ax, bz - az)
    if (!(length > 0)) {
      degenerate.push(`${wall.note ?? '(unnamed wall)'} a=${JSON.stringify(wall.a)} b=${JSON.stringify(wall.b)}`)
    }
  }
  assert.equal(
    degenerate.length,
    0,
    `${degenerate.length} wall(s) have zero (or NaN) length -- a's and b's coincide, which produces a ` +
      `zero-scale THREE.BoxGeometry (invisible wall) in Walls.tsx: ${degenerate.join('; ')}`,
  )
  console.log(`PASS: all ${plan.walls.length} wall segments have non-zero length`)
}

/** Shoelace formula for a simple (non-self-intersecting) polygon's signed area. */
function polygonArea(points: Point2D[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i]
    const [x2, z2] = points[(i + 1) % points.length]
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

function testFloorAreaWithHolesIsPositiveAndPlausible(): void {
  const plan = loadPlan()
  const outlineArea = polygonArea(plan.walkableOutline)
  const holesArea = plan.holes.reduce((sum: number, h: FloorPlanHole) => sum + polygonArea(h.polygon), 0)
  const netArea = outlineArea - holesArea

  assert.ok(outlineArea > 0, `walkableOutline should enclose positive area, got ${outlineArea}`)
  assert.ok(
    holesArea < outlineArea,
    `holes' total area (${holesArea.toFixed(2)}m^2) should be smaller than the outline's (${outlineArea.toFixed(2)}m^2) ` +
      '-- a hole polygon bigger than the floor itself indicates corrupted/duplicated coordinates',
  )
  assert.ok(
    netArea > 0,
    `floor area with holes subtracted should be positive, got ${netArea.toFixed(2)}m^2 (outline ${outlineArea.toFixed(2)} - holes ${holesArea.toFixed(2)})`,
  )
  // Plausibility band for a single-floor demo space: well above a closet, well below a
  // stadium. Not a tight bound -- just enough to catch "area came out near-zero" (a
  // degenerate/duplicated outline) or "area came out absurdly large" (units mixed up, e.g.
  // centimeters fed in as meters).
  assert.ok(
    netArea > 50 && netArea < 5000,
    `net floor area ${netArea.toFixed(2)}m^2 is outside the plausible band (50-5000 m^2) for a single demo floor`,
  )
  console.log(
    `PASS: floor area with holes subtracted is positive and plausible (outline ${outlineArea.toFixed(2)}m^2 - ` +
      `holes ${holesArea.toFixed(2)}m^2 = ${netArea.toFixed(2)}m^2)`,
  )
}

function testRoomsResolveToRealPointsOnOutline(): void {
  const plan = loadPlan()
  for (const room of plan.rooms as FloorPlanRoom[]) {
    assert.ok(
      Number.isFinite(room.center[0]) && Number.isFinite(room.center[1]),
      `room "${room.name}" center should be finite, got ${JSON.stringify(room.center)}`,
    )
    assert.ok(
      Number.isFinite(room.door[0]) && Number.isFinite(room.door[1]),
      `room "${room.name}" door should be finite, got ${JSON.stringify(room.door)}`,
    )
  }
  console.log(`PASS: all ${plan.rooms.length} rooms have finite center/door coordinates`)
}

function main(): void {
  testShapeMatchesFloorPlanTypes()
  testGlassWallsSurvive()
  testNoDegenerateWallSegments()
  testFloorAreaWithHolesIsPositiveAndPlausible()
  testRoomsResolveToRealPointsOnOutline()
  console.log('ALL PASS: floorPlanData.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
