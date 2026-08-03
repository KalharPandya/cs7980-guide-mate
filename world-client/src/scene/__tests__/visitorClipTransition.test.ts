/**
 * Regression test for the visitor-spawn pose-swing bug (see Visitor.tsx's
 * shouldCrossfadeClipSwitch doc comment): on a visitor's first animation activation there is no
 * previous clip to crossfade against, so three.js's PropertyMixer blends the fading-in clip
 * against the scene graph's untouched REST POSE instead. visitor.glb's rest-pose Hips carries a
 * spurious yaw that every clip's own Hips track normally fully overrides -- but a sub-1 weight
 * during the fadeIn ramp reintroduces it, visible as the visitor swinging into place on every
 * spawn (simulatedVisitorSpawner.ts spawns/despawns ~45 of these continuously).
 *
 * Two independent checks:
 *   1. testRestPoseHipsIsMateriallySkewed -- confirms the underlying hazard is real by parsing
 *      the actual shipped visitor.glb (no GLTFLoader/three.js needed: the GLB container is just
 *      a 12-byte header + length-prefixed chunks, and the JSON chunk holds each node's raw
 *      TRS). If the asset is ever replaced with a clean rest pose, this hazard stops mattering
 *      and this test starts failing loudly, which is the point: it keeps the "why" of the fix
 *      honest, not just the code path.
 *   2. testShouldCrossfadeClipSwitch -- pins down the pure decision Visitor.tsx's useFrame
 *      block delegates to (previousAction present -> crossfade, absent -> full weight), so a
 *      future edit that reintroduces "always fadeIn" is caught without needing to render
 *      anything (this environment cannot render -- see the risk register).
 *
 * Plain node:assert script, run with tsx -- matches this package's test convention.
 * Run with: npx tsx src/scene/__tests__/visitorClipTransition.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { shouldCrossfadeClipSwitch } from '../Visitor'

const VISITOR_GLB_PATH = fileURLToPath(new URL('../../../public/models/visitor.glb', import.meta.url))

// A true bind/T-pose rest quaternion would be at or extremely close to identity (angle ~0). The
// hazard this test documents is a ~44 degree stray yaw -- 10 degrees is comfortably below that
// while still well above any legitimate floating-point-noise identity quaternion.
const MIN_HAZARD_ANGLE_DEG = 10

interface GlbNode {
  name?: string
  rotation?: [number, number, number, number]
}

/**
 * Minimal GLB container parser: magic(4) + version(4) + length(4) header, then a sequence of
 * length-prefixed chunks (chunkLength u32 + chunkType u32 + data). Only the JSON chunk
 * (chunkType 0x4E4F534A, ASCII "JSON") is needed here -- visitor.glb's mesh/animation binary
 * data lives in the following BIN chunk, which this test never touches.
 */
function parseGlbJsonChunk(glbPath: string): { nodes: GlbNode[] } {
  const buf = readFileSync(glbPath)
  const magic = buf.readUInt32LE(0)
  assert.equal(magic, 0x46546c67, 'visitor.glb should start with the glTF magic number')

  let offset = 12 // past the 12-byte header
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset)
    const chunkType = buf.readUInt32LE(offset + 4)
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength)
    if (chunkType === 0x4e4f534a) {
      return JSON.parse(chunkData.toString('utf8'))
    }
    offset += 8 + chunkLength
  }
  throw new Error('visitor.glb has no JSON chunk')
}

function quaternionAngleDegrees(rotation: [number, number, number, number]): number {
  const [, , , w] = rotation
  // Clamp for safety: a slightly-out-of-range w from float rounding would make acos return NaN.
  const clampedW = Math.min(1, Math.max(-1, w))
  return 2 * Math.acos(clampedW) * (180 / Math.PI)
}

function testRestPoseHipsIsMateriallySkewed(): void {
  const { nodes } = parseGlbJsonChunk(VISITOR_GLB_PATH)
  const hips = nodes.find((n) => n.name === 'Hips')
  assert.ok(hips, 'visitor.glb should have a node named "Hips"')
  assert.ok(hips.rotation, 'Hips node should carry an explicit rest-pose rotation')

  const angleDeg = quaternionAngleDegrees(hips.rotation)
  assert.ok(
    angleDeg > MIN_HAZARD_ANGLE_DEG,
    `visitor.glb's rest-pose Hips rotation should be materially non-identity (>${MIN_HAZARD_ANGLE_DEG} deg) ` +
      `-- this documents the hazard that shouldCrossfadeClipSwitch's fix guards against; got ${angleDeg.toFixed(2)} deg`,
  )
  console.log(
    `PASS: visitor.glb's rest-pose Hips carries a ${angleDeg.toFixed(2)} degree yaw skew ` +
      '(the hazard shouldCrossfadeClipSwitch guards against is real, not hypothetical)',
  )
}

function testShouldCrossfadeClipSwitch(): void {
  assert.equal(
    shouldCrossfadeClipSwitch(true),
    true,
    'a real clip-to-clip transition (previous action present) should still crossfade',
  )
  assert.equal(
    shouldCrossfadeClipSwitch(false),
    false,
    'first activation (no previous action) should NOT crossfade -- crossfading here blends against the rest pose',
  )
  console.log('PASS: shouldCrossfadeClipSwitch only crossfades when a previous action exists to fade against')
}

function main(): void {
  testRestPoseHipsIsMateriallySkewed()
  testShouldCrossfadeClipSwitch()
  console.log('ALL PASS: visitorClipTransition.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
