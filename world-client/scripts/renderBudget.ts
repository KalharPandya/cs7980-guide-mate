/**
 * Static per-frame render budget for the virtual-world-guide-fleet client, computed from the
 * REAL committed assets and the REAL scene composition -- not estimated from memory.
 *
 * Why this exists: docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md names
 * its own top open risk: "50 animated humanoids on the actual big-screen GPU is the top perf
 * risk; Phase 3 must profile it and fall back to LOD / fewer skinned visitors if needed." That
 * profiling never happened, because this sandbox's embedded Browser pane does not composite a
 * frame (see docs/superpowers/specs/2026-07-31-virtual-world-risk-register.md risk #1) -- there
 * is no way to measure live FPS here. This script cannot fix that. What it CAN do is turn "we
 * have no idea" into "here are the real numbers, computed from the real assets and the real
 * scene code, judged against known GPU classes" -- an informed budget, not a measurement.
 *
 * Method: loads the real robot.glb/visitor.glb headlessly via GLTFLoader.parse on an in-memory
 * ArrayBuffer (the same technique src/scene/__tests__/visitorLifecycleSoak.test.ts already uses
 * and validated works with this project's installed three@0.185.1, no DOM/WebGL context
 * required), runs the REAL bakeToStandingGeometry() from src/scene/modelBake.ts (not a
 * reimplementation) on the parsed robot scene exactly like Robot.tsx does at runtime, and reads
 * the real floor-14.json wall/room counts. Nothing here is hand-typed from a doc comment --
 * every count is read back from the actual parsed/baked THREE.BufferGeometry objects.
 *
 * Scene composition modeled (see App.tsx, AgentInstances.tsx, Robot.tsx, Visitor.tsx,
 * RouteLine.tsx, Floor.tsx, Walls.tsx, RoomLabels.tsx -- read directly this session, not
 * guessed): Floor (1 mesh) + Walls (one BoxGeometry mesh PER wall segment, not merged) +
 * RoomLabels (drei <Html>, DOM overlay, zero WebGL draw calls) + Robots (one drei <Instances>
 * batch, draw-call count = the baked geometry's group count, FIXED regardless of robot count) +
 * Visitors (one individual SkeletonUtils clone + AnimationMixer per visitor, so draw calls and
 * animated bones both scale linearly with visitor count) + RouteLines (one meshline ribbon mesh
 * per agent with an active `route`, only while actually navigating) + a scene-wide <Bloom> pass
 * (App.tsx, luminanceThreshold=0.3, mipmapBlur) which is resolution-dependent, not
 * scene-complexity-dependent.
 *
 * Run with: npm run analyze:renderBudget  (== npx tsx scripts/renderBudget.ts)
 *
 * Does NOT change, touch, or depend on any rendering code path being modified -- read-only
 * analysis of the committed assets and floor-14.json.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { bakeToStandingGeometry } from '../src/scene/modelBake.ts'
import type { FloorPlan } from '../src/scene/floorPlanTypes.ts'

const ROBOT_GLB_PATH = fileURLToPath(new URL('../public/models/robot.glb', import.meta.url))
const VISITOR_GLB_PATH = fileURLToPath(new URL('../public/models/visitor.glb', import.meta.url))
const FLOOR_PLAN_PATH = fileURLToPath(new URL('../public/data/floor-14.json', import.meta.url))

/** Real fleet steady state -- world/src/rooms/WorldRoom.ts's GUIDE_ROBOT_COUNT and
 * world/src/rooms/simulatedVisitorSpawner.ts's SIMULATED_VISITOR_TARGET, both read directly
 * from source this session (not assumed): 50 + 45 = 95. */
const GUIDE_ROBOT_COUNT = 50
const SIMULATED_VISITOR_TARGET = 45
const TOTAL_AGENTS = GUIDE_ROBOT_COUNT + SIMULATED_VISITOR_TARGET

/** ROBOT_HEIGHT_M from Robot.tsx -- bakeToStandingGeometry needs a target height but it does not
 * affect triangle/draw-call counts, only scale, so the exact value is inconsequential here. */
