import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

import { directionToYRotation } from './floorPlanUtils'

/**
 * Draws the furniture footprints extracted from the source drawing
 * (world/data/tools/extract_furniture.py -> world/data/floor-14-furniture.json) as low boxes.
 *
 * WHY THIS EXISTS. The wall geometry is clean, but with nothing inside them every room renders as
 * an empty grey volume, which is what makes the scene read as a WALL DIAGRAM rather than as a
 * building. The source drawing has furniture in essentially every room, and it is separable from
 * the walls by ink intensity alone (the wall extraction's own threshold at 180 splits dark wall
 * ink from light-grey furniture), so it can be recovered as data instead of hand-placed.
 *
 * RENDER-ONLY, AND THAT IS LOAD-BEARING. Furniture is deliberately kept out of the navmesh.
 * world/src/nav/buildNavMesh.ts extrudes every floor-14.json `walls[]` entry into a Recast
 * obstacle; nothing here goes anywhere near that path, and furniture lives in its OWN file so it
 * cannot accidentally be picked up by anything that walks the floor plan's wall list. The reason
 * is reachability: 93 extra obstacles scattered through the rooms would carve up the navmesh and
 * put the 18/18 room-reachability gate at risk for a purely cosmetic gain. The accepted tradeoff
 * is that robots and visitors walk THROUGH furniture. If that is ever revisited, it is a
 * navmesh-tuning project (clearance radius, obstacle inflation, re-running the nav gate), not a
 * one-line change here.
 *
 * COORDINATE CONVENTION matches Walls.tsx/Floor.tsx/Cores.tsx exactly: geometry is authored in raw
 * floor-plan (x, z) meters with no recentering, and App.tsx's single <group scale={[1, 1, -1]}>
 * reflects floor-plan z (north) to world -z for the whole scene at once. <Furniture> MUST be
 * mounted inside that group with the floor and walls, or every item would land mirrored across
 * the building from the room it belongs to.
 */

/** One extracted item. `axis` is a unit vector along the long side, in floor-plan coordinates. */
export interface FurnitureItem {
  center: [x: number, z: number]
  size: [longSide: number, shortSide: number]
  axis: [dx: number, dz: number]
  height: number
}

export interface FurniturePlan {
  units: string
  floor: number
  items: FurnitureItem[]
}

const FURNITURE_COLOR = '#b3a494'

/**
 * Shared material, ONE instance for all of the furniture -- same pattern and same reasoning as
 * Walls.tsx's GLASS_MATERIAL/SOLID_MATERIAL and Cores.tsx's CORE_MATERIAL. Restating the
 * load-bearing half here so it survives the files drifting apart: the material reaches the mesh
 * via the `material` PROP and never as a JSX child, because R3F's reconciler owns and disposes
 * objects that exist as fiber-tree children. A material declared as a JSX child would be destroyed
 * the first time its mesh unmounted, silently blanking anything else sharing the instance.
 *
 * Warmer and a little darker than SOLID_WALL_COLOR (#d8d3c8) and CORE_COLOR (#c2bcb0). Furniture
 * is loose contents rather than building fabric, so it has to separate from the wall it stands
 * against at a glance from a top-down camera; a warm greige reads as furnishing without turning
 * the rooms into a color chart.
 */
export const FURNITURE_MATERIAL = new THREE.MeshStandardMaterial({
  color: FURNITURE_COLOR,
  roughness: 0.8,
})

/**
 * ONE unit-cube geometry for every item, scaled per instance. Authored 1x1x1 and centered, with
 * the item's LONG side mapped to local X and its short side to local Z -- the same axis convention
 * BoxGeometry gets in Walls.tsx, which is why the same directionToYRotation() call orients both.
 */
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1)

/**
 * Scratch objects reused across every instance while composing matrices. Allocating a Matrix4 and
 * a Quaternion per item would be ~370 throwaway objects on every rebuild for no benefit; the loop
 * is synchronous, so a single scratch set is safe.
 */
const SCRATCH_MATRIX = new THREE.Matrix4()
const SCRATCH_POSITION = new THREE.Vector3()
const SCRATCH_QUATERNION = new THREE.Quaternion()
const SCRATCH_SCALE = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/**
 * All items in a single InstancedMesh: one draw call and one geometry for the whole floor's
 * furnishings. The scene already carries ~10 animated GLB agents plus a transmission pass at
 * 60fps, so ~93 individually-mounted <mesh>es (each its own draw call, each its own R3F fiber)
 * would be a real cost for objects that never move.
 *
 * `args` passes an undefined geometry/material and only the count, with the shared instances
 * supplied through the `geometry`/`material` props instead. That is not cosmetic: it keeps the
 * shared material out of the constructor call, so this component matches the prop-not-JSX-child
 * ownership rule the other scene components follow, and it means a change to the item count
 * (`args` identity changes) recreates the InstancedMesh, which is required because an
 * InstancedMesh's instance count is fixed at construction.
 */
function FurnitureInstances({ items }: { items: FurnitureItem[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null)

  // Precomputed once per item list rather than inside the layout effect, so a re-render that does
  // not change `items` does no trigonometry at all.
  const placements = useMemo(
    () =>
      items.map((item) => ({
        position: new THREE.Vector3(item.center[0], item.height / 2, item.center[1]),
        rotationY: directionToYRotation(item.axis[0], item.axis[1]),
        scale: new THREE.Vector3(item.size[0], item.height, item.size[1]),
      })),
    [items],
  )

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    placements.forEach((placement, i) => {
      SCRATCH_POSITION.copy(placement.position)
      SCRATCH_QUATERNION.setFromAxisAngle(Y_AXIS, placement.rotationY)
      SCRATCH_SCALE.copy(placement.scale)
      SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE)
      mesh.setMatrixAt(i, SCRATCH_MATRIX)
    })
    mesh.instanceMatrix.needsUpdate = true

    // An InstancedMesh's default bounding volume comes from the GEOMETRY alone -- here a 1m cube at
    // the origin -- so without this the whole floor's furniture would be frustum-culled as a unit
    // the moment the camera looked away from (0, 0, 0). computeBoundingSphere() on InstancedMesh
    // accounts for the per-instance matrices, which is exactly what the culling test needs.
    mesh.computeBoundingSphere()
  }, [placements])

  return (
    <instancedMesh
      // Keyed on the count so a furniture file with a different item count remounts rather than
      // silently rendering the first N (or leaving stale identity matrices at the origin).
      key={items.length}
      ref={meshRef}
      args={[undefined, undefined, items.length]}
      geometry={UNIT_BOX_GEOMETRY}
      material={FURNITURE_MATERIAL}
      // Same shadow treatment as the solid walls and cores: furniture is opaque, and an object that
      // received shadows but cast none is a large part of what makes a box look like it is floating
      // rather than standing on the carpet.
      castShadow
      receiveShadow
    />
  )
}

/**
 * `furniture` is nullable because it is fetched independently of the floor plan (net/useFurniture.ts):
 * a missing or failed furniture file must degrade to the previous, correct-but-bare scene rather
 * than take the whole floor down with it. An empty item list is handled for the same reason --
 * THREE.InstancedMesh with count 0 is legal but pointless, and skipping it avoids a degenerate
 * bounding sphere.
 */
export function Furniture({ furniture }: { furniture: FurniturePlan | null }) {
  if (!furniture || furniture.items.length === 0) return null
  return <FurnitureInstances items={furniture.items} />
}
