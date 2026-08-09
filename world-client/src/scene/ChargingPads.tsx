import { useMemo } from 'react'
import * as THREE from 'three'

import type { StationSnapshot } from '../net/useWorldRoom'

/**
 * A visible charging pad drawn on the carpet at each guide robot's home station (see
 * world/src/rooms/schema/WorldState.ts's Station schema and WorldRoom's fleet-seeding loop).
 * A robot returns to and parks on its pad whenever it is idle and not escorting -- so these
 * pads read as "this is where robot N lives" and mark the spots the fleet rests between jobs.
 *
 * Look: a thin cyan ring plus a very faint inner disc, flat on the floor. The ring's emissive
 * is pushed just past 1.0 and toneMapped is off (same trick RouteLine.tsx uses, see its
 * ROUTE_LINE_COLOR comment) so App.tsx's <Bloom> gives it a soft glow that echoes the glowing
 * route lines, tying the two into one lighting language -- kept subtle (low opacity, thin ring)
 * so a floor of ~5 parked pads reads as calm ambient detail, not five bright beacons.
 *
 * Coordinate convention matches Floor.tsx/Robot.tsx: world (x, y-up, z) is raw floor-plan
 * meters, not recentered, so a station's (x, z) places its pad directly under the robot that
 * parks there. Geometry is authored in the local XY plane and rotated -90deg about X to lie
 * flat with an upward normal, exactly like Floor.tsx.
 */

/** Outer radius of the pad in world meters. Sized to comfortably contain a parked robot
 * (~0.2m AGENT_RADIUS_M) and to match WorldRoom's PARK_TOLERANCE_M (0.4m) so a robot resting
 * within "parked" tolerance sits visually on its pad. */
const PAD_OUTER_RADIUS_M = 0.36

/** Inner radius of the ring -- the gap between this and PAD_OUTER_RADIUS_M is the ring's
 * thickness (~0.05m), thin enough to read as a clean outline rather than a solid coaster. */
const PAD_INNER_RADIUS_M = 0.31

/** Height above the floor (Floor.tsx's carpet sits at y=-0.005). Just clear of the carpet to
 * avoid z-fighting, and below RouteLine.tsx's ribbon (y=0.02) so a route line drawn over a pad
 * layers on top. The faint inner disc sits a hair lower than the ring so the two don't
 * z-fight with each other either. */
const PAD_DISC_Y = 0.01
const PAD_RING_Y = 0.011

/** Cyan tint echoing RouteLine.tsx's ROUTE_LINE_COLOR. The ring is pushed past 1.0 so <Bloom>
 * (App.tsx, luminanceThreshold 0.3) picks it up as a soft glow; the disc stays well under 1.0
 * and toneMapped so it's just a faint wash of color inside the ring, not a second glowing
 * element. */
const PAD_RING_COLOR = new THREE.Color(0.4, 1.6, 2.1)
const PAD_DISC_COLOR = new THREE.Color(0.15, 0.5, 0.65)

/** Segment count for the ring/disc circles -- 48 is smooth at demo camera distance without
 * spending vertices no one can see on a 0.36m pad. */
const CIRCLE_SEGMENTS = 48

function ChargingPad({ station }: { station: StationSnapshot }) {
  return (
    <group position={[station.x, 0, station.z]}>
      {/* Faint inner disc -- a soft cyan wash inside the ring. */}
      <mesh position={[0, PAD_DISC_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[PAD_OUTER_RADIUS_M, CIRCLE_SEGMENTS]} />
        <meshBasicMaterial
          color={PAD_DISC_COLOR}
          transparent
          opacity={0.12}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Glowing ring outline -- the part <Bloom> lifts into a soft halo. */}
      <mesh position={[0, PAD_RING_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[PAD_INNER_RADIUS_M, PAD_OUTER_RADIUS_M, CIRCLE_SEGMENTS]} />
        <meshBasicMaterial
          color={PAD_RING_COLOR}
          transparent
          opacity={0.85}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

/**
 * Renders one pad per station. `stations` is static after join (see useWorldRoom.ts's
 * StationSnapshot), so this is a plain map with no per-frame work -- unlike the agent/route
 * renderers, a pad never moves once placed.
 */
export function ChargingPads({ stations }: { stations: StationSnapshot[] }) {
  // Keys are stable station ids; nothing here is recomputed per frame. useMemo only avoids
  // rebuilding the element array on unrelated App re-renders (e.g. connection-status changes).
  return useMemo(
    () => (
      <>
        {stations.map((station) => (
          <ChargingPad key={station.id} station={station} />
        ))}
      </>
    ),
    [stations],
  )
}
