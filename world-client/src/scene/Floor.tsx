import { useMemo } from 'react'
import * as THREE from 'three'

import type { FloorPlan, Point2D } from './floorPlanTypes'

/**
 * Renders the walkable floor as a single ShapeGeometry: the outer `walkableOutline` polygon with
 * every entry in `holes` (currently just the elevator/stair core) subtracted, so the carpet
 * doesn't render "through" the core. Flat grey carpet material per Task 3.1 -- a tiling normal
 * map is optional future work, not required here.
 *
 * Coordinate convention (shared with Walls.tsx, RoomLabels.tsx, and AgentInstances.tsx's
 * Robot.tsx/Visitor.tsx): world (x, y-up, z) maps directly to floor-plan (x, up, z) -- NOT
 * recentered on the origin. This matters because the world-server already emits agent
 * positions in these same raw meters (see world/src/rooms/WorldRoom.ts, which sets
 * agent.x/z straight from plan.entrance.point / room.door, and Robot.tsx/Visitor.tsx, which
 * render snapshot.x/z as-is). Recentering the geometry here would desync it from the agents
 * that already share this file's coordinates. Instead,
 * App.tsx points the camera and MapControls target at the floor plan's bounding-box center
 * (computed from walkableOutline, not hardcoded) -- see the Task 3.1 forward-note about
 * floor-14.json's footprint not being centered on the origin.
 *
 * THREE.ShapeGeometry is authored in a local XY plane; to lay it flat with its normal facing +Y
 * (so it's lit and shadow-receiving like a normal floor) each 2D point is authored as (x, -z) in
 * that local plane, then the mesh is rotated -90 degrees about X. That "negate Y, then rotate"
 * pairing is what makes the final world Z come out as +z (matching the other components) while
 * still getting an upward-facing normal -- flipping either half of that pairing on its own would
 * either mirror the shape or point the normal down.
 */
function toShapePoint([x, z]: Point2D): THREE.Vector2 {
  return new THREE.Vector2(x, -z)
}

export function Floor({ floorPlan }: { floorPlan: FloorPlan }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(floorPlan.walkableOutline.map(toShapePoint))
    for (const hole of floorPlan.holes) {
      shape.holes.push(new THREE.Path(hole.polygon.map(toShapePoint)))
    }
    return new THREE.ShapeGeometry(shape)
  }, [floorPlan])

  return (
    // Offset slightly below y=0 (not exactly 0) so the floor plane and the walls' bottom caps
    // (which sit at y=0, see Walls.tsx) are never exactly coplanar -- avoids z-fighting.
    <mesh geometry={geometry} position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial color="#8a8a8a" roughness={0.95} />
    </mesh>
  )
}
