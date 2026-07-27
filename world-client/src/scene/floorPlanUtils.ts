import type { Point2D } from './floorPlanTypes'

/** Axis-aligned bounds of a set of 2D floor-plan points, in the same (x, z) meters. */
export interface Bounds2D {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  centerX: number
  centerZ: number
  sizeX: number
  sizeZ: number
}

/**
 * Converts a 2D direction vector (dx, dz) into the three.js Y-axis rotation that aligns a
 * mesh's LOCAL +X AXIS with that direction. Extracted from Walls.tsx (Task 3.1 forward-note):
 * BoxGeometry is authored with its length along local +X, so a wall segment running from
 * point a to point b needs `rotation.y = directionToYRotation(b.x - a.x, b.z - a.z)` to lie
 * along that segment. See Walls.tsx for the full derivation of why atan2(-dz, dx) is the
 * correct formula (three.js's Y-rotation maps local +X to world (cos(theta), -sin(theta))).
 *
 * NOT a generic "make any model face this direction" helper -- it specifically aligns +X,
 * matching BoxGeometry's own authoring axis. A humanoid character rig authored facing its
 * LOCAL +Z axis (the common convention) needs a different angle for the same (dx, dz): three.js
 * maps local +Z to world (sin(theta), cos(theta)), so the +Z-aligning angle is
 * atan2(dx, dz) -- 90 degrees away from this function's atan2(-dz, dx) in general, not the same
 * value. This is exactly why the world-server's `agent.heading` (see world/src/nav/crowd.ts's
 * `Math.atan2(vel.x, vel.z)`) is deliberately computed with SWAPPED arguments from this
 * function's formula: it's already the +Z-aligning rotation.y, ready to assign directly,
 * because the robot/visitor GLB models face +Z. Robot.tsx/Visitor.tsx therefore assign
 * `rotation.y = agent.heading` directly rather than routing it through this helper -- piping a
 * +Z-convention angle through the +X-aligning formula here would rotate every agent 90 degrees
 * off its true heading.
 */
export function directionToYRotation(dx: number, dz: number): number {
  return Math.atan2(-dz, dx)
}

/**
 * Computes the bounding box (and its center/size) of a polygon's points. Used to frame the
 * camera/MapControls target on the floor plan's actual footprint instead of a hardcoded guess --
 * see App.tsx and the Task 3.1 forward-note about floor-14.json not being centered on the
 * origin (its real footprint is roughly x:[0,36] z:[0,21], centroid ~(18,10.5)).
 */
export function computeOutlineBounds(points: Point2D[]): Bounds2D {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (const [x, z] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: maxX - minX,
    sizeZ: maxZ - minZ,
  }
}