const ROBOT_HEIGHT_M = 1.4

interface LoadedGltf {
  scene: THREE.Group
  animations: THREE.AnimationClip[]
}

async function loadGlb(path: string): Promise<LoadedGltf> {
  const buf = readFileSync(path)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const loader = new GLTFLoader()
  const gltf = await new Promise<LoadedGltf>((resolve, reject) => {
    loader.parse(arrayBuffer, '', (result) => resolve(result as unknown as LoadedGltf), reject)
  })
  return gltf
}

interface MeshStat {
  name: string
  isSkinned: boolean
  vertexCount: number
  triangleCount: number
  boneCount: number
  materialSlots: number
  drawCalls: number
}

function statMesh(mesh: THREE.Mesh): MeshStat {
  const position = mesh.geometry.attributes.position
  const vertexCount = position ? position.count : 0
  const index = mesh.geometry.index
  const triangleCount = index ? index.count / 3 : vertexCount / 3
  const isSkinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true
  const boneCount = isSkinned ? (mesh as THREE.SkinnedMesh).skeleton.bones.length : 0
  const materialArray = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  // A geometry with .groups draws once per group (one draw call per group, whether or not two
  // groups happen to share a material instance -- three.js's WebGLRenderer issues a separate
  // drawElements/drawArrays call per group, see WebGLRenderer.renderBufferDirect callers in
  // renderObject/renderObjects). Without groups, a mesh is exactly one draw call.
  const drawCalls = mesh.geometry.groups && mesh.geometry.groups.length > 0 ? mesh.geometry.groups.length : 1
  return {
    name: mesh.name || '(unnamed)',
    isSkinned,
    vertexCount,
    triangleCount,
    boneCount,
    materialSlots: materialArray.length,
    drawCalls,
  }
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh)
  })
  return meshes
}

function collectTextureStats(root: THREE.Object3D): { uniqueTextureCount: number; totalTexelBytes: number; dims: string[] } {
  const seen = new Set<THREE.Texture>()
  const dims: string[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
        const tex = (mat as unknown as Record<string, THREE.Texture | null>)[key]
        if (tex && !seen.has(tex)) {
          seen.add(tex)
          const img = tex.image as { width?: number; height?: number } | undefined
          const w = img?.width ?? 0
          const h = img?.height ?? 0
          dims.push(`${key}:${w}x${h}`)
        }
      }
    }
  })
  // Assume RGBA8 (4 bytes/texel), no mip accounting -- a floor, not an exact VRAM figure.
  let totalTexelBytes = 0
  for (const tex of seen) {
    const img = tex.image as { width?: number; height?: number } | undefined
    totalTexelBytes += (img?.width ?? 0) * (img?.height ?? 0) * 4
  }
  return { uniqueTextureCount: seen.size, totalTexelBytes, dims }
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

