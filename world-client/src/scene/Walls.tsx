import { useMemo } from 'react'
import * as THREE from 'three'

import type { FloorPlanWall } from './floorPlanTypes'
import { directionToYRotation } from './floorPlanUtils'

/**
 * floor-14.json gives each wall only a centerline (`a` -> `b`) and a height, no thickness, so
 * this is a reasonable constant for a demo partition wall (~drywall/glass-partition thickness).
 */
const WALL_THICKNESS = 0.15

const GLASS_COLOR = '#cfe8ff'
const SOLID_WALL_COLOR = '#d8d3c8'

/**
 * Extrudes one floor-plan wall segment into a box running from `a` to `b`, `height` meters tall,
 * standing on the floor (base at y=0, matching Floor.tsx's mesh which sits just below y=0 to
 * avoid z-fighting). Coordinate convention matches Floor.tsx/RoomLabels.tsx/AgentInstances.tsx:
 * world (x, z) = floor-plan (x, z) directly, no recentering.
 *
 * BoxGeometry is authored with its length along local +X. To align that with the wall's actual
 * direction in the XZ plane, the mesh is rotated about Y by directionToYRotation(dx, dz), where
 * (dx, dz) is the b-minus-a direction -- see floorPlanUtils.ts for the full derivation of that
 * formula (three.js's Y-axis rotation maps local +X to world (cos(theta), -sin(theta)) in the
 * (x, z) plane, so solving cos(theta) = dx/len and -sin(theta) = dz/len gives that angle).
 */
function Wall({ wall }: { wall: FloorPlanWall }) {
  const { geometry, position, rotationY } = useMemo(() => {
    const [ax, az] = wall.a
    const [bx, bz] = wall.b
    const dx = bx - ax
    const dz = bz - az
    const length = Math.hypot(dx, dz)

    return {
      geometry: new THREE.BoxGeometry(length, wall.height, WALL_THICKNESS),
      position: new THREE.Vector3((ax + bx) / 2, wall.height / 2, (az + bz) / 2),
      rotationY: directionToYRotation(dx, dz),
    }
  }, [wall])

  return (
    <mesh geometry={geometry} position={position} rotation={[0, rotationY, 0]} castShadow receiveShadow>
      {wall.glass ? (
        <meshPhysicalMaterial
          color={GLASS_COLOR}
          transmission={1}
          roughness={0.1}
          thickness={0.05}
          ior={1.5}
          transparent
        />
      ) : (
        <meshStandardMaterial color={SOLID_WALL_COLOR} roughness={0.85} />
      )}
    </mesh>
  )
}

export function Walls({ walls }: { walls: FloorPlanWall[] }) {
  return (
    <>
      {walls.map((wall, i) => (
        // Walls have no stable id in the schema; the note is unique in floor-14.json today but
        // isn't guaranteed to be, so index it too.
        <Wall key={`${wall.note ?? 'wall'}-${i}`} wall={wall} />
      ))}
    </>
  )
}
