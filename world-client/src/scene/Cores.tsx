import { useMemo } from 'react'
import * as THREE from 'three'

import type { FloorPlanHole, FloorPlanWall, Point2D } from './floorPlanTypes'
import { tallestWallHeight } from './floorPlanUtils'

/**
 * Renders each entry of `floorPlan.holes` as a SOLID VOLUME standing on the floor.
 *
 * Why this component exists (visual QA, 2026-08-09). Floor.tsx subtracts every hole polygon from
 * the floor's ShapeGeometry, which is correct as far as it goes: it stops the carpet rendering
 * "through" the core. But subtraction alone leaves nothing at all in that footprint, so from any
 * normal (non-top-down) camera angle you looked straight through the floor to the background and
 * the two holes read as PITS cut into the building. In the source drawing
 * (world/data/source/floor-14-plan-hires.png) those two bands are the elevator and stair shafts:
 * solid building mass that a person on floor 14 walks AROUND, not holes they could fall into.
 * So the hole subtraction stays exactly as it is, and this component adds the mass back on top of
 * it as a closed block. The two are complementary, not alternatives: the subtraction removes the
 * carpet, this fills the resulting gap with the thing that is actually there.
 *
 * This is purely cosmetic. `holes` are already excluded from the navmesh server-side
 * (world/src/nav/buildNavMesh.ts), so nothing here can affect where any agent can walk.
 *
 * Coordinate convention is identical to Floor.tsx's, deliberately: geometry is authored in raw
 * floor-plan (x, z) meters with no recentering, and App.tsx's single <group scale={[1, 1, -1]}>
 * reflects floor-plan z (north) to world -z for the whole scene at once. <Cores> must be mounted
 * INSIDE that same group alongside <Floor>/<Walls>, or the cores would land mirrored across the
 * building from the holes they are supposed to fill.
 */

const CORE_COLOR = '#c2bcb0'

/**
 * Shared material, ONE instance for every core (module scope, not a per-mesh JSX child) -- the same
 * pattern and the same reasoning as Walls.tsx's GLASS_MATERIAL/SOLID_MATERIAL, and pinned by the
 * same test (__tests__/wallMaterials.test.ts). Restating the load-bearing half of that reasoning
 * here so it is not lost if these files drift apart: the material is handed to <mesh> via the
 * `material` PROP and never as a JSX child, because R3F's reconciler disposes objects that exist as
 * fiber-tree children when their parent unmounts. A material declared as a JSX child would
 * therefore be destroyed the first time any single core unmounted, silently blanking every other
 * mesh that shares the instance. An object merely assigned to an instance prop is never entered
 * into the fiber tree and so is never a disposal target.
 *
 * Slightly darker and rougher than Walls.tsx's SOLID_WALL_COLOR (#d8d3c8 / roughness 0.85). The
 * difference is deliberate and small: a service core is poured/blockwork structure rather than
 * finished partition, so reading as a distinctly heavier mass is what sells it as building
 * structure, but too much contrast would make it look like a separate object dropped onto the
 * floor rather than part of the same building.
 */
export const CORE_MATERIAL = new THREE.MeshStandardMaterial({
  color: CORE_COLOR,
  roughness: 0.92,
})

/**
 * How far a core rises ABOVE the plan's tallest wall, in meters. A service core is one of the few
 * things on a floor plate that genuinely runs full height and past the partitions around it, so a
 * small positive step is what makes it read as a core rather than as one more room-shaped box: it
 * keeps a visible top edge of its own instead of merging into the skyline of the 2.7m walls beside
 * it. Kept small (a core flush with the walls reads as a blank room; a core towering over them
 * reads as a separate tower) and measured from the plan's OWN tallest wall via tallestWallHeight
 * rather than from a hardcoded 2.7, so a floor plan authored at different absolute heights still
 * gets a core that is proportionate to it.
 */
const CORE_HEIGHT_ABOVE_TALLEST_WALL_M = 0.15

