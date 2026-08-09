/**
 * Offline proof for the two purely cosmetic floor-geometry fixes made 2026-08-09:
 *
 *   1. Cores.tsx renders each `floorPlan.holes` polygon as a SOLID volume, so the elevator/stair
 *      shafts stop reading as see-through pits cut in the floor.
 *   2. Walls.tsx gives walls a thickness HIERARCHY (envelope / glass pane / full-height interior /
 *      short partition) instead of one uniform 0.15m slab, with envelope walls inset so the thicker
 *      exterior assembly grows inward rather than overhanging the floor slab.
 *
 * This environment cannot composite a WebGL frame (the risk register's documented #1 limitation --
 * the embedded Browser pane never renders), so "you can no longer see through the floor" cannot be
 * proven by screenshotting it. It CAN be proven geometrically, without a GL context: THREE.Shape,
 * THREE.ShapeGeometry and THREE.ExtrudeGeometry are pure CPU triangulation and need no renderer.
 * So this test builds the exact same geometry the components build, applies the exact same mesh
 * transform, and then measures:
 *
 *   - every sampled point inside a hole polygon IS covered by the core volume's XZ footprint
 *     (nothing left to see through), while
 *   - the SAME points are NOT covered by the floor slab's own triangles (i.e. the void the cores
 *     are filling genuinely exists, so this is a real fix and not a tautology), and
 *   - no part of the core spills OUTSIDE its hole polygon (it fills the gap, it does not sit on the
 *     surrounding carpet), and
 *   - the volume spans floor level to core height vertically (it is a standing block, not a decal).
 *
 * Plain node:assert script, run with tsx -- matches this package's test convention.
 * Run with: npx tsx src/scene/__tests__/floorGeometry.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as THREE from 'three'

import { coreHeightForWalls } from '../Cores'
import type { FloorPlan, FloorPlanHole, Point2D } from '../floorPlanTypes'
import {
  LEGACY_WALL_THICKNESS_M,
  OUTLINE_WALL_OUTER_FACE_OVERHANG_M,
  WALL_THICKNESS_M,
  computeWallPlacement,
  findOutlineEdgeIndex,
  polygonSignedArea,
  tallestWallHeight,
} from '../floorPlanUtils'

const FLOOR_PLAN_PATH = fileURLToPath(new URL('../../../public/data/floor-14.json', import.meta.url))

/** Values Cores.tsx keeps private (they are implementation detail, not API); restated here so a
 * change to either one has to be a deliberate, visible edit in two places rather than a silent
 * drift in one. */
const EXPECTED_CORE_BASE_SINK_M = 0.02
const EXPECTED_CORE_HEIGHT_ABOVE_TALLEST_WALL_M = 0.15

/** Sample spacing (meters) for the interior-coverage grid. The two cores are roughly 11.6m x 4.4m
 * and 11.6m x 2.3m, so 0.25m puts a few hundred probes in each -- dense enough that a hole in the
 * triangulation could not hide between samples, cheap enough to run in well under a second. */
const SAMPLE_SPACING_M = 0.25

/**
 * Geometric slop (meters) allowed when deciding whether a probe is covered by a triangle, or
 * whether a core vertex sits on its hole's boundary.
 *
 * This is NOT a fudge factor for a real gap: three.js stores a BufferGeometry's positions as
 * float32, so a coordinate authored as the double 11.685 comes back out of the position attribute
 * as 11.6850004196167 -- about 4e-7m of quantization at floor-14.json's ~10-35m coordinate
 * magnitudes. Probes sampled exactly on a hole's boundary (the grid starts at the polygon's own
 * minimum x/z) therefore land a fraction of a micron outside the float32-rounded triangle and fail
 * an exact test, which is what a first run of this file did: 64 of 846 probes, all of them on the
 * boundary row/column. 1mm is four orders of magnitude above that quantization and four orders
 * BELOW anything that could be seen as a gap in a rendered building, so it separates the two
 * cleanly rather than papering over either.
 */
const GEOMETRY_TOLERANCE_M = 1e-3

function loadPlan(): FloorPlan {
  return JSON.parse(readFileSync(FLOOR_PLAN_PATH, 'utf-8')) as FloorPlan
}

