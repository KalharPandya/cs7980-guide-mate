/**
 * Pins the design-spec requirement (docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md,
 * "Glass walls: one shared MeshPhysicalMaterial transmission pass") that Walls.tsx shares ONE
 * material instance across every glass wall and ONE across every solid wall, instead of
 * instantiating a fresh material per <Wall>. floor-14.json has 124 wall segments (8 glass, 116
 * solid) today; before this fix that was 124 distinct material objects (8 MeshPhysicalMaterial,
 * each with transmission=1, plus 116 MeshStandardMaterial) where 2 would do.
 *
 * This environment cannot render R3F/WebGL (see the risk register's documented #1 limitation:
 * the embedded Browser pane never composites a frame), so "one shared instance" can't be pinned
 * by rendering the scene and counting materials on meshes. Instead this test pins it two ways
 * that don't require rendering:
 *
 *   1. Import GLASS_MATERIAL/SOLID_MATERIAL directly (module-scope exports -- constructing them
 *      is plain JS, no WebGL context needed) and assert their parameters exactly match the
 *      values the removed inline JSX materials used to declare. A future edit that changes a
 *      parameter (even matching it between the two materials) fails this.
 *   2. Read Walls.tsx's own source text and assert, structurally:
 *        - each material class is constructed with `new THREE....Material(` exactly ONCE in the
 *          whole file (module scope) -- catches a future edit moving construction back inside
 *          the Wall() function body or a per-wall useMemo, which would silently reintroduce
 *          per-instance materials without changing GLASS_MATERIAL/SOLID_MATERIAL's own values.
 *        - the <mesh> element assigns material via the `material={...}` PROP, not as a JSX
 *          child (no `<meshPhysicalMaterial` / `<meshStandardMaterial` JSX element anywhere in
 *          the file). This is the R3F lifecycle trap: a material declared as a JSX child is
 *          owned and disposed by R3F's reconciler when its mesh unmounts (removeChild disposes
 *          child.object for objects that exist as fiber-tree children); an object merely
 *          assigned via an instance prop like `material={x}` is never entered into the fiber
 *          tree and so is never a disposal target. If materials-as-JSX-children ever comes
 *          back, the shared instance would be destroyed the first time any one wall unmounts,
 *          breaking every other wall silently -- this assertion catches that class of edit
 *          directly, since no render/unmount cycle is needed to know the risk is present.
 *
 * Plain node:assert script, run with tsx -- matches this package's test convention.
 * Run with: npx tsx src/scene/__tests__/wallMaterials.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as THREE from 'three'

import { GLASS_MATERIAL, SOLID_MATERIAL } from '../Walls'
import type { FloorPlan } from '../floorPlanTypes'

const FLOOR_PLAN_PATH = fileURLToPath(new URL('../../../public/data/floor-14.json', import.meta.url))
const WALLS_SOURCE_PATH = fileURLToPath(new URL('../Walls.tsx', import.meta.url))

// Documented values, copied from the inline JSX materials this change replaced (git history /
// the task's own diff), not re-derived from Walls.tsx's GLASS_COLOR/SOLID_WALL_COLOR constants --
// re-importing those would not catch a future edit that changes the constant AND the material
// together, which is exactly the kind of silent drift this test exists to catch.
const EXPECTED_GLASS_COLOR_HEX = 0xcfe8ff
const EXPECTED_GLASS_TRANSMISSION = 1
const EXPECTED_GLASS_ROUGHNESS = 0.1
const EXPECTED_GLASS_THICKNESS = 0.05
const EXPECTED_GLASS_IOR = 1.5

const EXPECTED_SOLID_COLOR_HEX = 0xd8d3c8
const EXPECTED_SOLID_ROUGHNESS = 0.85

function loadPlan(): FloorPlan {
  const raw = readFileSync(FLOOR_PLAN_PATH, 'utf-8')
  return JSON.parse(raw) as FloorPlan
}

function testGlassMaterialIsSharedAndMatchesDocumentedValues(): void {
  assert.ok(GLASS_MATERIAL instanceof THREE.MeshPhysicalMaterial, 'GLASS_MATERIAL should be a MeshPhysicalMaterial')
  assert.equal(GLASS_MATERIAL.color.getHex(), EXPECTED_GLASS_COLOR_HEX, 'GLASS_MATERIAL.color should match the documented glass color')
  assert.equal(GLASS_MATERIAL.transmission, EXPECTED_GLASS_TRANSMISSION, 'GLASS_MATERIAL.transmission should be 1 (unchanged)')
  assert.equal(GLASS_MATERIAL.roughness, EXPECTED_GLASS_ROUGHNESS, 'GLASS_MATERIAL.roughness should match the documented value')
  assert.equal(GLASS_MATERIAL.thickness, EXPECTED_GLASS_THICKNESS, 'GLASS_MATERIAL.thickness should match the documented value')
  assert.equal(GLASS_MATERIAL.ior, EXPECTED_GLASS_IOR, 'GLASS_MATERIAL.ior should match the documented value')
  assert.equal(GLASS_MATERIAL.transparent, true, 'GLASS_MATERIAL.transparent should remain true')
  console.log('PASS: GLASS_MATERIAL is a MeshPhysicalMaterial whose parameters match the documented (previously inline) values')
}

function testSolidMaterialIsSharedAndMatchesDocumentedValues(): void {
  assert.ok(SOLID_MATERIAL instanceof THREE.MeshStandardMaterial, 'SOLID_MATERIAL should be a MeshStandardMaterial')
  assert.equal(SOLID_MATERIAL.color.getHex(), EXPECTED_SOLID_COLOR_HEX, 'SOLID_MATERIAL.color should match the documented solid-wall color')
  assert.equal(SOLID_MATERIAL.roughness, EXPECTED_SOLID_ROUGHNESS, 'SOLID_MATERIAL.roughness should match the documented value')
  console.log('PASS: SOLID_MATERIAL is a MeshStandardMaterial whose parameters match the documented (previously inline) values')
}

function testGlassAndSolidMaterialsAreDistinctInstances(): void {
  assert.notEqual(GLASS_MATERIAL as unknown, SOLID_MATERIAL as unknown, 'glass and solid materials must not be the same instance as each other')
  console.log('PASS: GLASS_MATERIAL and SOLID_MATERIAL are distinct instances of each other')
}

function testFloorPlanHasBothGlassAndSolidWallsToShareAcross(): void {
  const plan = loadPlan()
  const glass = plan.walls.filter((w) => w.glass)
  const solid = plan.walls.filter((w) => !w.glass)
  assert.ok(glass.length > 1, `expected more than one glass wall to exercise sharing, found ${glass.length}`)
  assert.ok(solid.length > 1, `expected more than one solid wall to exercise sharing, found ${solid.length}`)
  assert.equal(glass.length + solid.length, plan.walls.length, 'every wall should be classified as glass xor solid')
  console.log(
    `PASS: floor-14.json has ${glass.length} glass wall(s) and ${solid.length} solid wall(s) -- both counts ` +
      '> 1, so sharing actually matters here (not a degenerate single-wall map)',
  )
}

/**
 * Structural pin, since rendering isn't possible in this environment. See file doc comment for
 * why source-text assertions are the right substitute here.
 */
