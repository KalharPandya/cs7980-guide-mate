import { useMemo } from 'react'
import * as THREE from 'three'

import type { FloorPlanWall, Point2D } from './floorPlanTypes'
import {
  computeWallPlacement,
  directionToYRotation,
  polygonSignedArea,
  tallestWallHeight,
} from './floorPlanUtils'

const GLASS_COLOR = '#cfe8ff'
const SOLID_WALL_COLOR = '#d8d3c8'

/**
 * Shared materials, one instance each for every glass wall / every solid wall (module scope,
 * not per-<Wall> JSX). floor-14.json has 8 glass segments and 116 solid segments; declaring
 * the material as a JSX child of each <mesh> (the previous approach) makes three.js/R3F
 * instantiate a separate material object per wall -- 124 material objects where 2 suffice,
 * since every glass wall shares identical parameters and every solid wall shares identical
 * parameters. The design spec (docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md)
 * asks for exactly this sharing.
 *
 * Investigated whether three.js's transmission pass itself scales with instance count (0.185.1,
 * WebGLRenderer.js): renderTransmissionPass runs ONCE per frame per camera regardless of how
 * many transmissive materials exist -- it renders the opaque scene once into a single shared
 * transmissionRenderTarget (cached on currentRenderState.state.transmissionRenderTarget[camera.id]),
 * then each transmissive object's normal forward draw call samples that one texture. So this is
 * NOT the per-instance-FBO cost the spec warns about for drei's MeshTransmissionMaterial (that
 * component allocates its own FBO per mesh instance); plain meshPhysicalMaterial with
 * transmission does not have that failure mode. The 124-vs-2 instance count still costs real
 * memory (separate uniforms/WebGLProperties entries per material) and is what the spec asked to
 * avoid, so it is still worth hoisting -- just not for the reason of duplicating the transmission
 * FBO pass.
 *
 * Values are byte-identical to the removed inline JSX materials. Colors are set via the material
 * constructor's `color` param, which three.js's Material.setValues special-cases: when the
 * current property value isColor, it calls `.set(newValue)` rather than overwriting the Color
 * instance (Material.js) -- the exact same path @react-three/fiber's applyProps uses for a JSX
 * `color={...}` prop (isColor target -> target.set(value)), so there is no conversion difference.
 *
 * Passed to <mesh> via the `material` prop, NOT as a JSX child. This matters for lifecycle: R3F's
 * reconciler only disposes objects that exist as fiber-tree children (removeChild disposes
 * child.object when child.props.dispose !== null and the object came from a JSX child instance);
 * an object merely assigned to an instance prop like `material={...}` is never entered into the
 * fiber tree and is therefore never a disposal target. Declaring the material as a JSX child (the
 * previous form) would have made R3F dispose the shared instance when any single wall unmounted,
 * silently breaking every other wall's material. Passing it as a prop avoids that trap entirely.
 */
export const GLASS_MATERIAL = new THREE.MeshPhysicalMaterial({
  color: GLASS_COLOR,
  transmission: 1,
  roughness: 0.1,
  thickness: 0.05,
  ior: 1.5,
  transparent: true,
})

export const SOLID_MATERIAL = new THREE.MeshStandardMaterial({
  color: SOLID_WALL_COLOR,
  roughness: 0.85,
})

/**
 * Extrudes one floor-plan wall segment into a box running from `a` to `b`, `height` meters tall,
 * standing on the floor (base at y=0, matching Floor.tsx's mesh which sits just below y=0 to
 * avoid z-fighting). Coordinate convention matches Floor.tsx/RoomLabels.tsx/AgentInstances.tsx:
 * geometry is authored in raw floor-plan (x, z) meters, no recentering; App.tsx's single
 * <group scale={[1, 1, -1]}> then reflects floor-plan z (north) to world -z so the top-down
 * view reads north-up like the exit map, with every in-scene component reflecting together.
 *
 * BoxGeometry is authored with its length along local +X. To align that with the wall's actual
 * direction in the XZ plane, the mesh is rotated about Y by directionToYRotation(dx, dz), where
 * (dx, dz) is the b-minus-a direction -- see floorPlanUtils.ts for the full derivation of that
 * formula (three.js's Y-axis rotation maps local +X to world (cos(theta), -sin(theta)) in the
 * (x, z) plane, so solving cos(theta) = dx/len and -sin(theta) = dz/len gives that angle).
 *
 * The box's DEPTH (thickness) and its exact center are no longer a single constant: they come from
 * computeWallPlacement, which classifies each wall from the plan data alone (envelope vs glass pane
 * vs full-height interior vs short partition) and insets envelope walls so the thicker exterior
 * assembly grows inward instead of overhanging the floor slab. See floorPlanUtils.ts's WallClass
 * and OUTLINE_WALL_OUTER_FACE_OVERHANG_M doc comments for the whole scheme and its justification.
 */
function Wall({
  wall,
  outline,
  tallest,
  signedArea,
}: {
  wall: FloorPlanWall
  outline: Point2D[]
  tallest: number
  signedArea: number
}) {
  const { geometry, position, rotationY } = useMemo(() => {
    const [ax, az] = wall.a
    const [bx, bz] = wall.b
    const dx = bx - ax
    const dz = bz - az
    const length = Math.hypot(dx, dz)
    const placement = computeWallPlacement(wall, outline, tallest, signedArea)

    return {
      geometry: new THREE.BoxGeometry(length, wall.height, placement.thickness),
      position: new THREE.Vector3(placement.center[0], wall.height / 2, placement.center[1]),
      rotationY: directionToYRotation(dx, dz),
    }
  }, [wall, outline, tallest, signedArea])

  return (
    <mesh
      geometry={geometry}
      position={position}
      rotation={[0, rotationY, 0]}
      material={wall.glass ? GLASS_MATERIAL : SOLID_MATERIAL}
      // three.js's shadow map is a depth-only pass: it has no idea GLASS_MATERIAL is transparent
      // (transmission=1) and would otherwise cast the exact same full-opacity box shadow as a
      // solid wall -- physically wrong for a pane of glass, and (found during the App.tsx
      // background-color visual-QA fix, 2026-08-02) part of what read as a stray dark patch on
      // the floor beyond the Kitchen/1407/1408 glass front. receiveShadow stays true either way:
      // a glass wall standing in another wall's shadow should still visibly darken.
      castShadow={!wall.glass}
      receiveShadow
    />
  )
}

/**
 * `walkableOutline` is taken as a prop (rather than each <Wall> reaching for the whole FloorPlan)
 * because the thickness hierarchy needs to know which walls ARE the building envelope, and that is
 * only knowable by comparing a wall against the outline. The outline's winding (signedArea) and the
 * plan's tallest wall height are computed ONCE here and passed down, not recomputed per wall: both
 * are whole-plan properties, and floor-14.json has 79 walls against a 20-vertex outline.
 */
export function Walls({ walls, walkableOutline }: { walls: FloorPlanWall[]; walkableOutline: Point2D[] }) {
  const tallest = useMemo(() => tallestWallHeight(walls), [walls])
  const signedArea = useMemo(() => polygonSignedArea(walkableOutline), [walkableOutline])

  return (
    <>
      {walls.map((wall, i) => (
        // Walls have no stable id in the schema; the note is unique in floor-14.json today but
        // isn't guaranteed to be, so index it too.
        <Wall
          key={`${wall.note ?? 'wall'}-${i}`}
          wall={wall}
          outline={walkableOutline}
          tallest={tallest}
          signedArea={signedArea}
        />
      ))}
    </>
  )
}
