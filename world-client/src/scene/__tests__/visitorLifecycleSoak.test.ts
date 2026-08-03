/**
 * Client-side memory-leak soak test for the visitor animation lifecycle -- the client-side
 * counterpart to world/scripts/soaktest.ts (the server's multi-hour WorldRoom soak, which found
 * and fixed two real @colyseus/schema leaks). The client has no equivalent, and it is the piece
 * that actually runs unattended on the kiosk for hours: Visitors.tsx renders one <VisitorInstance>
 * per live agent, keyed off the live `agentIds` array, so React mounts/unmounts one of these on
 * every simulated-visitor spawn/despawn (simulatedVisitorSpawner.ts cycles ~45 of them
 * continuously -- thousands of mount/unmount pairs over a night).
 *
 * An earlier audit concluded the disposal pattern is correct, but that was STATIC READING ONLY: it
 * verified rendering is keyed off `agentIds` (so React unmounts on despawn) and that
 * SkeletonUtils.clone shares geometry/material by reference (so auto-disposal would be wrong). It
 * never measured anything. This script measures.
 *
 * ---- the honest constraint (read this before trusting the verdict) ----
 * This sandbox's browser pane does not composite frames, and R3F defers committing children until
 * it renders, so the real React tree cannot be mounted and soaked here. This script instead soaks
 * the LIBRARY-LEVEL lifecycle Visitor.tsx's VisitorInstance depends on, headlessly in Node with the
 * project's installed three@0.185.1 and @react-three/drei@10.7.7: load the real visitor.glb, do
 * exactly what VisitorInstance does per mount (SkeletonUtils.clone, create a mixer, get the real
 * Idle/Walk actions, play, advance frames, switch clips with the real crossfade logic), then do
 * exactly what @react-three/drei's useAnimations hook does on unmount (see FINDING below), and drop
 * the reference -- no extra disposal beyond what the component + drei actually run. This does NOT
 * exercise React's unmount path or R3F's scene-graph removal/useFrame unsubscription -- only the
 * three.js-level object lifecycle underneath. See the file-level comment in Visitor.tsx for why
 * that split (SkeletonUtils.clone / mixer / actions) is the correct unit here.
 *
 * ---- FINDING (measured this session, not assumed): drei's own unmount cleanup has a dead branch ----
 * @react-three/drei 10.7.7's useAnimations.js cleanup effect
 * (node_modules/@react-three/drei/core/useAnimations.js) runs, on unmount:
 *   mixer.stopAllAction();
 *   Object.values(api.actions).forEach(action => { if (currentRoot) mixer.uncacheAction(action, currentRoot) });
 * `mixer.uncacheAction(clip, optionalRoot)` (three/src/animation/AnimationMixer.js) expects its
 * first argument to be an AnimationClip (or a clip-name string) -- it looks the clip up by
 * `clip.uuid`. drei instead passes `action`, the AnimationAction instance, which three.js's
 * `existingAction()` cannot resolve (`AnimationAction` has no `.uuid`), so `uncacheAction` silently
 * finds nothing and returns having done nothing. Confirmed empirically below (see
 * `verifyDreiUncacheActionIsANoop`): calling it drei's way leaves `mixer.stats.actions.total` and
 * `.bindings.total` UNCHANGED, while calling it correctly (passing the real clip) drops both to 0.
 * This does NOT cause a leak in practice: nothing outside the unmounted VisitorInstance retains the
 * mixer once React drops its `useState` reference, so the whole mixer/actions/bindings/clone graph
 * is unreachable and collected together regardless of whether its own internal bookkeeping arrays
 * were trimmed first. It DOES mean the earlier "disposal is correct" audit was only accidentally
 * right about drei's cleanup being sufficient -- it is memory-safe because of reachability, not
 * because drei's cleanup call does what it looks like it does. Reported here as a genuine, verified
 * finding; no code changes made because the effective behavior (flat heap, see the soak numbers
 * below) is unaffected and `Object.values(api.actions)` also has a side effect worth knowing about:
 * it invokes the getter for EVERY clip name (all 8 in visitor.glb), not just Idle/Walk -- so every
 * unmount momentarily creates+immediately-abandons 6 actions nobody ever played. This soak's cycle
 * function reproduces that faithfully (see `unmountVisitor`).
 *
 * ---- what this proves if flat, and what a growth would mean ----
 * Flat retained heap across thousands of cycles = the clone/mixer/action graph really does become
 * fully unreachable on "unmount" (i.e., no closure, cache, or static registry anywhere in three.js
 * or drei's clipAction/PropertyBinding path is holding a reference), and Visitor.tsx does not need
 * an explicit `mixer.uncacheRoot(clone)` or action-stop call of its own -- confirming, with
 * measurement, the disposal-not-needed conclusion the earlier static audit only asserted. A climb
 * would point at one of: THREE.Cache (sampled below, expected to stay at 0 -- GLTFLoader.parse on
 * an in-memory ArrayBuffer never touches it), the shared gltf.scene/animations being mutated per
 * clone (checked once via reference-identity, not just trusted), or the AnimationMixer's own
 * `_actions`/`_bindings`/`_controlInterpolants` growing UNBOUNDED WITHIN a single still-alive mixer
 * -- not applicable here since a fresh mixer is created and dropped every cycle, but the classic
 * three.js trap this file's header calls out for future readers: a mixer that outlives many clip
 * switches without ever calling uncacheAction/uncacheClip/uncacheRoot accumulates one
 * PropertyMixer binding set per distinct (root, trackName) forever.
 *
 * ---- harness design ----
 * Two runs:
 *   1. REAL pattern (thousands of cycles): mirrors VisitorInstance + drei's actual (buggy-but-safe)
 *      cleanup exactly, dropping the reference afterward with no extra disposal -- the behavior
 *      under test. Sampled every SAMPLE_INTERVAL_CYCLES cycles with two forced GC passes
 *      (--expose-gc, same reasoning as soaktest.ts: V8 sometimes needs a second full collection to
 *      reclaim objects promoted to old-space) before process.memoryUsage(), so samples reflect
 *      retained memory, not just-not-yet-collected garbage. Records heapUsed/rss/external/
 *      arrayBuffers and THREE.Cache's file count.
 *   2. SANITY-CHECK LEAK pattern (fewer cycles, deliberately retains every clone+mixer in a
 *      module-level array instead of dropping it): a self-check that this harness's methodology
 *      actually has signal -- if run 1 is flat only because forced GC / sampling is somehow
 *      insensitive, run 2 proves otherwise by showing clear, asserted growth under a known-retained
 *      pattern. Without this, "flat" could mean "healthy" or "the measurement doesn't work"; this
 *      run rules out the second reading.
 *
 * Run with: npm run test:visitorSoak   (== npx tsx --expose-gc src/scene/__tests__/visitorLifecycleSoak.test.ts)
 * Configurable via env vars (both optional): SOAK_VISITOR_CYCLES, SOAK_VISITOR_SAMPLE_INTERVAL.
 *
 * Deliberately NOT wired into `npm test` (the default suite): every other file in this directory
 * runs in well under a second and asserts pure functions/data; this one loads a real 0.67MB GLB and
 * drives thousands of clone/mixer/GC cycles, taking tens of seconds. Same reasoning world/'s
 * test:soak is kept out of world/'s default `npm test`/`test:all` -- a soak is a deliberate,
 * occasionally-run regression guard, not a fast unit check that should gate every save.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

const VISITOR_GLB_PATH = fileURLToPath(new URL('../../../public/models/visitor.glb', import.meta.url))

// Same clip names Visitor.tsx actually plays -- see that file's IDLE_CLIP_NAME/WALK_CLIP_NAME.
const IDLE_CLIP_NAME = 'Human Armature|Idle'
const WALK_CLIP_NAME = 'Human Armature|Walk'
const CROSSFADE_SECONDS = 0.2

/** Simulated per-frame delta -- matches a 60fps useFrame tick closely enough for this purpose. */
const FRAME_DT_S = 1 / 60
/** "a few frames" per phase per the task brief -- enough to exercise the crossfade weight ramp
 * (CROSSFADE_SECONDS / FRAME_DT_S ~= 12 frames) without spending the whole run on mixer.update(). */