function testWallsSourceConstructsEachMaterialExactlyOnceAtModuleScope(): void {
  const source = readFileSync(WALLS_SOURCE_PATH, 'utf-8')

  const glassConstructions = source.match(/new THREE\.MeshPhysicalMaterial\(/g) ?? []
  const solidConstructions = source.match(/new THREE\.MeshStandardMaterial\(/g) ?? []
  assert.equal(glassConstructions.length, 1, `expected exactly one MeshPhysicalMaterial construction in Walls.tsx, found ${glassConstructions.length}`)
  assert.equal(solidConstructions.length, 1, `expected exactly one MeshStandardMaterial construction in Walls.tsx, found ${solidConstructions.length}`)

  // Both constructions must appear before the Wall() function body starts -- i.e. at module
  // scope, not per-instance inside the component (which would defeat sharing even with only
  // "one call site" textually, e.g. if that call site were inside useMemo(() => new ...)).
  const wallFunctionIndex = source.indexOf('function Wall(')
  assert.ok(wallFunctionIndex > 0, 'expected to find "function Wall(" in Walls.tsx')
  const glassIndex = source.indexOf('new THREE.MeshPhysicalMaterial(')
  const solidIndex = source.indexOf('new THREE.MeshStandardMaterial(')
  assert.ok(glassIndex < wallFunctionIndex, 'MeshPhysicalMaterial must be constructed at module scope, before function Wall(')
  assert.ok(solidIndex < wallFunctionIndex, 'MeshStandardMaterial must be constructed at module scope, before function Wall(')

  console.log('PASS: Walls.tsx constructs each shared material exactly once, at module scope (not per-wall)')
}

/**
 * Pins the R3F disposal-ownership trap fix: the shared materials must reach <mesh> via the
 * `material` prop, never as a JSX child element, or R3F's reconciler will dispose the shared
 * instance on the first wall unmount and silently blank every other wall's material.
 */
function testMeshAssignsSharedMaterialViaPropNotJsxChild(): void {
  const source = readFileSync(WALLS_SOURCE_PATH, 'utf-8')

  assert.ok(
    !/<meshPhysicalMaterial\b/.test(source),
    '<meshPhysicalMaterial as a JSX child would be owned/disposed by R3F per-mesh -- must not appear in Walls.tsx',
  )
  assert.ok(
    !/<meshStandardMaterial\b/.test(source),
    '<meshStandardMaterial as a JSX child would be owned/disposed by R3F per-mesh -- must not appear in Walls.tsx',
  )
  assert.ok(
    /material=\{wall\.glass\s*\?\s*GLASS_MATERIAL\s*:\s*SOLID_MATERIAL\}/.test(source),
    'expected <mesh> to assign the shared material via a `material={...}` prop ternary on wall.glass',
  )

  console.log('PASS: Walls.tsx assigns the shared material via the `material` prop (not a disposable JSX child)')
}

function main(): void {
  testGlassMaterialIsSharedAndMatchesDocumentedValues()
  testSolidMaterialIsSharedAndMatchesDocumentedValues()
  testGlassAndSolidMaterialsAreDistinctInstances()
  testFloorPlanHasBothGlassAndSolidWallsToShareAcross()
  testWallsSourceConstructsEachMaterialExactlyOnceAtModuleScope()
  testMeshAssignsSharedMaterialViaPropNotJsxChild()
  console.log('ALL PASS: wallMaterials.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
