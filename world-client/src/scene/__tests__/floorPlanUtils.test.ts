/**
 * Unit tests for floorPlanUtils.ts's two exported pure functions: computeOutlineBounds
 * (camera/MapControls framing, App.tsx) and directionToYRotation (wall/agent facing,
 * Walls.tsx). Plain node:assert script, run with tsx -- matches world/'s test convention.
 *
 * Run with: npx tsx src/scene/__tests__/floorPlanUtils.test.ts
 */
import assert from 'node:assert/strict'

import { computeOutlineBounds, directionToYRotation } from '../floorPlanUtils'
import type { Point2D } from '../floorPlanTypes'

const EPS = 1e-9

function assertClose(actual: number, expected: number, label: string, eps = EPS): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${label}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  )
}

// --- computeOutlineBounds ---------------------------------------------------------------

function testComputeOutlineBoundsAxisAlignedRectangle(): void {
  const points: Point2D[] = [
    [0, 0],
    [10, 0],
    [10, 4],
    [0, 4],
  ]
  const bounds = computeOutlineBounds(points)
  assert.equal(bounds.minX, 0)
  assert.equal(bounds.maxX, 10)
  assert.equal(bounds.minZ, 0)
  assert.equal(bounds.maxZ, 4)
  assert.equal(bounds.centerX, 5)
  assert.equal(bounds.centerZ, 2)
  assert.equal(bounds.sizeX, 10)
  assert.equal(bounds.sizeZ, 4)
  console.log('PASS: computeOutlineBounds on an axis-aligned rectangle')
}

function testComputeOutlineBoundsNotCenteredOnOrigin(): void {
  // floor-14.json's real footprint is NOT centered on the origin (x:[0,~35], z:[~0,~26]) --
  // this is exactly the case App.tsx's doc comment calls out as the reason bounds must be
  // computed from the data, not assumed to be symmetric around (0,0).
  const points: Point2D[] = [
    [18, 9],
    [30, 9],
    [30, 21],
    [18, 21],
  ]
  const bounds = computeOutlineBounds(points)
  assert.equal(bounds.centerX, 24)
  assert.equal(bounds.centerZ, 15)
  assert.notEqual(bounds.centerX, 0, 'center should not default to the origin for an off-origin outline')
  console.log('PASS: computeOutlineBounds correctly centers an off-origin outline (not defaulting to (0,0))')
}

function testComputeOutlineBoundsNegativeCoordinates(): void {
  const points: Point2D[] = [
    [-5, -3],
    [-1, -3],
    [-1, 2],
    [-5, 2],
  ]
  const bounds = computeOutlineBounds(points)
  assert.equal(bounds.minX, -5)
  assert.equal(bounds.maxX, -1)
  assert.equal(bounds.minZ, -3)
  assert.equal(bounds.maxZ, 2)
  assert.equal(bounds.sizeX, 4)
  assert.equal(bounds.sizeZ, 5)
  console.log('PASS: computeOutlineBounds handles negative coordinates')
}

function testComputeOutlineBoundsDegenerateSinglePoint(): void {
  const points: Point2D[] = [[7, -2]]
  const bounds = computeOutlineBounds(points)
  assert.equal(bounds.minX, 7)
  assert.equal(bounds.maxX, 7)
  assert.equal(bounds.centerX, 7)
  assert.equal(bounds.sizeX, 0)
  assert.equal(bounds.sizeZ, 0)
  console.log('PASS: computeOutlineBounds on a single degenerate point collapses to size 0, not NaN/Infinity')
}

// --- directionToYRotation ----------------------------------------------------------------

function testDirectionToYRotationCardinalDirections(): void {
  // BoxGeometry's local +X aligns to world (cos(theta), -sin(theta)); see floorPlanUtils.ts's
  // derivation comment. These are the four quadrant/axis anchor points that comment's formula
  // must hit exactly.
  assertClose(directionToYRotation(1, 0), 0, '+X direction (dx=1,dz=0) -> rotation 0')
  assertClose(directionToYRotation(0, 1), -Math.PI / 2, '+Z direction (dx=0,dz=1) -> rotation -pi/2')
  assertClose(directionToYRotation(0, -1), Math.PI / 2, '-Z direction (dx=0,dz=-1) -> rotation +pi/2')
  // dz=0 here means -dz is the IEEE-754 negative zero, so atan2(-0, -1) resolves to the
  // negative branch: -Math.PI exactly (not +Math.PI, even though both represent the same
  // geometric angle) -- see Math.atan2's sign-of-zero handling. Asserted as the exact value
  // the real function returns, not "close to +/-pi", so a change to that branch is caught.
  assertClose(directionToYRotation(-1, 0), -Math.PI, '-X direction (dx=-1,dz=0) -> rotation -pi (atan2(-0,-1))')
  console.log('PASS: directionToYRotation matches the documented value at all four cardinal directions')
}