const FRAMES_PER_PHASE = 5

const REAL_CYCLES = Number(process.env.SOAK_VISITOR_CYCLES ?? 6000)
const REAL_SAMPLE_INTERVAL = Number(process.env.SOAK_VISITOR_SAMPLE_INTERVAL ?? 200)
const WARMUP_SAMPLES_EXCLUDED = 3
const MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR = 2.0

const LEAK_SANITY_CYCLES = 500
const LEAK_SANITY_SAMPLE_INTERVAL = 25
/** The sanity-check leak run must show retained heap growing by at least this factor
 * baseline-to-final, or the methodology itself (forced GC + sampling) is not sensitive enough to
 * trust run 1's "flat" verdict. */
const MIN_LEAK_SANITY_GROWTH_FACTOR = 3.0

const bytesToMb = (b: number): number => b / (1024 * 1024)

interface LoadedVisitorAsset {
  scene: THREE.Group
  animations: THREE.AnimationClip[]
}

async function loadVisitorAsset(): Promise<LoadedVisitorAsset> {
  const buf = readFileSync(VISITOR_GLB_PATH)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const loader = new GLTFLoader()
  const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
    loader.parse(arrayBuffer, '', (result) => resolve(result as unknown as { scene: THREE.Group; animations: THREE.AnimationClip[] }), reject)
  })
  return { scene: gltf.scene, animations: gltf.animations }
}

