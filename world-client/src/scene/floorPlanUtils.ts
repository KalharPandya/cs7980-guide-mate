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
