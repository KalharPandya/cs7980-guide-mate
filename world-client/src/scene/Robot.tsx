import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances, useGLTF, type PositionMesh } from '@react-three/drei'

import type { AgentSnapshot } from '../net/useWorldRoom'
import { lerpXZToward } from './agentMotion'
import { bakeToStandingGeometry } from './modelBake'

const ROBOT_MODEL_URL = '/models/robot.glb'

/**
 * Target standing height in meters. RobotExpressive.glb (Task 0.4's CC0 asset, three.js's
 * example "RobotExpressive" model) is a humanoid-proportioned cartoon robot, not a literal
 * TurtleBot -- see CLAUDE.md's project description for why this stylized asset was chosen for
 * the virtual-world demo instead of a boxy TurtleBot mesh. Picked slightly shorter than the
 * visitor's 1.7m (see Visitor.tsx) so the two kinds read as visually distinct at a glance.
 */
const ROBOT_HEIGHT_M = 1.4

/**
 * Upper bound on simultaneous robot instances, sized for drei's <Instances> instance-attribute
 * buffer (allocated once, from this number, via a lazy useState initializer -- see Instances.js
 * -- so it must cover agents that join AFTER first render, not just the count at mount time).
 * The virtual-world fleet demo targets ~50 robots (see docs/superpowers/specs/); 200 leaves
 * headroom without allocating a wastefully large buffer.
 */
const MAX_ROBOT_INSTANCES = 200

/**
 * One instance's live transform, driven by the synced snapshot every frame. Lerps position (the
 * server patches at ~20Hz, the client renders at 60fps -- see DemoAgents.tsx, the file this
 * replaces, for why a per-frame lerp rather than a snap is required) and assigns rotation.y
 * straight from `snapshot.heading`. That field is already a three.js Y-rotation, not a raw
 * direction vector -- see floorPlanUtils.ts's directionToYRotation doc comment for why it is
 * NOT routed through that helper (it aligns a different axis) and why assigning it directly is
 * correct for this model.
 */
function RobotInstance({ snapshot }: { snapshot: AgentSnapshot }) {
  const ref = useRef<PositionMesh>(null)

  useFrame((_state, delta) => {
    const instance = ref.current
    if (!instance) return
    lerpXZToward(instance, snapshot.x, snapshot.z, delta)
    instance.rotation.y = snapshot.heading
  })

  // Shadow casting is set once on the parent <Instances> (the InstancedMesh) below -- three.js
  // has no per-instance castShadow concept, so it isn't repeated (and would be a no-op) here.
  return <Instance ref={ref} position={[snapshot.x, 0, snapshot.z]} />
}

/**
 * Renders every `kind === "robot"` agent with true GPU instancing (drei's <Instances>/<Instance>,
 * one InstancedMesh, transform-per-instance), as the Task 3.2 brief prefers for robots.
 *
 * Instancing-vs-clone decision: this is only possible because RobotExpressive.glb, despite being
 * rigged, never needs to animate a *different* pose per instance here: robots don't play
 * per-agent walk cycles in this design, so the whole rig can be frozen into one static merged
 * geometry (see modelBake.ts) at load time and reused across every robot instance, with only
 * position/rotation varying per instance. If a later task wants per-robot walk animation, that
 * reintroduces per-instance skinning, which InstancedMesh cannot do natively -- at that point this
 * should fall back to individual SkeletonUtils clones like Visitor.tsx, not before.
 *
 * Draw-call count (re-verified directly from robot.glb's glTF JSON, not carried over from an
 * earlier guess): the asset has 19 primitives total across 3 materials, spread over 14 named
 * meshes/nodes (Torso and Head alone contribute 2 and 3 primitives respectively). Only 4 of those
 * 19 primitives -- the two in Hand.L and the two in Hand.R -- actually carry JOINTS_0/WEIGHTS_0
 * (truly skinned); the rest are plain meshes parented at bone nodes. modelBake.ts's
 * bakeToStandingGeometry() bakes ONE THREE.BufferGeometry per primitive (skinned or not, via
 * getVertexPosition) and merges all of them with `mergeGeometries(..., true)`, which keeps one
 * geometry `.group` (and thus one material slot) per input primitive. So the merged geometry
 * <Instances> renders here is up to ~19 draw calls, not literally one -- but that ~19 is FIXED
 * regardless of how many robots are on screen (vs. 19 draw calls PER robot without instancing),
 * which is still the whole point of baking + instancing for the ~50-robot fleet target.
 */
export function Robots({ agentIds, agents }: { agentIds: string[]; agents: Map<string, AgentSnapshot> }) {
  const gltf = useGLTF(ROBOT_MODEL_URL)
  const { geometry, materials } = useMemo(() => bakeToStandingGeometry(gltf.scene, ROBOT_HEIGHT_M), [gltf])

  const robotIds = agentIds.filter((id) => agents.get(id)?.kind === 'robot')

  return (
    <Instances geometry={geometry} material={materials} limit={MAX_ROBOT_INSTANCES} castShadow receiveShadow>
      {robotIds.map((id) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        return <RobotInstance key={id} snapshot={snapshot} />
      })}
    </Instances>
  )
}

useGLTF.preload(ROBOT_MODEL_URL)