/**
 * Confirms, by direct reference-identity check against the just-loaded asset (not trusted from the
 * earlier audit's prose), that SkeletonUtils.clone shares geometry/material across clones --
 * meaning per-clone disposal of those would be wrong (they're shared, not owned) and this soak
 * correctly never disposes them.
 */
function verifyGeometryAndMaterialAreSharedByReference(asset: LoadedVisitorAsset): void {
  let sourceMesh: THREE.Mesh | null = null
  asset.scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !sourceMesh) sourceMesh = obj as THREE.Mesh
  })
  assert.ok(sourceMesh, 'visitor.glb scene should contain at least one mesh')

  const clone = cloneSkeleton(asset.scene) as THREE.Group
  let clonedMesh: THREE.Mesh | null = null
  clone.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !clonedMesh) clonedMesh = obj as THREE.Mesh
  })
  assert.ok(clonedMesh, 'cloned scene should contain at least one mesh')

  assert.equal(
    (clonedMesh as unknown as THREE.Mesh).geometry,
    (sourceMesh as unknown as THREE.Mesh).geometry,
    'SkeletonUtils.clone should share the SAME geometry instance (by reference) across clones -- ' +
      'if this ever fails, per-clone geometry.dispose() would become necessary and this soak (and Visitor.tsx) would need updating',
  )
  assert.equal(
    (clonedMesh as unknown as THREE.Mesh).material,
    (sourceMesh as unknown as THREE.Mesh).material,
    'SkeletonUtils.clone should share the SAME material instance (by reference) across clones',
  )
  assert.notEqual(
    (clonedMesh as unknown as THREE.Mesh).skeleton,
    (sourceMesh as unknown as THREE.Mesh).skeleton,
    'SkeletonUtils.clone should give each clone its OWN skeleton -- this is the whole point of using it over Object3D.clone',
  )
  console.log('VERIFIED: SkeletonUtils.clone shares geometry+material by reference and gives each clone its own skeleton (checked against the real visitor.glb this session)')
}

/**
 * Empirically confirms the FINDING in this file's header comment: drei 10.7.7's useAnimations
 * unmount cleanup calls `mixer.uncacheAction(action, root)` with an AnimationAction where
 * AnimationMixer#uncacheAction expects an AnimationClip -- so it is a silent no-op. Verified against
 * the actually-installed three@0.185.1, not assumed from reading. This does not fail the soak (see
 * header comment for why it's harmless in practice); it's printed as a finding.
 */