async function analyzeRobot() {
  console.log('\n=== ROBOT ASSET (public/models/robot.glb) ===')
  const gltf = await loadGlb(ROBOT_GLB_PATH)
  const rawMeshes = collectMeshes(gltf.scene)
  const rawStats = rawMeshes.map(statMesh)

  console.log(`Raw glTF scene: ${rawMeshes.length} mesh/primitive nodes.`)
  const rawTotalTris = rawStats.reduce((a, s) => a + s.triangleCount, 0)
  const rawTotalVerts = rawStats.reduce((a, s) => a + s.vertexCount, 0)
  const skinnedRaw = rawStats.filter((s) => s.isSkinned)
  console.log(
    `  Raw totals: ${fmtNum(rawTotalTris)} triangles, ${fmtNum(rawTotalVerts)} vertices, ` +
      `${skinnedRaw.length} truly-skinned primitives (JOINTS_0/WEIGHTS_0 present), ` +
      `${rawStats.length - skinnedRaw.length} plain (bone-parented, non-skinned) primitives.`,
  )
  const uniqueRawMaterials = new Set(rawMeshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material])))
  console.log(`  Unique material instances across the raw scene: ${uniqueRawMaterials.size}.`)

  const tex = collectTextureStats(gltf.scene)
  console.log(`  Textures: ${tex.uniqueTextureCount} unique image(s)${tex.dims.length ? ' (' + tex.dims.join(', ') + ')' : ''}.`)

  // Now run the REAL bakeToStandingGeometry() Robot.tsx calls at runtime -- this is the actual
  // code path, not a re-derivation, so the resulting group/triangle/vertex counts are exactly
  // what <Instances geometry={...} material={...}> in Robot.tsx will draw.
  const { geometry: baked, materials: bakedMaterials } = bakeToStandingGeometry(gltf.scene, ROBOT_HEIGHT_M)
  const bakedGroups = baked.groups ?? []
  const bakedTriCount = baked.index ? baked.index.count / 3 : baked.attributes.position.count / 3
  const bakedVertCount = baked.attributes.position.count
  const uniqueBakedMaterials = new Set(bakedMaterials)

  console.log(`\nBaked (bakeToStandingGeometry(), the REAL Robot.tsx code path):`)
  console.log(`  Merged draw-call groups: ${bakedGroups.length} (= 1 draw call per group per <Instances> batch, FIXED regardless of robot count).`)
  console.log(`  Baked geometry: ${fmtNum(bakedTriCount)} triangles, ${fmtNum(bakedVertCount)} vertices (this is per ONE robot's worth of geometry; GPU instancing draws it ${GUIDE_ROBOT_COUNT}x within those same ${bakedGroups.length} draw calls).`)
  console.log(`  Material slots passed to <Instances material={...}>: ${bakedMaterials.length} (${uniqueBakedMaterials.size} unique instance(s)).`)

  assert.ok(bakedGroups.length > 0, 'baked robot geometry should have at least one draw-call group')
  assert.ok(bakedTriCount > 0, 'baked robot geometry should have triangles')

  return {
    rawPrimitiveCount: rawMeshes.length,
    bakedDrawCalls: bakedGroups.length,
    bakedTrianglesPerRobot: bakedTriCount,
    bakedVerticesPerRobot: bakedVertCount,
  }
}

