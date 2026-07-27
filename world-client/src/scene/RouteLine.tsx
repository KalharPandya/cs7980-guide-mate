import { useMemo, useRef } from 'react'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import * as THREE from 'three'
import { MeshLineGeometry, MeshLineMaterial, type MeshLineMaterialParameters } from 'meshline'

import type { AgentSnapshot } from '../net/useWorldRoom'

// Registers <meshLineGeometry>/<meshLineMaterial> as usable JSX intrinsics -- meshline ships
// plain THREE.BufferGeometry/THREE.ShaderMaterial subclasses, not R3F components, so R3F's
// catalog has to be told about them once via extend() (the same mechanism drei's own <Line>
// uses internally). Module-level (not per-component) since it's process-wide registration.
extend({ MeshLineGeometry, MeshLineMaterial })

// R3F v9's JSX typing is generated from whatever's in the `ThreeElements` interface --
// augmenting it here is what makes `<meshLineGeometry>`/`<meshLineMaterial>` type-check
// instead of erroring as unknown intrinsic elements.
declare module '@react-three/fiber' {
  interface ThreeElements {
    meshLineGeometry: ThreeElement<typeof MeshLineGeometry>
    meshLineMaterial: ThreeElement<typeof MeshLineMaterial>
  }
}

/**
 * Task 3.3: the signature "glowing route line" -- a meshline ribbon following the polyline
 * WorldRoom.moveAgentTo() computed (world/src/rooms/WorldRoom.ts's `updateAgentRoute`, via
 * `navMeshQuery.computePath`) and synced onto `Agent.route` (flattened x,z pairs). One
 * <RouteLineInstance> per agent, same as Robot.tsx/Visitor.tsx -- rendered unconditionally
 * (not conditionally mounted on "has a route") because `route` is mutated in place on a ref,
 * not React state (see useWorldRoom.ts), so there is no render to hook a mount/unmount off
 * of; instead each instance polls its own snapshot.route every frame in useFrame and toggles
 * its own mesh visibility, exactly like Visitor.tsx polls `snapshot.state` for its walk/idle
 * clip switch.
 *
 * Height above the floor: Floor.tsx's carpet sits at y=-0.005, agents render with their feet
 * at y=0 (Robot.tsx/Visitor.tsx) -- ROUTE_LINE_Y lifts the ribbon just clear of the carpet
 * without floating up into the agent models.
 */
const ROUTE_LINE_Y = 0.02

/** Ribbon width in world meters (sizeAttenuation=1 below makes lineWidth a world-space size,
 * not a screen-pixel size -- see MeshLineMaterial's `sizeAttenuation` param). */
const ROUTE_LINE_WIDTH_M = 0.3

/** Saturated, overdriven-toward-white color (components intentionally > 1): MeshLineMaterial
 * is an unlit THREE.ShaderMaterial (not a physical material lit by the scene), so its output
 * color IS its rendered color -- pushing it past 1.0 is what gives <Bloom>'s luminance
 * threshold (see App.tsx) something to actually bloom, rather than just a flat bright cyan
 * that reads as merely "colored" instead of "glowing". */
const ROUTE_LINE_COLOR = new THREE.Color(0.6, 2.4, 3.2)

/** One dash+gap cycle spans this fraction of the route's total length (MeshLine's `counters`
 * attribute runs 0 at the route start to 1 at the destination, and `dashArray` divides that
 * 0..1 span). Small enough to read as a flowing series of dashes rather than one giant blink. */
const DASH_ARRAY = 0.08
/** Fraction of each dash+gap cycle that is lit (vs. gap). */
const DASH_RATIO = 0.55
/** dashOffset change per second. MeshLineMaterial's shader computes
 * `mod(vCounters + dashOffset, dashArray)`, so DEcreasing dashOffset over time slides the lit
 * segments toward increasing vCounters -- i.e. toward the destination end of the route, which
 * is the "flow toward destination" effect this is going for. */
const FLOW_SPEED = 0.6

/** Below 2 points there's no line to draw (a single point degenerates to nothing). */
const MIN_ROUTE_POINTS = 2

function RouteLineInstance({ snapshot }: { snapshot: AgentSnapshot }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const geometryRef = useRef<MeshLineGeometry>(null)
  const materialRef = useRef<MeshLineMaterial>(null)
  // Cached point-pair count from the last time the ribbon geometry was rebuilt -- route only
  // actually changes on a new moveAgentTo() call or on arrival-clear (see WorldRoom.ts), both
  // rare compared to 60fps, so this skips rebuilding the MeshLineGeometry's attributes on
  // every frame the route is simply sitting there unchanged.
  const lastPointCountRef = useRef(-1)
  const size = useThree((state) => state.size)
  // MeshLineMaterialParameters.resolution is a required constructor argument (unlike every
  // other prop here, which is fine as a plain reactive JSX prop) -- but this must be computed
  // ONCE (empty deps), not from `size` directly, or a resize would change `args`'s identity
  // and make R3F destroy/recreate the whole material every time the window resizes. The
  // reactive `resolution` prop below (which DOES track `size`) is what actually keeps it
  // correct after mount.
  const materialArgs = useMemo<[MeshLineMaterialParameters]>(
    () => [{ resolution: new THREE.Vector2(1, 1) }],
    [],
  )

  useFrame((_state, delta) => {
    const route = snapshot.route
    const pointCount = Math.floor(route.length / 2)

    if (pointCount !== lastPointCountRef.current) {
      lastPointCountRef.current = pointCount
      if (pointCount >= MIN_ROUTE_POINTS && geometryRef.current) {
        const points: THREE.Vector3[] = new Array(pointCount)
        for (let i = 0; i < pointCount; i++) {
          points[i] = new THREE.Vector3(route[i * 2], ROUTE_LINE_Y, route[i * 2 + 1])
        }
        geometryRef.current.setPoints(points)
      }
    }

    if (meshRef.current) {
      meshRef.current.visible = pointCount >= MIN_ROUTE_POINTS
    }
    if (materialRef.current) {
      materialRef.current.dashOffset -= delta * FLOW_SPEED
    }
  })

  return (
    <mesh ref={meshRef} visible={false}>
      <meshLineGeometry ref={geometryRef} />
      <meshLineMaterial
        ref={materialRef}
        args={materialArgs}
        color={ROUTE_LINE_COLOR}
        lineWidth={ROUTE_LINE_WIDTH_M}
        sizeAttenuation={1}
        resolution={[size.width, size.height]}
        transparent
        depthWrite={false}
        toneMapped={false}
        useDash={1}
        dashArray={DASH_ARRAY}
        dashRatio={DASH_RATIO}
      />
    </mesh>
  )
}

/**
 * Renders every agent's route ribbon. Not filtered by `kind` -- `moveAgentTo` (and thus
 * `route`) isn't kind-restricted server-side, so this covers robots today and stays correct
 * if visitors are ever dispatched the same way.
 */
export function RouteLines({ agentIds, agents }: { agentIds: string[]; agents: Map<string, AgentSnapshot> }) {
  return (
    <>
      {agentIds.map((id) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        return <RouteLineInstance key={id} snapshot={snapshot} />
      })}
    </>
  )
}