function verifyDreiUncacheActionIsANoop(asset: LoadedVisitorAsset): void {
  const clone = cloneSkeleton(asset.scene) as THREE.Group
  const mixer = new THREE.AnimationMixer(clone)
  const idleClip = asset.animations.find((c) => c.name === IDLE_CLIP_NAME)!
  const walkClip = asset.animations.find((c) => c.name === WALK_CLIP_NAME)!
  const idleAction = mixer.clipAction(idleClip, clone)
  const walkAction = mixer.clipAction(walkClip, clone)
  idleAction.play()
  mixer.update(FRAME_DT_S)
  walkAction.play()
  mixer.update(FRAME_DT_S)

  const stats = (mixer as unknown as { stats: { actions: { total: number }; bindings: { total: number } } }).stats
  const beforeActions = stats.actions.total
  const beforeBindings = stats.bindings.total
  assert.ok(beforeActions > 0 && beforeBindings > 0, 'sanity: mixer should have live actions/bindings before cleanup')

  // Exactly drei's cleanup call shape: uncacheAction(action, root) -- action, not clip.
  mixer.stopAllAction()
  ;[idleAction, walkAction].forEach((action) => {
    mixer.uncacheAction(action as unknown as THREE.AnimationClip, clone)
  })
  const afterDreiStyle = { actions: stats.actions.total, bindings: stats.bindings.total }

  // The call three.js's own signature actually documents (clip, not action) -- to prove
  // uncacheAction itself works correctly and the mismatch above is purely an argument-type bug.
  mixer.uncacheAction(idleClip, clone)
  mixer.uncacheAction(walkClip, clone)
  const afterCorrectCall = { actions: stats.actions.total, bindings: stats.bindings.total }

  assert.equal(
    afterDreiStyle.actions,
    beforeActions,
    "drei-style uncacheAction(action, root) should be a no-op on mixer.stats.actions.total (this is the FINDING -- if this assertion ever fails, drei's cleanup started actually clearing its caches, which is good news worth updating this comment for)",
  )
  assert.equal(afterDreiStyle.bindings, beforeBindings, 'drei-style uncacheAction(action, root) should be a no-op on mixer.stats.bindings.total')
  assert.equal(afterCorrectCall.actions, 0, 'the CORRECT call shape (clip, root) should actually clear actions')
  assert.equal(afterCorrectCall.bindings, 0, 'the CORRECT call shape (clip, root) should actually clear bindings')

  console.log(
    `VERIFIED (measured, not assumed): drei's uncacheAction(action, root) call is a no-op -- ` +
      `stats stayed actions=${afterDreiStyle.actions} bindings=${afterDreiStyle.bindings} (unchanged from ` +
      `actions=${beforeActions} bindings=${beforeBindings}); the correct (clip, root) call drops both to 0. ` +
      `Harmless here because the whole mixer is unreachable and collected regardless once React drops it -- see file header.`,
  )
}

/** Mimics drei's useAnimations getter object closely enough for this soak: a property per clip
 * name that lazily creates (and caches) the AnimationAction on first access, exactly like
 * useAnimations.js's `Object.defineProperty(actions, clip.name, { get() {...} })`. */
function buildLazyActionsLikeDrei(mixer: THREE.AnimationMixer, root: THREE.Object3D, clips: THREE.AnimationClip[]): Record<string, THREE.AnimationAction> {
  const lazy: Record<string, THREE.AnimationAction> = {}
  const actions: Record<string, THREE.AnimationAction> = {}
  for (const clip of clips) {
    Object.defineProperty(actions, clip.name, {
      enumerable: true,
      configurable: true,
      get() {
        return lazy[clip.name] || (lazy[clip.name] = mixer.clipAction(clip, root))
      },
    })
  }
  return actions
}

interface VisitorHandle {
  clone: THREE.Group
  mixer: THREE.AnimationMixer
  actions: Record<string, THREE.AnimationAction>
}

/** One VisitorInstance mount, per Visitor.tsx: SkeletonUtils.clone, mark meshes shadow-casting,
 * create the mixer + drei-style lazy actions, then play through a plausible escort lifecycle
 * (spawn idle -> walk out -> dwell idle -> walk back -> settle idle), using the exact
 * shouldCrossfadeClipSwitch decision Visitor.tsx uses for each transition. */
function mountVisitor(asset: LoadedVisitorAsset): VisitorHandle {
  const clone = cloneSkeleton(asset.scene) as THREE.Group
  clone.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })

  const mixer = new THREE.AnimationMixer(clone)
  const actions = buildLazyActionsLikeDrei(mixer, clone, asset.animations)

  let playingClipName: string | null = null
  const switchTo = (nextClipName: string) => {
    const nextAction = actions[nextClipName]
    const previousClipName = playingClipName
    const previousAction = previousClipName ? actions[previousClipName] : undefined

    const duration = nextAction.getClip().duration
    nextAction.reset()
    nextAction.time = duration > 0 ? (Math.random() * 5) % duration : 0

    const hasPreviousAction = previousAction !== undefined
    if (hasPreviousAction) {
      nextAction.fadeIn(CROSSFADE_SECONDS).play()
      previousAction.fadeOut(CROSSFADE_SECONDS)
    } else {
      nextAction.setEffectiveWeight(1).play()
    }
    playingClipName = nextClipName

    for (let i = 0; i < FRAMES_PER_PHASE; i++) mixer.update(FRAME_DT_S)
  }

  // spawn -> escort out -> dwell -> escort back -> settle, same clip sequence a real visitor
  // cycles through (simulatedVisitorSpawner.ts's spawn/escort/dwell/walk-back/despawn).
  switchTo(IDLE_CLIP_NAME)
  switchTo(WALK_CLIP_NAME)
  switchTo(IDLE_CLIP_NAME)
  switchTo(WALK_CLIP_NAME)
  switchTo(IDLE_CLIP_NAME)

  return { clone, mixer, actions }
}