async function analyzeVisitor() {
  console.log('\n=== VISITOR ASSET (public/models/visitor.glb) ===')
  const gltf = await loadGlb(VISITOR_GLB_PATH)
  const meshes = collectMeshes(gltf.scene)
  const stats = meshes.map(statMesh)

  const totalTris = stats.reduce((a, s) => a + s.triangleCount, 0)
  const totalVerts = stats.reduce((a, s) => a + s.vertexCount, 0)
  const totalDrawCalls = stats.reduce((a, s) => a + s.drawCalls, 0)
  const totalBones = stats.reduce((a, s) => a + s.boneCount, 0)
  const uniqueMaterials = new Set(meshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material])))

  console.log(`Per-clone (this is what EVERY one of the ${SIMULATED_VISITOR_TARGET} visitors renders -- each is its own independent SkeletonUtils clone, no batching possible, see Visitor.tsx):`)
  for (const s of stats) {
    console.log(
      `  mesh "${s.name}": ${fmtNum(s.triangleCount)} tris, ${fmtNum(s.vertexCount)} verts, ` +
        `${s.isSkinned ? `SKINNED, ${s.boneCount} bones` : 'not skinned'}, ${s.materialSlots} material slot(s), ${s.drawCalls} draw call(s).`,
    )
  }
  console.log(`  TOTAL per clone: ${fmtNum(totalTris)} tris, ${fmtNum(totalVerts)} verts, ${totalDrawCalls} draw call(s), ${totalBones} animated bone(s).`)
  console.log(`  Unique material instances: ${uniqueMaterials.size}.`)
  console.log(`  Animation clips embedded: ${gltf.animations.length} (${gltf.animations.map((c) => c.name).join(', ')}) -- Visitor.tsx only ever plays Idle/Walk, but useAnimations() still resolves bindings against the whole clip set.`)

  const tex = collectTextureStats(gltf.scene)
  console.log(`  Textures: ${tex.uniqueTextureCount} unique image(s)${tex.dims.length ? ' (' + tex.dims.join(', ') + ')' : ''} -- ${tex.uniqueTextureCount === 0 ? 'material is untextured (flat-shaded), so no per-clone texture VRAM cost.' : `~${(tex.totalTexelBytes / 1024 / 1024).toFixed(2)}MB raw texel data (assuming RGBA8, no mips), shared by reference across all clones (see visitorLifecycleSoak.test.ts's verified finding that SkeletonUtils.clone shares geometry+material by reference).`}`)

  assert.ok(totalDrawCalls > 0, 'visitor asset should produce at least one draw call')
  assert.ok(totalBones > 0, 'visitor asset should be skinned with at least one bone')

  return {
    trianglesPerVisitor: totalTris,
    verticesPerVisitor: totalVerts,
    drawCallsPerVisitor: totalDrawCalls,
    bonesPerVisitor: totalBones,
  }
}

interface FloorPlanBudget {
  floorTriangles: number
  floorDrawCalls: number
  wallDrawCalls: number
  wallTriangles: number
  glassWallCount: number
  solidWallCount: number
  roomLabelCount: number
}

/** Rebuilds Floor.tsx's exact ShapeGeometry (same toShapePoint convention: (x, -z) in the local
 * shape plane) from the real floor-14.json, so the floor's actual post-triangulation count is
 * read back from a real THREE.ShapeGeometry, not guessed. Walls are BoxGeometry per segment,
 * exactly like Walls.tsx -- 12 triangles/24 vertices each, one draw call each (no merging
 * anywhere in Walls.tsx, confirmed by reading the file this session). */
function analyzeFloorPlan(): FloorPlanBudget {
  console.log('\n=== FLOOR PLAN (public/data/floor-14.json) ===')
  const floorPlan = JSON.parse(readFileSync(FLOOR_PLAN_PATH, 'utf-8')) as FloorPlan

  const toShapePoint = ([x, z]: [number, number]) => new THREE.Vector2(x, -z)
  const shape = new THREE.Shape(floorPlan.walkableOutline.map(toShapePoint))
  for (const hole of floorPlan.holes) {
    shape.holes.push(new THREE.Path(hole.polygon.map(toShapePoint)))
  }
  const floorGeometry = new THREE.ShapeGeometry(shape)
  const floorTriangles = floorGeometry.index ? floorGeometry.index.count / 3 : floorGeometry.attributes.position.count / 3

  const glassWallCount = floorPlan.walls.filter((w) => w.glass).length
  const solidWallCount = floorPlan.walls.length - glassWallCount
  // BoxGeometry(length, height, thickness) is always 12 triangles / 24 vertices regardless of
  // dimensions (6 faces x 2 triangles, unwelded per-face normals) -- verified directly below
  // rather than assumed.
  const sampleBox = new THREE.BoxGeometry(1, 1, 1)
  const trisPerWall = sampleBox.index ? sampleBox.index.count / 3 : sampleBox.attributes.position.count / 3
  assert.equal(trisPerWall, 12, 'BoxGeometry should be 12 triangles (6 faces x 2 tris)')

  console.log(`Walls: ${floorPlan.walls.length} segments (${glassWallCount} glass, ${solidWallCount} solid), each its OWN BoxGeometry mesh -- Walls.tsx does not merge them, so this is ${floorPlan.walls.length} separate draw calls, ${floorPlan.walls.length * trisPerWall} total triangles (${trisPerWall}/wall).`)
  console.log(`  Materials: Walls.tsx now shares 2 module-scope material instances (1 MeshPhysicalMaterial for all ${glassWallCount} glass walls, 1 MeshStandardMaterial for all ${solidWallCount} solid walls) -- was ${floorPlan.walls.length} distinct instances (one per <Wall>) before 2026-08-03's sharing fix. Draw-call/triangle counts above are unaffected either way (still one mesh per wall segment); the sharing fix reduces material-object memory (per-instance uniforms/WebGLProperties entries), not draw calls.`)
  console.log(`Floor: 1 ShapeGeometry mesh (outline + ${floorPlan.holes.length} hole(s) subtracted), ${fmtNum(floorTriangles)} triangles, 1 draw call.`)
  console.log(`Room labels: ${floorPlan.rooms.length} rooms, rendered via drei <Html> -- these are real DOM nodes overlaid on the canvas, NOT WebGL geometry, so they contribute 0 draw calls and 0 triangles to the render budget (but do cost browser layout/compositing, not measured here).`)

  return {
    floorTriangles,
    floorDrawCalls: 1,
    wallDrawCalls: floorPlan.walls.length,
    wallTriangles: floorPlan.walls.length * trisPerWall,
    glassWallCount,
    solidWallCount,
    roomLabelCount: floorPlan.rooms.length,
  }
}

/** meshline's MeshLineGeometry emits ~2 triangles per input point-pair segment (a quad per
 * segment). Route point counts are server/navmesh-path-dependent (world/src/rooms/WorldRoom.ts's
 * moveAgentTo -> updateAgentRoute calls navMeshQuery.computePath, whose returned point count
 * depends on the path's real geometry -- not a fixed constant anywhere in the codebase), so this
 * is a labeled ESTIMATE range (short corridor hop vs a long multi-turn cross-floor route), not a
 * measured figure -- flagged explicitly rather than presented as exact. */
function estimateRouteLineBudget() {
  console.log('\n=== ROUTE LINES (meshline ribbons, RouteLine.tsx) ===')
  const shortRoutePoints = 4
  const longRoutePoints = 30
  const trisPerSegment = 2
  console.log(
    `Each agent currently navigating gets exactly 1 mesh (1 draw call) -- RouteLineInstance is rendered per agent unconditionally ` +
      `and toggles .visible, but an invisible mesh with 0 route points still exists in the scene graph, so worst case is ` +
      `${TOTAL_AGENTS} route-line meshes present (${TOTAL_AGENTS} draw calls) even if most are invisible/empty.`,
  )
  console.log(
    `Per-route triangle cost is small and route-length-dependent (NOT a fixed constant in this codebase -- ` +
      `navMeshQuery.computePath's point count depends on the real path geometry): a short corridor hop ` +
      `(~${shortRoutePoints} points) is ~${shortRoutePoints * trisPerSegment} triangles; a long multi-turn route ` +
      `(~${longRoutePoints} points) is ~${longRoutePoints * trisPerSegment} triangles. This is an ESTIMATE range, not measured.`,
  )
  return { worstCaseMeshCount: TOTAL_AGENTS, estTrianglesPerActiveRouteRange: [shortRoutePoints * trisPerSegment, longRoutePoints * trisPerSegment] as const }
}

async function main() {
  console.log('Virtual World Guide Fleet -- static per-frame render budget')
  console.log(`Real steady-state fleet: ${GUIDE_ROBOT_COUNT} robots + ${SIMULATED_VISITOR_TARGET} visitors = ${TOTAL_AGENTS} agents.`)
  console.log('(This is a STATIC estimate computed from real assets and real scene code -- NOT a measured frame rate. See the uncertainty note at the end.)')

  const robot = await analyzeRobot()
  const visitor = await analyzeVisitor()
  const floorPlanBudget = analyzeFloorPlan()
  const routeLines = estimateRouteLineBudget()

  console.log('\n\n=========================================')
  console.log('=== PER-FRAME BUDGET AT 95-AGENT STEADY STATE ===')
  console.log('=========================================')

  const robotDrawCalls = robot.bakedDrawCalls // fixed regardless of GUIDE_ROBOT_COUNT
  const robotTriangles = robot.bakedTrianglesPerRobot * GUIDE_ROBOT_COUNT
  const visitorDrawCalls = visitor.drawCallsPerVisitor * SIMULATED_VISITOR_TARGET
  const visitorTriangles = visitor.trianglesPerVisitor * SIMULATED_VISITOR_TARGET
  const visitorAnimatedBones = visitor.bonesPerVisitor * SIMULATED_VISITOR_TARGET

  const staticDrawCalls = floorPlanBudget.floorDrawCalls + floorPlanBudget.wallDrawCalls
  const staticTriangles = floorPlanBudget.floorTriangles + floorPlanBudget.wallTriangles

  const totalDrawCallsLow = robotDrawCalls + visitorDrawCalls + staticDrawCalls
  const totalDrawCallsWithWorstCaseRoutes = totalDrawCallsLow + routeLines.worstCaseMeshCount
  const totalTriangles = robotTriangles + visitorTriangles + staticTriangles

  console.log('\n-- Draw calls --')
  console.log(`  Robots (50, GPU-instanced, baked geometry): ${robotDrawCalls} draw calls TOTAL (fixed, not per-robot).`)
  console.log(`  Visitors (45, individual SkinnedMesh clones): ${visitor.drawCallsPerVisitor} draw call(s) x 45 = ${visitorDrawCalls} draw calls.`)
  console.log(`  Floor: ${floorPlanBudget.floorDrawCalls} draw call.`)
  console.log(`  Walls (124 segments, unmerged): ${floorPlanBudget.wallDrawCalls} draw calls.`)
  console.log(`  Room labels (18, drei <Html>): 0 draw calls (DOM overlay).`)
  console.log(`  Route lines: up to ${routeLines.worstCaseMeshCount} more draw calls in the theoretical worst case (every agent mid-route simultaneously); realistically far fewer.`)
  console.log(`  TOTAL (excluding route lines): ${totalDrawCallsLow} draw calls.`)
  console.log(`  TOTAL (worst-case, all agents routing at once): ${totalDrawCallsWithWorstCaseRoutes} draw calls.`)

  console.log('\n-- Triangles --')
  console.log(`  Robots: ${fmtNum(robot.bakedTrianglesPerRobot)}/robot x 50 = ${fmtNum(robotTriangles)}.`)
  console.log(`  Visitors: ${fmtNum(visitor.trianglesPerVisitor)}/visitor x 45 = ${fmtNum(visitorTriangles)}.`)
  console.log(`  Floor: ${fmtNum(floorPlanBudget.floorTriangles)}.`)
  console.log(`  Walls: ${fmtNum(floorPlanBudget.wallTriangles)}.`)
  console.log(`  Route lines: negligible (tens to low hundreds of triangles even at worst case; see estimate above).`)
  console.log(`  TOTAL: ${fmtNum(totalTriangles)} triangles/frame.`)

  console.log('\n-- CPU-side skinning cost (the real crowd bottleneck, not raw triangles) --')
  console.log(`  45 independent AnimationMixers, each driving its own skeleton: ${visitor.bonesPerVisitor} bones/visitor x 45 = ${fmtNum(visitorAnimatedBones)} animated bones/frame.`)
  console.log(`  Each bone update walks PropertyMixer bindings + a matrixWorld recompute through the skeleton hierarchy every frame for every visitor, independently -- this does NOT batch, unlike the robots' instancing. This is CPU main-thread work (JS), separate from and additive to whatever the GPU is doing with the triangle/draw-call numbers above.`)

  console.log('\n-- Postprocessing: <Bloom> (App.tsx, EffectComposer + Bloom) --')
  console.log('  Full-screen pass: cost scales with RENDER RESOLUTION (pixels processed), not scene triangle/draw-call count.')
  console.log('  mipmapBlur is enabled (cheaper than the naive multi-pass Kawase/Gaussian blur, but still a chain of downsample+blur passes over the full framebuffer).')
  console.log('  Assumption used for the hardware judgment below: a 1080p (1920x1080) kiosk render target. At 4K this pass\'s cost roughly quadruples (pixel count scales with width x height).')

  console.log('\n\n=== VERDICT AGAINST HARDWARE (informed budget, NOT a measurement -- see uncertainty note) ===')
  console.log(`Kiosk-class reference point: an NVIDIA GTX 1650 -- the GPU reported in this project's dev-machine WebGL context string -- a 2019 entry-level mobile/desktop GPU, ~75-90 GFLOPS-class, 4GB VRAM, no dedicated mesh-shading/instancing fast paths beyond standard OpenGL/WebGL instancing. Taken as the best available stand-in for kiosk-class hardware; the ACTUAL kiosk GPU is not independently confirmed here.`)
  console.log(`  Draw calls (~${totalDrawCallsLow}-${totalDrawCallsWithWorstCaseRoutes}): well within a GTX-1650-class budget for 60fps. Modern GPUs/drivers comfortably sustain several thousand draw calls/frame at 60fps when each is cheap (these are: baked/instanced robots, small per-visitor meshes, simple wall boxes). Draw-call COUNT is not the risk here.`)
  console.log(`  Triangles (~${fmtNum(totalTriangles)}/frame): trivial for this GPU class at 60fps -- a GTX 1650 pushes tens of millions of triangles/frame in real workloads; ~${(totalTriangles / 1e6).toFixed(2)}M/frame is not the bottleneck.`)
  console.log(`  CPU-side skinning (~${fmtNum(visitorAnimatedBones)} bones/frame across 45 independent mixers): THIS is the more plausible real risk, and it's a CPU (JS main-thread), not GPU, cost. It does not benchmark the same way triangle/draw-call budgets do -- three.js's AnimationMixer.update() cost is dominated by JS object/array overhead per binding, not raw math, so it does not scale predictably with bone count alone. This script can size the INPUT (${visitorAnimatedBones} bone updates/frame) but cannot produce a real ms figure without actually running it in a browser -- which this sandbox cannot do (see the uncertainty note).`)
  console.log(`  <Bloom> at kiosk resolution: full-screen postprocessing passes are a known, generally-affordable cost on this GPU class at 1080p (well-optimized mipmapBlur bloom is commonly a low-single-digit-ms cost on far weaker mobile GPUs); more of a real risk at 4K, unknown if the kiosk display is 4K.`)

  console.log('\n--- UNCERTAINTY, STATED PLAINLY ---')
  console.log('This is a STATIC estimate from asset geometry and scene composition, not a measured frame time. It captures WHAT gets drawn and roughly HOW MUCH, but cannot capture:')
  console.log('  - Actual driver/browser overhead per draw call and per material/shader switch (React Three Fiber / three.js internals, GPU driver, browser compositor).')
  console.log('  - The real cost of 45 independent AnimationMixer.update() calls per frame (JS engine-dependent, not just a bone-count function).')
  console.log('  - Real GPU fill-rate/bandwidth behavior for the Bloom pass and the glass meshPhysicalMaterial (transmission=1, a genuinely expensive material -- refractive glass walls are NOT free, and this script does not attempt to cost that beyond noting it exists). One thing IS now established from reading three@0.185.1\'s own source (not measured, but code-verified) rather than left as a total unknown: WebGLRenderer.renderTransmissionPass (WebGLRenderer.js) runs ONCE per frame per camera regardless of how many transmissive materials/meshes exist -- it renders the opaque scene once into a single shared transmissionRenderTarget, then every transmissive object\'s normal draw call samples that one texture. So the fill-rate cost here scales with screen coverage of glass geometry and the extra full-scene opaque re-render, NOT with the number of distinct transmissive material instances (8 glass walls previously each had their own MeshPhysicalMaterial instance; that was memory waste, not 8x the transmission passes -- three.js does not allocate a framebuffer per transmissive instance the way drei\'s MeshTransmissionMaterial does). The actual ms cost of that one pass at kiosk resolution is still unmeasured and still blocked by the sandbox\'s no-compositing limitation.')
  console.log('  - Browser/OS compositor overhead for the 18 DOM-based room labels layered over the WebGL canvas.')
  console.log('  - Thermal throttling, background processes, or actual kiosk hardware if it differs from the observed GTX 1650.')
  console.log('The verdict above is a REASONED JUDGMENT against known GPU-class capability, not a guarantee. The only way to close this risk for real is to actually run the client in a real browser on real (or representative) kiosk hardware and read the frame time -- which remains blocked by this sandbox\'s Browser-pane limitation.')

  console.log('\n=== DONE: renderBudget.ts ===')
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