function testDirectionToYRotationDiagonalQuadrants(): void {
  // All four diagonal quadrants -- sign of both dx and dz flips the result's sign/branch, the
  // classic place an atan2 argument-order bug (e.g. atan2(dz, -dx) or a dropped negation) goes
  // undetected by cardinal-only tests.
  assertClose(directionToYRotation(1, 1), -Math.PI / 4, '(dx=1,dz=1) -> -pi/4')
  assertClose(directionToYRotation(1, -1), Math.PI / 4, '(dx=1,dz=-1) -> +pi/4')
  assertClose(directionToYRotation(-1, 1), (-3 * Math.PI) / 4, '(dx=-1,dz=1) -> -3pi/4')
  assertClose(directionToYRotation(-1, -1), (3 * Math.PI) / 4, '(dx=-1,dz=-1) -> +3pi/4')
  console.log('PASS: directionToYRotation matches the documented value in all four diagonal quadrants')
}

/**
 * The project has a documented history of a heading double-convert bug (see
 * floorPlanUtils.ts's directionToYRotation doc comment): the world-server's agent.heading
 * (world/src/nav/crowd.ts) is computed as `Math.atan2(vel.x, vel.z)` -- a DIFFERENT
 * convention (aligns local +Z, matching the robot/visitor GLB models) from this function's
 * `Math.atan2(-dz, dx)` (aligns local +X, matching BoxGeometry). The doc comment states
 * these are "90 degrees away in general, not the same value" for the same (dx, dz) -- this
 * test pins down that exact relationship numerically, so that if either formula's sign or
 * argument order ever drifts (the classic way this bug reintroduces itself -- e.g. someone
 * "simplifies" Robot.tsx to route agent.heading through this function, or swaps this
 * function's arguments to "match" crowd.ts's order), the mismatch is caught immediately
 * instead of silently rotating every agent/wall 90 degrees off.
 */
function testDirectionToYRotationDiffersFromZConventionHeadingByExactlyNinetyDegrees(): void {
  const zConventionHeading = (dx: number, dz: number) => Math.atan2(dx, dz)
  const normalize = (angle: number): number => {
    let a = angle
    while (a > Math.PI) a -= 2 * Math.PI
    while (a <= -Math.PI) a += 2 * Math.PI
    return a
  }

  const directions: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 1],
    [-1, -1],
    [2, -3],
    [-5, 7],
    [0.001, -0.999],
  ]

  for (const [dx, dz] of directions) {
    const xConvention = directionToYRotation(dx, dz)
    const zConvention = zConventionHeading(dx, dz)
    const diff = normalize(xConvention - zConvention)
    assertClose(
      diff,
      -Math.PI / 2,
      `directionToYRotation(${dx}, ${dz}) vs atan2(${dx}, ${dz}) (z-convention heading) should differ by exactly -pi/2`,
      1e-9,
    )
  }
  console.log(
    'PASS: directionToYRotation (+X-aligning) and the world-server\'s heading formula (+Z-aligning, ' +
      'atan2(dx, dz)) differ by exactly -pi/2 for every direction tested -- the documented relationship, ' +
      'not an accidental match',
  )
}

function main(): void {
  testComputeOutlineBoundsAxisAlignedRectangle()
  testComputeOutlineBoundsNotCenteredOnOrigin()
  testComputeOutlineBoundsNegativeCoordinates()
  testComputeOutlineBoundsDegenerateSinglePoint()
  testDirectionToYRotationCardinalDirections()
  testDirectionToYRotationDiagonalQuadrants()
  testDirectionToYRotationDiffersFromZConventionHeadingByExactlyNinetyDegrees()
  console.log('ALL PASS: floorPlanUtils.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