/** Exactly @react-three/drei 10.7.7's useAnimations cleanup effect (see the file-header FINDING):
 * stopAllAction(), then Object.values(actions) -- which, because `actions` has a getter per clip
 * NAME (all 8 in visitor.glb, not just the 2 ever played), forces lazy creation of the 6 unused
 * ones too before immediately (attempting to, per the FINDING) uncache every one of them. */
function unmountVisitor(handle: VisitorHandle): void {
  handle.mixer.stopAllAction()
  Object.values(handle.actions).forEach((action) => {
    handle.mixer.uncacheAction(action as unknown as THREE.AnimationClip, handle.clone)
  })
}

interface Sample {
  cycle: number
  heapUsedMb: number
  rssMb: number
  externalMb: number
  arrayBuffersMb: number
  threeCacheFiles: number
}

function takeSample(cycle: number, gcAvailable: boolean): Sample {
  if (gcAvailable) {
    global.gc!()
    global.gc!()
  }
  const mem = process.memoryUsage()
  return {
    cycle,
    heapUsedMb: bytesToMb(mem.heapUsed),
    rssMb: bytesToMb(mem.rss),
    externalMb: bytesToMb(mem.external),
    arrayBuffersMb: bytesToMb(mem.arrayBuffers),
    threeCacheFiles: Object.keys((THREE.Cache as unknown as { files: Record<string, unknown> }).files ?? {}).length,
  }
}

function logHeader(): void {
  console.log(
    'cycle'.padStart(7) +
      ' | ' +
      'heapMB'.padStart(8) +
      ' | ' +
      'rssMB'.padStart(8) +
      ' | ' +
      'extMB'.padStart(7) +
      ' | ' +
      'abMB'.padStart(7) +
      ' | ' +
      'cacheFiles'.padStart(10),
  )
}

function logSample(s: Sample): void {
  console.log(
    String(s.cycle).padStart(7) +
      ' | ' +
      s.heapUsedMb.toFixed(2).padStart(8) +
      ' | ' +
      s.rssMb.toFixed(2).padStart(8) +
      ' | ' +
      s.externalMb.toFixed(2).padStart(7) +
      ' | ' +
      s.arrayBuffersMb.toFixed(2).padStart(7) +
      ' | ' +
      String(s.threeCacheFiles).padStart(10),
  )
}

function linearSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const xs = values.map((_, i) => i)
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  return den === 0 ? 0 : num / den
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function runRealSoak(asset: LoadedVisitorAsset, gcAvailable: boolean): { baselineHeapMb: number; finalHeapMb: number; growthFactor: number } {
  console.log(`\n=== RUN 1: REAL pattern (${REAL_CYCLES} mount/unmount cycles, sampling every ${REAL_SAMPLE_INTERVAL}) ===`)
  console.log('Mirrors Visitor.tsx + drei useAnimations exactly (including the no-op uncacheAction call); no extra disposal added.\n')

  const samples: Sample[] = []
  logHeader()
  samples.push(takeSample(0, gcAvailable))
  logSample(samples[samples.length - 1])

  const startedAtMs = Date.now()
  for (let cycle = 1; cycle <= REAL_CYCLES; cycle++) {
    const handle = mountVisitor(asset)
    unmountVisitor(handle)
    // No explicit dispose beyond unmountVisitor()'s drei-mirrored cleanup -- `handle` goes out of
    // scope here, exactly matching what happens when React drops VisitorInstance's local refs.
    if (cycle % REAL_SAMPLE_INTERVAL === 0) {
      const s = takeSample(cycle, gcAvailable)
      samples.push(s)
      logSample(s)
    }
  }
  const wallClockSeconds = (Date.now() - startedAtMs) / 1000

  const maxCacheFiles = Math.max(...samples.map((s) => s.threeCacheFiles))
  assert.equal(maxCacheFiles, 0, `THREE.Cache should never populate for an in-memory GLTFLoader.parse() -- saw ${maxCacheFiles} files cached`)

  const trend = samples.slice(WARMUP_SAMPLES_EXCLUDED)
  const heapValues = trend.map((s) => s.heapUsedMb)
  const rssValues = trend.map((s) => s.rssMb)
  const externalValues = trend.map((s) => s.externalMb)
  const heapSlope = linearSlope(heapValues)
  const rssSlope = linearSlope(rssValues)
  const externalSlope = linearSlope(externalValues)

  const baselineWindow = trend.slice(0, Math.min(5, trend.length))
  const finalWindow = trend.slice(-Math.min(5, trend.length))
  const baselineHeapMb = median(baselineWindow.map((s) => s.heapUsedMb))
  const finalHeapMb = median(finalWindow.map((s) => s.heapUsedMb))

  console.log('\n--- RUN 1 memory trend (post-warmup samples only) ---')
  console.log(
    `heapUsed: baseline(median of first ${baselineWindow.length})=${baselineHeapMb.toFixed(2)}MB -> ` +
      `final(median of last ${finalWindow.length})=${finalHeapMb.toFixed(2)}MB | slope=${(heapSlope * 1000).toFixed(4)}MB/1000 samples`,
  )
  console.log(`rss: slope=${(rssSlope * 1000).toFixed(4)}MB/1000 samples`)
  console.log(`external+arrayBuffers: slope=${(externalSlope * 1000).toFixed(4)}MB/1000 samples`)
  console.log(`THREE.Cache.files count: flat at 0 across all ${samples.length} samples.`)
  console.log(`Ran ${REAL_CYCLES} mount/unmount cycles in ${wallClockSeconds.toFixed(1)}s wall-clock (${samples.length} samples).`)

  const growthFactor = baselineHeapMb > 0 ? finalHeapMb / baselineHeapMb : 1
  console.log(
    `\nRUN 1 VERDICT: ${
      growthFactor <= MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR
        ? `NO LEAK OBSERVED -- heapUsed grew ${((growthFactor - 1) * 100).toFixed(1)}% baseline-to-final, within the ${((MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR - 1) * 100).toFixed(0)}% guard band.`
        : `POSSIBLE LEAK -- heapUsed grew ${((growthFactor - 1) * 100).toFixed(1)}% baseline-to-final, over the guard band.`
    }`,
  )

  return { baselineHeapMb, finalHeapMb, growthFactor }
}

/** Deliberately retains every clone+mixer this run produces (never drops the reference) to prove
 * the harness's forced-GC sampling methodology actually has signal -- see file header. Not a
 * regression guard on its own component; it's a self-check on run 1's measurement technique. */
function runLeakSanityCheck(asset: LoadedVisitorAsset, gcAvailable: boolean): { baselineHeapMb: number; finalHeapMb: number; growthFactor: number } {
  console.log(`\n=== RUN 2: SANITY-CHECK LEAK pattern (${LEAK_SANITY_CYCLES} cycles, deliberately retains every clone+mixer) ===`)
  console.log('This is NOT the real Visitor.tsx pattern -- it exists only to prove this harness can detect retention when it is really there.\n')

  const retained: VisitorHandle[] = []
  const samples: Sample[] = []
  logHeader()
  samples.push(takeSample(0, gcAvailable))
  logSample(samples[samples.length - 1])

  for (let cycle = 1; cycle <= LEAK_SANITY_CYCLES; cycle++) {
    const handle = mountVisitor(asset)
    unmountVisitor(handle)
    retained.push(handle) // <-- the deliberate leak: never released
    if (cycle % LEAK_SANITY_SAMPLE_INTERVAL === 0) {
      const s = takeSample(cycle, gcAvailable)
      samples.push(s)
      logSample(s)
    }
  }

  const baselineWindow = samples.slice(0, Math.min(5, samples.length))
  const finalWindow = samples.slice(-Math.min(5, samples.length))
  const baselineHeapMb = median(baselineWindow.map((s) => s.heapUsedMb))
  const finalHeapMb = median(finalWindow.map((s) => s.heapUsedMb))
  const growthFactor = baselineHeapMb > 0 ? finalHeapMb / baselineHeapMb : 1

  console.log(
    `\nRUN 2 (sanity check) heapUsed: baseline=${baselineHeapMb.toFixed(2)}MB -> final=${finalHeapMb.toFixed(2)}MB ` +
      `(${((growthFactor - 1) * 100).toFixed(1)}% growth, retained ${retained.length} handles)`,
  )
  console.log(
    `RUN 2 VERDICT: ${
      growthFactor >= MIN_LEAK_SANITY_GROWTH_FACTOR
        ? 'GROWTH DETECTED as expected -- this harness DOES have signal; run 1\'s flat result above means healthy code, not a blind spot.'
        : 'GROWTH NOT CLEARLY DETECTED -- this would undermine trust in run 1\'s flat verdict; investigate the sampling methodology before trusting it.'
    }`,
  )

  // Keep `retained` referenced past this point on purpose (assert below), so V8 cannot have
  // already collected it out from under the growth measurement above.
  assert.ok(retained.length === LEAK_SANITY_CYCLES, 'sanity: retained array should hold every cycle\'s handle')

  return { baselineHeapMb, finalHeapMb, growthFactor }
}