/** Standard ray-casting point-in-polygon, in the floor plan's own (x, z) meters. */
function pointInPolygon(px: number, pz: number, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]
    const [xj, zj] = polygon[j]
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Distance from a point to a finite 2D segment, in floor-plan meters. */
function pointSegmentDistance2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

/**
 * Barycentric point-in-triangle, falling back to a METRIC test (is the probe within
 * GEOMETRY_TOLERANCE_M of the triangle's boundary?) when the barycentric coordinates come out
 * marginally negative. The metric fallback is what makes the tolerance mean "1mm", independent of
 * how large or thin the triangle happens to be -- a raw barycentric epsilon means completely
 * different distances on an 11m cap triangle versus a 0.2m one.
 */
function pointInTriangle(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): boolean {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
  if (Math.abs(d) < 1e-12) return false // degenerate triangle (e.g. a vertical side face seen edge-on in XZ)
  const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d
  const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d
  const l3 = 1 - l1 - l2
  if (l1 >= 0 && l2 >= 0 && l3 >= 0) return true

  return (
    Math.min(
      pointSegmentDistance2D(px, pz, ax, az, bx, bz),
      pointSegmentDistance2D(px, pz, bx, bz, cx, cz),
      pointSegmentDistance2D(px, pz, cx, cz, ax, az),
    ) <= GEOMETRY_TOLERANCE_M
  )
}

/** One triangle of a geometry, already projected onto the XZ plane. */
interface XZTriangle {
  ax: number
  az: number
  bx: number
  bz: number
  cx: number
  cz: number
}

/**
 * Reads a geometry's triangles, applies `matrix` (the mesh's own transform, so what is measured is
 * what would actually be rendered, not the untransformed geometry), and returns them projected onto
 * the XZ plane along with the world-space Y range spanned.
 */
function projectTrianglesToXZ(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): { triangles: XZTriangle[]; minY: number; maxY: number } {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count

  const world: THREE.Vector3[] = []
  for (let i = 0; i < position.count; i++) {
    world.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix))
  }

  const triangles: XZTriangle[] = []
  let minY = Infinity
  let maxY = -Infinity
  for (const v of world) {
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  for (let i = 0; i < count; i += 3) {
    const a = world[index ? index.getX(i) : i]
    const b = world[index ? index.getX(i + 1) : i + 1]
    const c = world[index ? index.getX(i + 2) : i + 2]
    triangles.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, cx: c.x, cz: c.z })
  }
  return { triangles, minY, maxY }
}

function coveredByAnyTriangle(px: number, pz: number, triangles: XZTriangle[]): boolean {
  for (const t of triangles) {
    if (pointInTriangle(px, pz, t.ax, t.az, t.bx, t.bz, t.cx, t.cz)) return true
  }
  return false
}

/**
 * Strictly-inside variant, with no boundary tolerance at all. Used for the "the hole really IS a
 * void in the floor slab" half of the proof: there, tolerance would work the wrong way round --
 * probes sampled on the hole's own boundary sit within a millimeter of the floor slab's cut edge by
 * construction, so a tolerant test would report the void as covered and the assertion would be
 * measuring the tolerance rather than the geometry.
 */
function strictlyInsideAnyTriangle(px: number, pz: number, triangles: XZTriangle[]): boolean {
  for (const t of triangles) {
    const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz)
    if (Math.abs(d) < 1e-12) continue
    const l1 = ((t.bz - t.cz) * (px - t.cx) + (t.cx - t.bx) * (pz - t.cz)) / d
    const l2 = ((t.cz - t.az) * (px - t.cx) + (t.ax - t.cx) * (pz - t.cz)) / d
    const l3 = 1 - l1 - l2
    if (l1 > 0 && l2 > 0 && l3 > 0) return true
  }
  return false
}

/** Exactly Floor.tsx's and Cores.tsx's shared authoring step: floor-plan (x, z) -> local shape XY. */
function toShapePoint([x, z]: Point2D): THREE.Vector2 {
  return new THREE.Vector2(x, -z)
}

/**
 * Rebuilds Cores.tsx's <Core> geometry AND its mesh transform. Both are duplicated here rather than
 * imported because <Core> is a React component that cannot be constructed outside a renderer; the
 * numbers it depends on (the height, via coreHeightForWalls) ARE imported, and the constants it
 * keeps private are pinned separately by testCoreConstantsMatchComponentBehaviour below.
 */