/**
 * Fallback core height for a (degenerate) plan with no walls at all to measure against, so the core
 * is never extruded to zero depth -- which would collapse it back into the see-through void this
 * component exists to remove.
 */
const CORE_FALLBACK_HEIGHT_M = 2.7

/**
 * How far the block is sunk BELOW the floor plane, in meters. The core's side faces sit exactly on
 * the hole polygon, which is exactly where Floor.tsx's ShapeGeometry stops, so the two meet edge to
 * edge with no overlap. Burying the block a couple of centimeters guarantees that seam can never
 * open into a visible sliver of background at a grazing camera angle or under shadow-map bias.
 * Cheaper and more robust than trying to make two independently-triangulated boundaries agree
 * exactly. The floor mesh itself already sits at y = -0.005 (Floor.tsx), so this clears it too.
 */
const CORE_BASE_SINK_M = 0.02

/** Matches Floor.tsx exactly: a floor-plan (x, z) point authored into the local XY plane of a
 * shape that will then be rotated -90 degrees about X. See Floor.tsx's doc comment for why the
 * "negate z, then rotate" pairing is what yields both an upward-facing result and a group-local
 * +z that agrees with every other component. */
function toShapePoint([x, z]: Point2D): THREE.Vector2 {
  return new THREE.Vector2(x, -z)
}

/**
 * Height (meters) of the core volumes for a given wall list. Exported so the offline geometry test
 * can assert against the same number the renderer uses instead of restating it.
 */
export function coreHeightForWalls(walls: FloorPlanWall[]): number {
  const tallest = tallestWallHeight(walls)
  if (tallest <= 0) return CORE_FALLBACK_HEIGHT_M
  return tallest + CORE_HEIGHT_ABOVE_TALLEST_WALL_M
}

/**
 * One core: the hole polygon extruded into a closed block.
 *
 * THREE.ExtrudeGeometry extrudes a shape authored in the local XY plane along local +Z. Rotating
 * the mesh -90 degrees about X maps local (x, y, z) to world (x, z, -y), so the extrusion axis
 * (local +Z) becomes world +Y (up) and the block stands on the floor rather than lying flat or
 * hanging down. That is the same rotation Floor.tsx uses, which is exactly why the same
 * toShapePoint() authoring works for both and the two stay registered with each other.
 *
 * bevelEnabled is off: a bevel would inflate the footprint past the hole polygon, so the block
 * would poke out over the surrounding carpet instead of meeting it flush at the cut edge.
 *
 * Shadows match the solid walls (cast AND receive) -- a core is opaque mass, and a core that
 * received but did not cast would sit in the scene with no contact shadow at all, which is a large
 * part of what makes an object look like it is floating rather than standing on the floor.
 */
function Core({ hole, height }: { hole: FloorPlanHole; height: number }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(hole.polygon.map(toShapePoint))
    return new THREE.ExtrudeGeometry(shape, {
      depth: height + CORE_BASE_SINK_M,
      bevelEnabled: false,
    })
  }, [hole, height])

  return (
    <mesh
      geometry={geometry}
      position={[0, -CORE_BASE_SINK_M, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      material={CORE_MATERIAL}
      castShadow
      receiveShadow
    />
  )
}

export function Cores({ holes, walls }: { holes: FloorPlanHole[]; walls: FloorPlanWall[] }) {
  // One height for every core, computed once from the whole plan rather than per hole: the cores
  // are the same structure and should top out together, and a per-hole recompute would be the same
  // scan of all 79 walls repeated for each.
  const height = useMemo(() => coreHeightForWalls(walls), [walls])

  return (
    <>
      {holes.map((hole, i) => (
        // `name` is unique in floor-14.json today but the schema does not guarantee it, so the
        // index is included for the same reason Walls.tsx includes it.
        <Core key={`${hole.name}-${i}`} hole={hole} height={height} />
      ))}
    </>
  )
}
