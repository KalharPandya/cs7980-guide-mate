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
 * Per-robot route line: a plain, matte red line drawn flat on the carpet showing the robot's
 * REMAINING path to its goal. The server now publishes exactly that: `Agent.route` is
 * re-derived every tick from Detour's ACTUAL remaining corridor
 * (world/src/rooms/WorldRoom.ts's `publishRobotRoute`, via `crowd.corners()`), already
 * starting at the robot's live position, as flattened x,z pairs. So this component just
 * renders `route` directly -- no client-side reconstruction. (It used to project the robot
 * onto a stale one-shot polyline and draw a straight connector from the robot to it; that
 * connector cut across walls whenever the crowd's real corridor diverged from the snapshot.
 * The corners-based server route removed the need for any of that.)
 *
 * One <RouteLineInstance> per robot, rendered unconditionally (not conditionally mounted on
 * "has a route") because `route` is mutated in place on a ref, not React state (see
 * useWorldRoom.ts), so there is no render to hook a mount/unmount off of; instead each
 * instance polls its own snapshot every frame in useFrame and rebuilds its line points,
 * exactly like Visitor.tsx polls `snapshot.state` for its walk/idle clip switch.
 *
 * Height above the floor: Floor.tsx's carpet sits at y=-0.005, agents render with their feet
 * at y=0 (Robot.tsx/Visitor.tsx) -- ROUTE_LINE_Y lifts the line just clear of the carpet
 * without floating up into the agent models.
 */
const ROUTE_LINE_Y = 0.02

/** Line width in world meters (sizeAttenuation=1 below makes lineWidth a world-space size,
 * not a screen-pixel size -- see MeshLineMaterial's `sizeAttenuation` param). Thin, matte
 * marker on the floor. */
const ROUTE_LINE_WIDTH_M = 0.06

/** Plain solid red, DELIBERATELY dim enough NOT to bloom. App.tsx runs a scene-wide <Bloom>
 * with luminanceThreshold=0.3; its luminance is the standard dot(color, [0.2125,0.7154,0.0721]),
 * which for this red is ~0.20 -- below 0.3 -- so the line stays matte and does NOT glow. Kept
 * <= 1.0 on every channel (and toneMapping left ON, i.e. no `toneMapped={false}`) so it can
 * never be pushed into bloom range the way the old overdriven cyan was. */
const ROUTE_LINE_COLOR = new THREE.Color(0.75, 0.05, 0.05)

/** Below 2 points there's no line to draw (a single point degenerates to nothing). A parked/
 * idle robot has an empty route (see WorldRoom.ts's arrival clear), so this also keeps an idle
 * robot from showing any line. */
const MIN_ROUTE_POINTS = 2

/**
 * Expands the server's flattened (x0, z0, x1, z1, ...) route into the flat
 * [x0, y, z0, x1, y, z1, ...] triples MeshLineGeometry.setPoints accepts (lifting every
 * vertex to ROUTE_LINE_Y), or null when there is nothing drawable (fewer than 2 points).
 *
 * No reconstruction: the server already publishes the robot's remaining corridor starting
 * at the robot's live position (WorldRoom.publishRobotRoute), so the polyline is drawn
 * exactly as received.
 */
function buildRoutePoints(route: ArrayLike<number>): number[] | null {
  const pointCount = Math.floor(route.length / 2)
  if (pointCount < MIN_ROUTE_POINTS) return null

  const points: number[] = []
  for (let i = 0; i < pointCount; i++) {
    points.push(route[i * 2], ROUTE_LINE_Y, route[i * 2 + 1])
  }
  return points
}

function RouteLineInstance({ snapshot }: { snapshot: AgentSnapshot }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const geometryRef = useRef<MeshLineGeometry>(null)
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

  useFrame(() => {
    // Rebuild the line from the server's route every frame (cheap for a handful of robots).
    // The server re-derives `route` from Detour's live corridor each tick, so it already
    // starts at the robot and shrinks as the robot advances -- just render it.
    const points = buildRoutePoints(snapshot.route)
    const visible = points !== null
    if (points && geometryRef.current) {
      geometryRef.current.setPoints(points)
    }
    if (meshRef.current) {
      meshRef.current.visible = visible
    }
  })

  return (
    <mesh ref={meshRef} visible={false}>
      <meshLineGeometry ref={geometryRef} />
      <meshLineMaterial
        args={materialArgs}
        color={ROUTE_LINE_COLOR}
        lineWidth={ROUTE_LINE_WIDTH_M}
        sizeAttenuation={1}
        resolution={[size.width, size.height]}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * Renders every ROBOT's remaining-route line. Visitors are explicitly skipped -- only robots
 * are dispatched a route to show, and a visitor must never draw a line.
 */
export function RouteLines({ agentIds, agents }: { agentIds: string[]; agents: Map<string, AgentSnapshot> }) {
  return (
    <>
      {agentIds.map((id) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        if (snapshot.kind !== 'robot') return null
        return <RouteLineInstance key={id} snapshot={snapshot} />
      })}
    </>
  )
}