function buildCoreMesh(hole: FloorPlanHole, height: number): { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const shape = new THREE.Shape(hole.polygon.map(toShapePoint))
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height + EXPECTED_CORE_BASE_SINK_M,
    bevelEnabled: false,
  })
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, -EXPECTED_CORE_BASE_SINK_M, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  )
  return { geometry, matrix }
}

/** Rebuilds Floor.tsx's slab geometry and mesh transform, holes and all. */
function buildFloorMesh(plan: FloorPlan): { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const shape = new THREE.Shape(plan.walkableOutline.map(toShapePoint))
  for (const hole of plan.holes) {
    shape.holes.push(new THREE.Path(hole.polygon.map(toShapePoint)))
  }
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.005, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  )
  return { geometry: new THREE.ShapeGeometry(shape), matrix }
}

/** Every grid point strictly inside a hole polygon, at SAMPLE_SPACING_M resolution. */
function samplePointsInside(polygon: Point2D[]): Point2D[] {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }

  const points: Point2D[] = []
  for (let x = minX; x <= maxX; x += SAMPLE_SPACING_M) {
    for (let z = minZ; z <= maxZ; z += SAMPLE_SPACING_M) {
      if (pointInPolygon(x, z, polygon)) points.push([x, z])
    }
  }
  return points
}

/* ------------------------------------------------------------------ Defect 1: solid cores ----- */

function testCoreVolumesCoverEveryHoleAndDoNotSpillOutside(): void {
  const plan = loadPlan()
  const height = coreHeightForWalls(plan.walls)
  const floor = buildFloorMesh(plan)
  const floorProjection = projectTrianglesToXZ(floor.geometry, floor.matrix)

  assert.ok(plan.holes.length > 0, 'expected floor-14.json to have at least one hole to fill')

  for (const hole of plan.holes) {
    const { geometry, matrix } = buildCoreMesh(hole, height)
    const { triangles, minY, maxY } = projectTrianglesToXZ(geometry, matrix)

    const samples = samplePointsInside(hole.polygon)
    assert.ok(samples.length > 100, `expected a dense sample grid inside "${hole.name}", got ${samples.length}`)

    // The floor-void half of the proof deliberately ignores probes sitting ON the hole boundary
    // (the sample grid starts at the polygon's own min x/z, so a whole row and column of them do).
    // The floor slab's cut edge runs exactly along that boundary and float32 rounding puts it a
    // fraction of a micron either side, so those probes say nothing about whether a void exists --
    // they only measure rounding. Probes more than GEOMETRY_TOLERANCE_M inside the hole are the
    // ones that can actually distinguish "the slab was cut" from "it was not", so the void
    // assertion is made against those, and the count is reported rather than hidden.
    const interiorSamples = samples.filter(
      ([x, z]) =>
        Math.min(
          ...hole.polygon.map(([hx, hz], k) =>
            pointSegmentDistance2D(
              x,
              z,
              hx,
              hz,
              hole.polygon[(k + 1) % hole.polygon.length][0],
              hole.polygon[(k + 1) % hole.polygon.length][1],
            ),
          ),
        ) > GEOMETRY_TOLERANCE_M,
    )

    let coveredByCore = 0
    for (const [x, z] of samples) {
      if (coveredByAnyTriangle(x, z, triangles)) coveredByCore++
    }
    let coveredByFloor = 0
    for (const [x, z] of interiorSamples) {
      if (strictlyInsideAnyTriangle(x, z, floorProjection.triangles)) coveredByFloor++
    }

    assert.equal(
      coveredByCore,
      samples.length,
      `every point inside "${hole.name}" must be covered by the core volume's XZ footprint; ${samples.length - coveredByCore} of ${samples.length} were not`,
    )
    assert.ok(interiorSamples.length > 100, `expected a dense strictly-interior sample set for "${hole.name}", got ${interiorSamples.length}`)
    assert.equal(
      coveredByFloor,
      0,
      `"${hole.name}" must still be a genuine void in the floor slab (that is what the core is filling); ${coveredByFloor} of ${interiorSamples.length} strictly-interior sample points were covered by floor triangles`,
    )

    // The block fills the opening; it must not creep out over the surrounding carpet, which is what
    // a bevel (or any inflated footprint) would do.
    let outside = 0
    for (const t of triangles) {
      for (const [px, pz] of [
        [t.ax, t.az],
        [t.bx, t.bz],
        [t.cx, t.cz],
      ]) {
        // Every vertex of an un-bevelled extrusion sits ON the hole boundary, so pointInPolygon
        // alone is the wrong test (it treats the boundary as outside, and float32 rounding puts
        // vertices a fraction of a micron either side of it). Accept anything within
        // GEOMETRY_TOLERANCE_M of the polygon's own edges; only a genuinely displaced vertex, e.g.
        // from a bevel inflating the footprint over the surrounding carpet, can fail this.
        const onBoundary = hole.polygon.some(
          ([hx, hz], k) =>
            pointSegmentDistance2D(
              px,
              pz,
              hx,
              hz,
              hole.polygon[(k + 1) % hole.polygon.length][0],
              hole.polygon[(k + 1) % hole.polygon.length][1],
            ) <= GEOMETRY_TOLERANCE_M,
        )
        if (!onBoundary && !pointInPolygon(px, pz, hole.polygon)) outside++
      }
    }
    assert.equal(outside, 0, `"${hole.name}" core has ${outside} vertices outside its own hole polygon`)

    // Vertically: sunk just under the slab, topping out at the core height.
    assert.ok(
      Math.abs(minY - -EXPECTED_CORE_BASE_SINK_M) < 1e-6,
      `"${hole.name}" core base should sit at y=${-EXPECTED_CORE_BASE_SINK_M}, got ${minY}`,
    )
    assert.ok(Math.abs(maxY - height) < 1e-6, `"${hole.name}" core top should sit at y=${height}, got ${maxY}`)

    console.log(
      `PASS: "${hole.name}" -- ${coveredByCore}/${samples.length} interior sample points covered by the core volume, ` +
        `0/${interiorSamples.length} strictly-interior points covered by the floor slab, 0 core vertices outside the ` +
        `hole polygon, y span ${minY.toFixed(3)}m to ${maxY.toFixed(3)}m`,
    )
  }
}

