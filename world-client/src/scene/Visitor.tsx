import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAnimations, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

import type { AgentSnapshot } from '../net/useWorldRoom'
import { lerpXZToward } from './agentMotion'

const VISITOR_MODEL_URL = '/models/visitor.glb'

/** Target standing height in meters -- an average adult person. See Robot.tsx for the robot's. */
const VISITOR_HEIGHT_M = 1.7

/**
 * Real clip names embedded in visitor.glb (Quaternius CC0 human, Task 0.4), inspected directly
 * from the GLB's animation list rather than trusted from public/models/README.md's prose, which
 * omits the "Human Armature|" prefix every clip actually has. Confirmed via a one-off GLTFLoader
 * parse before this file was written: `gltf.animations.map(a => a.name)` ==
 * ["Human Armature|ArmatureAction.002", "Human Armature|Death", "Human Armature|Idle",
 *  "Human Armature|Jump", "Human Armature|Punch", "Human Armature|Run", "Human Armature|Walk",
 *  "Human Armature|Working"].
 */
const IDLE_CLIP_NAME = 'Human Armature|Idle'
const WALK_CLIP_NAME = 'Human Armature|Walk'

const CROSSFADE_SECONDS = 0.2

/**
 * One visitor. Individually cloned (not instanced like Robot.tsx's batched robots) because each
 * visitor needs its OWN independently-playing skeletal animation (Idle vs Walk) -- something a
 * single InstancedMesh cannot do per-instance. `SkeletonUtils.clone` (not `Object3D.clone`, which
 * would share one skeleton/bone hierarchy across every clone and make them all pose identically)
 * deep-clones the whole rig including a fresh Skeleton, so each visitor's AnimationMixer drives
 * its own bones. `gltf.animations` (the AnimationClip array) is safe to reuse as-is across every
 * clone: three.js resolves each clip's tracks by node NAME within whatever root is handed to
 * `mixer.clipAction`, and SkeletonUtils.clone preserves every node's `.name` (only `.uuid`
 * changes), so binding the shared clips against each clone's own root works correctly -- this is
 * the standard three.js/drei pattern for animated crowds of one shared asset.
 */
function VisitorInstance({
  snapshot,
  animations,
  scale,
  footOffset,
}: {
  snapshot: AgentSnapshot
  animations: THREE.AnimationClip[]
  scale: number
  footOffset: number
}) {
  const gltf = useGLTF(VISITOR_MODEL_URL)
  const clonedScene = useMemo(() => {
    const clone = cloneSkeleton(gltf.scene) as THREE.Group
    clone.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    return clone
  }, [gltf])

  const { actions } = useAnimations(animations, clonedScene)
  // Per-instance random offset into the clip so a crowd of visitors playing the same clip don't
  // all step in lockstep -- picked once per mount, reused as a modulo offset each time a clip
  // (re)starts.
  const timeOffsetRef = useRef(Math.random() * 5)
  // Tracks whichever clip is currently playing, so the switch below only fires on an actual
  // transition rather than every frame.
  const playingClipRef = useRef<string | null>(null)

  useFrame((_state, delta) => {
    lerpXZToward(clonedScene, snapshot.x, snapshot.z, delta)
    clonedScene.rotation.y = snapshot.heading

    // `snapshot.state` is mutated in place by useWorldRoom's onChange callback, NOT via React
    // state (see useWorldRoom.ts's doc comment: that's deliberate, so a 20Hz server patch doesn't
    // force a React re-render per agent per tick). That means a useEffect keyed on
    // `snapshot.state` would never re-fire when the server flips idle<->moving -- nothing ever
    // re-renders this component to notice. So the clip switch is polled here, every frame,
    // exactly like the position/rotation above, and only acts when the value actually changed.
    const nextClipName = snapshot.state === 'moving' ? WALK_CLIP_NAME : IDLE_CLIP_NAME
    if (nextClipName === playingClipRef.current) return

    const nextAction = actions[nextClipName]
    if (!nextAction) return

    const previousClipName = playingClipRef.current
    const previousAction = previousClipName ? actions[previousClipName] : undefined

    const duration = nextAction.getClip().duration
    nextAction.reset()
    nextAction.time = duration > 0 ? timeOffsetRef.current % duration : 0
    nextAction.fadeIn(CROSSFADE_SECONDS).play()
    previousAction?.fadeOut(CROSSFADE_SECONDS)

    playingClipRef.current = nextClipName
  })

  return (
    <primitive
      object={clonedScene}
      position={[snapshot.x, footOffset, snapshot.z]}
      scale={[scale, scale, scale]}
    />
  )
}

/**
 * Renders every `kind === "visitor"` agent as its own SkeletonUtils clone (see VisitorInstance's
 * doc comment for why visitors can't share Robot.tsx's batched-instancing approach). Scale and
 * foot-offset are computed ONCE here (from the shared, un-cloned gltf.scene's bind-pose bounding
 * box) and passed down, rather than recomputed per clone -- every clone shares the same rest
 * geometry so the measurement is identical, and Box3(precise) over a skinned mesh is one extra
 * per-vertex pass not worth repeating per visitor.
 */
export function Visitors({ agentIds, agents }: { agentIds: string[]; agents: Map<string, AgentSnapshot> }) {
  const gltf = useGLTF(VISITOR_MODEL_URL)

  const { scale, footOffset } = useMemo(() => {
    gltf.scene.updateMatrixWorld(true)
    // precise=true: gltf.scene's single mesh is skinned (Task 3.2 GLB inspection), and a
    // non-precise Box3 reads the raw un-skinned geometry bounds, not the actual bind pose.
    const box = new THREE.Box3().setFromObject(gltf.scene, true)
    const nativeHeight = box.max.y - box.min.y
    const s = VISITOR_HEIGHT_M / nativeHeight
    return { scale: s, footOffset: -box.min.y * s }
  }, [gltf])

  const visitorIds = agentIds.filter((id) => agents.get(id)?.kind === 'visitor')

  return (
    <>
      {visitorIds.map((id) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        return (
          <VisitorInstance
            key={id}
            snapshot={snapshot}
            animations={gltf.animations}
            scale={scale}
            footOffset={footOffset}
          />
        )
      })}
    </>
  )
}

useGLTF.preload(VISITOR_MODEL_URL)