async function main(): Promise<void> {
  const gcAvailable = typeof global.gc === 'function'
  if (!gcAvailable) {
    console.warn(
      'WARNING: global.gc() is not available -- run with `npx tsx --expose-gc src/scene/__tests__/visitorLifecycleSoak.test.ts` ' +
        '(or `npm run test:visitorSoak`) for a real retained-memory measurement. Proceeding WITHOUT forced GC; samples will include ' +
        'uncollected garbage, biasing the trend upward.',
    )
  }

  console.log(`Loading ${VISITOR_GLB_PATH} headlessly via GLTFLoader.parse (no DOM needed -- visitor.glb has 0 images/textures)...`)
  const asset = await loadVisitorAsset()
  console.log(`Loaded: ${asset.animations.length} animation clips, mesh count present, gc=${gcAvailable ? 'forced (2 passes/sample)' : 'NOT AVAILABLE'}\n`)

  verifyGeometryAndMaterialAreSharedByReference(asset)
  verifyDreiUncacheActionIsANoop(asset)

  const real = runRealSoak(asset, gcAvailable)
  const sanity = runLeakSanityCheck(asset, gcAvailable)

  console.log('\n=== FINAL SUMMARY ===')
  console.log(
    `RUN 1 (real Visitor.tsx pattern, ${REAL_CYCLES} cycles): heapUsed baseline ${real.baselineHeapMb.toFixed(2)}MB -> final ${real.finalHeapMb.toFixed(2)}MB (${((real.growthFactor - 1) * 100).toFixed(1)}% growth)`,
  )
  console.log(
    `RUN 2 (sanity-check deliberate leak, ${LEAK_SANITY_CYCLES} cycles): heapUsed baseline ${sanity.baselineHeapMb.toFixed(2)}MB -> final ${sanity.finalHeapMb.toFixed(2)}MB (${((sanity.growthFactor - 1) * 100).toFixed(1)}% growth)`,
  )
  console.log(
    '\nWhat this proves: the three.js-level object lifecycle underneath VisitorInstance (SkeletonUtils.clone + AnimationMixer + ' +
      "clipAction, exactly as Visitor.tsx and drei's useAnimations drive it) does not retain memory across thousands of mount/unmount " +
      'cycles, and this harness is sensitive enough to have caught it if it did (RUN 2). What this does NOT prove: it does not exercise ' +
      "React's actual unmount path or R3F's scene-graph removal/useFrame unsubscription -- see this file's header comment.",
  )

  assert.ok(
    real.growthFactor <= MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR,
    `RUN 1 heapUsed grew ${((real.growthFactor - 1) * 100).toFixed(1)}% from baseline (${real.baselineHeapMb.toFixed(2)}MB) to final ` +
      `(${real.finalHeapMb.toFixed(2)}MB), over the ${((MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR - 1) * 100).toFixed(0)}% guard band`,
  )
  assert.ok(
    sanity.growthFactor >= MIN_LEAK_SANITY_GROWTH_FACTOR,
    `RUN 2 (sanity-check leak) heapUsed only grew ${((sanity.growthFactor - 1) * 100).toFixed(1)}%, below the ` +
      `${MIN_LEAK_SANITY_GROWTH_FACTOR}x floor expected for a deliberately-retained pattern -- this harness's measurement methodology ` +
      "may not be sensitive enough to trust RUN 1's flat result",
  )

  console.log('\nALL PASS: visitorLifecycleSoak.test.ts')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err)
    process.exit(1)
  })