function testCoreHeightIsDerivedFromThePlansOwnTallestWall(): void {
  const plan = loadPlan()
  const tallest = tallestWallHeight(plan.walls)
  assert.equal(
    coreHeightForWalls(plan.walls),
    tallest + EXPECTED_CORE_HEIGHT_ABOVE_TALLEST_WALL_M,
    'core height should be the plan tallest wall plus the documented step',
  )

  // Generic, not tuned to floor-14.json: halving every wall height must halve what the core tops
  // out at (modulo the fixed step), which a hardcoded 2.7 would not do.
  const halved = plan.walls.map((w) => ({ ...w, height: w.height / 2 }))
  assert.equal(coreHeightForWalls(halved), tallest / 2 + EXPECTED_CORE_HEIGHT_ABOVE_TALLEST_WALL_M)

  // Degenerate plan: never extrude to zero depth, which would restore the see-through void.
  assert.ok(coreHeightForWalls([]) > 0, 'a wall-less plan must still get a positive core height')

  console.log(
    `PASS: core height ${coreHeightForWalls(plan.walls).toFixed(2)}m is derived from the plan tallest wall ` +
      `(${tallest}m) plus ${EXPECTED_CORE_HEIGHT_ABOVE_TALLEST_WALL_M}m, and tracks it when the plan changes`,
  )
}

/* -------------------------------------------------- Defect 2: wall thickness hierarchy -------- */

function testWallClassificationIsDataDrivenAndCoversEveryWall(): void {
  const plan = loadPlan()
  const tallest = tallestWallHeight(plan.walls)
  const signedArea = polygonSignedArea(plan.walkableOutline)

  const counts: Record<string, number> = {}
  for (const wall of plan.walls) {
    const { wallClass } = computeWallPlacement(wall, plan.walkableOutline, tallest, signedArea)
    counts[wallClass] = (counts[wallClass] ?? 0) + 1
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  assert.equal(total, plan.walls.length, 'every wall must land in exactly one class')

  // Each class must actually occur, or the hierarchy would be invisible on this plan.
  for (const wallClass of ['exterior', 'glass', 'structural', 'partition'] as const) {
    assert.ok((counts[wallClass] ?? 0) > 0, `expected at least one ${wallClass} wall in floor-14.json, got ${counts[wallClass] ?? 0}`)
  }

  // Glass is classified before exterior on purpose: a glazed panel stays a pane even on the
  // envelope. Assert that directly, since it is the one ordering decision that is easy to "clean
  // up" into a bug.
  const glassOnOutline = plan.walls.filter(
    (w) => w.glass && findOutlineEdgeIndex(w, plan.walkableOutline) >= 0,
  )
  assert.ok(glassOnOutline.length > 0, 'expected floor-14.json to contain a glass wall on the outline to exercise the ordering')
  for (const wall of glassOnOutline) {
    const { wallClass, thickness } = computeWallPlacement(wall, plan.walkableOutline, tallest, signedArea)
    assert.equal(wallClass, 'glass', 'a glass wall on the outline must stay a pane, not become a 0.30m envelope block')
    assert.equal(thickness, WALL_THICKNESS_M.glass)
  }

  console.log(
    `PASS: ${total} walls classified as ${JSON.stringify(counts)}; ${glassOnOutline.length} glass wall(s) on the outline stayed panes`,
  )
}

function testThicknessHierarchyIsStrictlyOrdered(): void {
  assert.ok(
    WALL_THICKNESS_M.exterior > WALL_THICKNESS_M.structural,
    'the building envelope must be thicker than an interior full-height wall, or there is no hierarchy to see',
  )
  assert.ok(
    WALL_THICKNESS_M.structural > WALL_THICKNESS_M.partition,
    'a full-height interior wall must be thicker than a short partition',
  )
  assert.ok(WALL_THICKNESS_M.partition > WALL_THICKNESS_M.glass, 'a glazed pane should be the thinnest element')
  assert.equal(
    WALL_THICKNESS_M.structural,
    LEGACY_WALL_THICKNESS_M,
    'interior full-height walls should stay at the previously-reviewed uniform thickness',
  )
  console.log(
    `PASS: thickness hierarchy exterior ${WALL_THICKNESS_M.exterior}m > structural ${WALL_THICKNESS_M.structural}m > ` +
      `partition ${WALL_THICKNESS_M.partition}m > glass ${WALL_THICKNESS_M.glass}m`,
  )
}

/**
 * The floating-ledge check. An envelope wall sits ON the outline while the floor slab STOPS at the
 * outline, so half its thickness hangs past the slab edge with nothing underneath. This asserts the
 * inset actually neutralises the extra thickness: measured along the outline edge's outward normal,
 * every envelope wall's outer face must still sit at OUTLINE_WALL_OUTER_FACE_OVERHANG_M (the old
 * uniform wall's overhang), NOT at the new thickness/2. Without the inset the 0.30m exterior class
 * would double that overhang to 0.15m of visibly floating wall.
 */
function testOutlineWallsKeepTheLegacyOverhangDespiteBeingThicker(): void {
  const plan = loadPlan()
  const tallest = tallestWallHeight(plan.walls)
  const signedArea = polygonSignedArea(plan.walkableOutline)
  const sign = signedArea > 0 ? 1 : -1

  let checked = 0
  let worstOverhang = 0
  let worstWithoutInset = 0
  for (const wall of plan.walls) {
    const edgeIndex = findOutlineEdgeIndex(wall, plan.walkableOutline)
    if (edgeIndex < 0) continue

    const placement = computeWallPlacement(wall, plan.walkableOutline, tallest, signedArea)
    const [ax, az] = plan.walkableOutline[edgeIndex]
    const [bx, bz] = plan.walkableOutline[(edgeIndex + 1) % plan.walkableOutline.length]
    const dx = bx - ax
    const dz = bz - az
    const len = Math.hypot(dx, dz)
    // Outward normal = the negation of the inward normal computeWallPlacement uses.
    const outX = (sign * dz) / len
    const outZ = (sign * -dx) / len

    // How far the wall's centerline sits outward of the edge line, then how far its outer FACE does.
    const centerOutward = (placement.center[0] - ax) * outX + (placement.center[1] - az) * outZ
    const overhang = centerOutward + placement.thickness / 2

    // Same measurement for the un-inset midpoint, i.e. what this wall would do without the fix.
    const midOutward =
      ((wall.a[0] + wall.b[0]) / 2 - ax) * outX + ((wall.a[1] + wall.b[1]) / 2 - az) * outZ
    const overhangWithoutInset = midOutward + placement.thickness / 2

    worstOverhang = Math.max(worstOverhang, overhang)
    worstWithoutInset = Math.max(worstWithoutInset, overhangWithoutInset)
    checked++
  }

  assert.ok(checked > 0, 'expected some walls to lie along the outline')
  // The authored geometry is not perfectly collinear with the outline (walls match within
  // OUTLINE_MATCH_TOLERANCE_M), so allow that same tolerance on top of the target overhang.
  assert.ok(
    worstOverhang <= OUTLINE_WALL_OUTER_FACE_OVERHANG_M + 0.1 + 1e-9,
    `worst envelope-wall overhang past the slab edge is ${worstOverhang.toFixed(4)}m, above the legacy ${OUTLINE_WALL_OUTER_FACE_OVERHANG_M}m budget (+ authoring tolerance)`,
  )
  assert.ok(
    worstWithoutInset > worstOverhang + 1e-6,
    'the inset must actually reduce the overhang -- if it does not, it is not doing anything',
  )

  console.log(
    `PASS: ${checked} envelope walls -- worst outer-face overhang past the slab edge ${worstOverhang.toFixed(4)}m ` +
      `(would have been ${worstWithoutInset.toFixed(4)}m un-inset, i.e. the inset removes ` +
      `${(worstWithoutInset - worstOverhang).toFixed(4)}m of floating ledge)`,
  )
}

/**
 * The inset direction must point INTO the building, and must be derived from the outline's actual
 * winding rather than assumed. Checked two ways: every real envelope wall is nudged toward the
 * interior, and reversing the whole outline (flipping it from counter-clockwise to clockwise)
 * produces identical placements rather than flinging every envelope wall out of the building.
 */
function testInsetDirectionIsInwardAndWindingIndependent(): void {
  const plan = loadPlan()
  const tallest = tallestWallHeight(plan.walls)
  const outline = plan.walkableOutline
  const reversed = [...outline].reverse()

  assert.ok(
    Math.sign(polygonSignedArea(outline)) !== Math.sign(polygonSignedArea(reversed)),
    'reversing the outline should flip its winding, or this test proves nothing',
  )

  let insetWalls = 0
  for (const wall of plan.walls) {
    if (findOutlineEdgeIndex(wall, outline) < 0) continue
    const forward = computeWallPlacement(wall, outline, tallest)
    const backward = computeWallPlacement(wall, reversed, tallest)

    assert.ok(
      Math.hypot(forward.center[0] - backward.center[0], forward.center[1] - backward.center[1]) < 1e-9,
      'a wall placement must not depend on which way the outline polygon happens to be wound',
    )

    // Step from the placed center a little further inward and confirm we are inside the building.
    // Only meaningful for classes actually inset inward (thickness above the legacy value).
    if (forward.thickness > LEGACY_WALL_THICKNESS_M) {
      const midX = (wall.a[0] + wall.b[0]) / 2
      const midZ = (wall.a[1] + wall.b[1]) / 2
      const moveX = forward.center[0] - midX
      const moveZ = forward.center[1] - midZ
      const moveLen = Math.hypot(moveX, moveZ)
      assert.ok(moveLen > 1e-9, 'a thicker-than-legacy envelope wall should have been moved off its centerline')
      // A meter along the same direction from the centerline must land inside the outline.
      assert.ok(
        pointInPolygon(midX + (moveX / moveLen) * 1, midZ + (moveZ / moveLen) * 1, outline),
        'the inset direction must point into the building, not out of it',
      )
      insetWalls++
    }
  }

  assert.ok(insetWalls > 0, 'expected some envelope walls to be inset')
  console.log(
    `PASS: ${insetWalls} envelope walls inset inward (verified by point-in-polygon), and placements are identical ` +
      'for a clockwise vs counter-clockwise outline',
  )
}

function main(): void {
  testCoreVolumesCoverEveryHoleAndDoNotSpillOutside()
  testCoreHeightIsDerivedFromThePlansOwnTallestWall()
  testWallClassificationIsDataDrivenAndCoversEveryWall()
  testThicknessHierarchyIsStrictlyOrdered()
  testOutlineWallsKeepTheLegacyOverhangDespiteBeingThicker()
  testInsetDirectionIsInwardAndWindingIndependent()
  console.log('ALL PASS: floorGeometry.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
