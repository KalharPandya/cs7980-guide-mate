import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'

import type { FloorPlan } from './floorPlanTypes'
import { computeOutlineBounds } from './floorPlanUtils'

/**
 * A suggested downtown-Vancouver backdrop that SURROUNDS the indoor floor plan, so orbiting the
 * /viz scene reads as an interior sitting inside a hazy overcast city rather than floating in a
 * white void. Everything here is procedural three.js geometry + materials -- no textures, no
 * external assets -- because the deployed page runs under a strict CSP (see world-client/README
 * and CLAUDE.md: the app is self-contained).
 *
 * It is deliberately a BACKGROUND, never a focus: the towers/mountains sit far beyond the floor
 * bounds and behind fog, use muted cool glass tints dimmer than the lit floor, and never cast
 * shadows onto the floor. The floor plan (walls, labels, agents, route line) always stays the
 * legible thing on top.
 *
 * Coordinate convention: authored in raw floor-plan (x, z) meters exactly like Floor.tsx /
 * Walls.tsx, and mounted INSIDE App.tsx's single <group scale={[1, 1, -1]}> north-up reflection
 * group. That keeps the skyline centered on the SAME building center the floor uses and mirrors
 * with it, so "north" (floor-plan +z) lands at the top of the view for the backdrop too. The sky
 * dome, ground disc and tower ring are all radially symmetric or centered on that point, so the
 * z reflection does not distort them. Fog is a scene-global (not a group-local) property, so it
 * is set imperatively on the scene via useThree rather than as a <fog> element that would attach
 * to the enclosing group instead of the scene.
 *
 * All tunable look constants are named below so a visual review can adjust them without hunting
 * through JSX. Sizes are expressed as multiples of the floor's own half-extent (derived from the
 * floor data at runtime, never hardcoded) so the backdrop rescales if floor-14.json changes.
 */

/* --------------------------------------------------------------------------------------------- */
/* Palette (overcast Vancouver: pale cool blues, blue-green-grey glass, desaturated far ridges).  */
/* --------------------------------------------------------------------------------------------- */

/** Sky gradient: saturated-ish pale blue overhead fading to a near-white cool horizon. */
const SKY_TOP_COLOR = '#8fb0c9'
/** Horizon band of the sky dome AND the fog color -- kept identical so distant towers fade into
 *  the sky seamlessly instead of against a mismatched band. */
const HORIZON_COLOR = '#d6e1e8'

/** Cool blue-green-grey glass tints for the tower ring; one is picked per tower (seeded). */
const TOWER_COLORS = ['#6f8ea3', '#7f9aa6', '#8aa6ad', '#749ba0', '#9ab0b6'] as const
/** Slight cool emissive so towers read as glass catching the flat overcast light, not dead boxes. */
const TOWER_EMISSIVE = '#22323c'
/** Lighter "crown" cap on each tower, a touch of glow so the tops catch the sky. */
const CROWN_COLOR = '#c6d6dc'
const CROWN_EMISSIVE = '#9fb8c0'

/** Distant North-Shore ridge: dark, desaturated blue-grey; the far layer is a hair lighter/hazier. */
const MOUNTAIN_NEAR_COLOR = '#475764'
const MOUNTAIN_FAR_COLOR = '#5a6a76'

/** Muted ground/water hint under the towers so they do not float. */
const GROUND_COLOR = '#9fb0ba'

/* --------------------------------------------------------------------------------------------- */
/* Elevation. The rendered floor plan is the building's 14TH FLOOR, so the whole city is built     */
/* relative to that height instead of at street level.                                             */
/* --------------------------------------------------------------------------------------------- */

/** The floor plan we render (walls/agents/route) is the building's 14th floor: roughly 13 storeys
 *  at ~3.5 m each above the street (~45 m). The floor slab itself stays at y=0 (do NOT move it);
 *  instead the surrounding city is built DOWN to the street at y = -FLOOR_ELEVATION_M and UP around
 *  this elevated floor, so orbiting reads as "up high on the 14th floor" -- street + tower bases far
 *  below, tower mid-sections at eye level, tops rising above, mountains beyond. Single named
 *  constant so the whole sense of height is one knob to tune after a visual review. Meters. */
const FLOOR_ELEVATION_M = 45

/* --------------------------------------------------------------------------------------------- */
/* Layout multipliers (of the floor's half-extent HALF). Tune these after a visual review.        */
/* --------------------------------------------------------------------------------------------- */

/** Tower ring band: inner edge at 1.7x, outer edge at 3.0x the floor half-extent out from center,
 *  i.e. always BEYOND the floor bounds (the prompt's ~1.5x-3x "encircle it" range). Horizontal
 *  only -- unchanged by the elevation work, which is purely vertical. */
const RING_INNER_MULT = 1.7
const RING_OUTER_MULT = 3.0
/** How many towers ring the floor. A few dozen: dense enough to read as downtown, cheap enough
 *  to draw as plain meshes sharing one box geometry + a handful of materials. */
const TOWER_COUNT = 46
/** Chance a given tower is a tall "landmark" spire rather than a mid-rise. */
const LANDMARK_CHANCE = 0.16

/** Tower HEIGHTS in absolute meters (downtown Vancouver runs ~100-200 m). Every tower BASE sits at
 *  the street (y = -FLOOR_ELEVATION_M), so with the floor plane at y=0 a mid-rise of ~110 m tops out
 *  at +65 m: you are surrounded by tower mid-sections, many crowns land ABOVE the floor, and the
 *  bases drop far below. Landmarks are the taller spires. Tuned so a good share of tops clear y=0. */
const TOWER_HEIGHT_MIN_M = 55
const TOWER_HEIGHT_MAX_M = 170
const LANDMARK_HEIGHT_MIN_M = 170
const LANDMARK_HEIGHT_MAX_M = 210

/** North-Shore ridge peak heights in absolute meters. The ridge base sits at the street
 *  (MOUNTAIN_BASE_Y) and peaks rise well above the floor plane so, from the elevated floor, the
 *  ridge reads BEHIND and slightly ABOVE the tower tops rather than buried below. Far layer taller
 *  so it stacks behind the near one. (These are backdrop-scaled, not real 1000 m+ mountains: the
 *  towers are only ~200 m here, so the ridge just needs to clear them.) */
const MOUNTAIN_BASE_Y = -FLOOR_ELEVATION_M
const MOUNTAIN_NEAR_PEAK_M = 190
const MOUNTAIN_FAR_PEAK_M = 240

/** Distances (x HALF) of the two ridge layers and the ground disc / sky dome radii. */
const MOUNTAIN_NEAR_DIST_MULT = 3.4
const MOUNTAIN_FAR_DIST_MULT = 4.3
const GROUND_RADIUS_MULT = 7.0
/** Sky dome radius (x HALF). Bumped up from 11x so the dome still encloses the now much deeper
 *  scene: the street/tower bases at -FLOOR_ELEVATION_M and the tall towers + ridge above y=0. */
const SKY_RADIUS_MULT = 13.0

/** Linear fog: floor + near towers stay crisp inside `near`, the skyline fades out toward `far`.
 *  Pushed out (from 2.8/6.5) for the now taller/deeper scene so the FLOOR PLAN near the camera
 *  stays crisp and un-fogged while the far street below and distant towers/ridge haze out. */
const FOG_NEAR_MULT = 3.2
const FOG_FAR_MULT = 8.5

/* --------------------------------------------------------------------------------------------- */
/* Shared, bounds-independent geometry + materials (module scope, matching Walls.tsx's pattern of  */
/* one material instance reused across many meshes instead of one per <mesh>).                     */
/* --------------------------------------------------------------------------------------------- */

/** Unit cube centered at the origin; each tower/crown scales + positions it (so 46 towers share
 *  ONE geometry rather than allocating 46 BoxGeometries). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
/** Unit sphere for the sky dome, scaled to SKY_RADIUS. */
const UNIT_SPHERE = new THREE.SphereGeometry(1, 32, 16)
/** Unit-radius disc for the ground/water hint, laid flat and scaled to GROUND_RADIUS. */
const UNIT_DISC = new THREE.CircleGeometry(1, 48)

const TOWER_MATERIALS = TOWER_COLORS.map(
  (c) =>
    new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.4,
      metalness: 0.2,
      emissive: new THREE.Color(TOWER_EMISSIVE),
      emissiveIntensity: 0.35,
    }),
)

const CROWN_MATERIAL = new THREE.MeshStandardMaterial({
  color: CROWN_COLOR,
  roughness: 0.3,
  metalness: 0.25,
  emissive: new THREE.Color(CROWN_EMISSIVE),
  emissiveIntensity: 0.45,
})

const GROUND_MATERIAL = new THREE.MeshStandardMaterial({
  color: GROUND_COLOR,
  roughness: 1,
  metalness: 0,
})

const MOUNTAIN_NEAR_MATERIAL = new THREE.MeshBasicMaterial({
  color: MOUNTAIN_NEAR_COLOR,
  side: THREE.DoubleSide,
})
const MOUNTAIN_FAR_MATERIAL = new THREE.MeshBasicMaterial({
  color: MOUNTAIN_FAR_COLOR,
  side: THREE.DoubleSide,
})

/**
 * Vertical-gradient sky dome material. A raw ShaderMaterial (GLSL1, so gl_FragColor is correct)
 * with no fog chunks, so the dome itself is never fogged -- only the towers/mountains in front of
 * it fade, INTO this dome's horizon color. BackSide so we see it from inside; depthWrite off and a
 * very negative renderOrder so it is always the farthest thing behind the scene.
 */
const SKY_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    topColor: { value: new THREE.Color(SKY_TOP_COLOR) },
    horizonColor: { value: new THREE.Color(HORIZON_COLOR) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vLocalPos;
    void main() {
      vLocalPos = position; // unit sphere: y in [-1, 1]
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    varying vec3 vLocalPos;
    void main() {
      // 0 at/below the equator (horizon), 1 straight up. pow() lifts the horizon band so the
      // pale color sits low and most of the dome is the cooler top color.
      float h = clamp(vLocalPos.y, 0.0, 1.0);
      float t = pow(h, 0.5);
      gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
})

/* --------------------------------------------------------------------------------------------- */
/* Seeded PRNG so the skyline is IDENTICAL across reloads / re-renders (no Math.random at render). */
/* --------------------------------------------------------------------------------------------- */

/** mulberry32: tiny deterministic PRNG. Same seed -> same skyline, every reload. */
function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Tower {
  x: number
  z: number
  width: number
  depth: number
  height: number
  matIndex: number
}

/**
 * Builds one jagged ridge ShapeGeometry in a local XY plane (x horizontal centered on 0, y up),
 * with a flat baseline dropped below y=0 so the ridge never shows a gap at its foot. Peaks come
 * from the seeded PRNG so the silhouette is stable.
 */
function buildRidgeGeometry(
  rng: () => number,
  width: number,
  maxPeak: number,
  segments: number,
): THREE.ShapeGeometry {
  const half = width / 2
  const foot = -maxPeak // extend well below ground so the base is never visible
  const shape = new THREE.Shape()
  shape.moveTo(-half, foot)
  shape.lineTo(-half, 0)
  for (let i = 0; i <= segments; i++) {
    const x = -half + (i / segments) * width
    // A blend of a broad hump (so the ridge rises toward its middle) and per-vertex noise, with an
    // occasional taller peak. Never below a small floor so the ridge line stays continuous.
    const hump = Math.sin((i / segments) * Math.PI)
    const spike = rng() < 0.22 ? 1.0 : 0.55 + rng() * 0.35
    const y = maxPeak * Math.max(0.12, hump * spike)
    shape.lineTo(x, y)
  }
  shape.lineTo(half, 0)
  shape.lineTo(half, foot)
  shape.closePath()
  return new THREE.ShapeGeometry(shape)
}

export function Skyline({ floorPlan }: { floorPlan: FloorPlan }) {
  const scene = useThree((state) => state.scene)

  // Floor bounds derived from the SAME data/util the camera framing uses (computeOutlineBounds on
  // walkableOutline), so the ring is sized to the real footprint, not a guess.
  const bounds = useMemo(() => computeOutlineBounds(floorPlan.walkableOutline), [floorPlan])
  const half = Math.max(bounds.sizeX, bounds.sizeZ) / 2

  // Scene-global fog. Set imperatively (see the file header for why it cannot be a <fog> element
  // inside the reflection group) and restored on unmount so nothing else inherits it.
  useEffect(() => {
    const previous = scene.fog
    scene.fog = new THREE.Fog(HORIZON_COLOR, half * FOG_NEAR_MULT, half * FOG_FAR_MULT)
    return () => {
      scene.fog = previous
    }
  }, [scene, half])

  const { towers, ridgeNear, ridgeFar } = useMemo(() => {
    const rng = mulberry32(0x5eed1234)
    const ringInner = half * RING_INNER_MULT
    const ringOuter = half * RING_OUTER_MULT

    const towers: Tower[] = []
    for (let i = 0; i < TOWER_COUNT; i++) {
      // Even angular spread + jitter so towers encircle the floor fully -- skyline is visible
      // behind the building from any orbit angle -- without a gridded look.
      const angle = (i / TOWER_COUNT) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / TOWER_COUNT) * 1.6
      const radius = ringInner + rng() * (ringOuter - ringInner)
      const landmark = rng() < LANDMARK_CHANCE
      // Vancouver is slender glass towers: tall relative to their small footprint. Absolute-meter
      // heights (not HALF-scaled) so the vertical drama is calibrated to the 45 m floor elevation.
      const height = landmark
        ? LANDMARK_HEIGHT_MIN_M + rng() * (LANDMARK_HEIGHT_MAX_M - LANDMARK_HEIGHT_MIN_M)
        : TOWER_HEIGHT_MIN_M + rng() * (TOWER_HEIGHT_MAX_M - TOWER_HEIGHT_MIN_M)
      const width = 2.6 + rng() * 3.4
      const depth = 2.6 + rng() * 3.4
      towers.push({
        x: bounds.centerX + Math.cos(angle) * radius,
        z: bounds.centerZ + Math.sin(angle) * radius,
        width,
        depth,
        height,
        matIndex: Math.floor(rng() * TOWER_MATERIALS.length),
      })
    }

    const ridgeNear = buildRidgeGeometry(rng, half * 6.5, MOUNTAIN_NEAR_PEAK_M, 26)
    const ridgeFar = buildRidgeGeometry(rng, half * 8.0, MOUNTAIN_FAR_PEAK_M, 22)
    return { towers, ridgeNear, ridgeFar }
  }, [bounds, half])

  // Dispose the per-layout ridge geometries when the layout changes / unmounts. (The shared
  // module-scope geometries + materials live for the app's lifetime, matching Walls.tsx.)
  useEffect(() => {
    return () => {
      ridgeNear.dispose()
      ridgeFar.dispose()
    }
  }, [ridgeNear, ridgeFar])

  const skyRadius = half * SKY_RADIUS_MULT
  const groundRadius = half * GROUND_RADIUS_MULT
  const mountainNearDist = half * MOUNTAIN_NEAR_DIST_MULT
  const mountainFarDist = half * MOUNTAIN_FAR_DIST_MULT

  return (
    <group>
      {/* Sky dome: farthest thing, drawn behind everything (renderOrder) and centered on the
          building so the gradient horizon sits level all around. */}
      <mesh
        geometry={UNIT_SPHERE}
        material={SKY_MATERIAL}
        position={[bounds.centerX, 0, bounds.centerZ]}
        scale={[skyRadius, skyRadius, skyRadius]}
        renderOrder={-10}
        frustumCulled={false}
      />

      {/* Muted ground/water hint so the towers do not float. Sits at the STREET, a full
          FLOOR_ELEVATION_M below the floor slab, so it reads as the ground far below the 14th
          floor; its far edge fades into the fog. */}
      <mesh
        geometry={UNIT_DISC}
        material={GROUND_MATERIAL}
        position={[bounds.centerX, -FLOOR_ELEVATION_M, bounds.centerZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[groundRadius, groundRadius, groundRadius]}
        renderOrder={-9}
      />

      {/* North-Shore ridge silhouette on one side (floor-plan +z / north), two layers for depth;
          unlit (MeshBasic) + fog so distance desaturates them toward the horizon. Rotated 180 so
          the DoubleSide face reads from the default south-ish camera; DoubleSide makes orbit safe.
          Base dropped to the street (MOUNTAIN_BASE_Y) with tall peaks, so from the elevated floor
          the ridge rises from near the horizon and reads BEHIND and slightly ABOVE the towers. */}
      <mesh
        geometry={ridgeNear}
        material={MOUNTAIN_NEAR_MATERIAL}
        position={[bounds.centerX, MOUNTAIN_BASE_Y, bounds.centerZ + mountainNearDist]}
        rotation={[0, Math.PI, 0]}
      />
      <mesh
        geometry={ridgeFar}
        material={MOUNTAIN_FAR_MATERIAL}
        position={[bounds.centerX, MOUNTAIN_BASE_Y, bounds.centerZ + mountainFarDist]}
        rotation={[0, Math.PI, 0]}
      />

      {/* The tower ring. Each tower is the shared unit box scaled to (width, height, depth) with its
          BASE at the street (y = -FLOOR_ELEVATION_M) so it rises from far below the floor, up past
          the floor plane (y=0) and above it; a lighter crown cap at the very top catches the sky.
          None cast shadows (they are far and must never darken the floor) and none receive shadows. */}
      {towers.map((t, i) => (
        <group key={i}>
          <mesh
            geometry={UNIT_BOX}
            material={TOWER_MATERIALS[t.matIndex]}
            position={[t.x, -FLOOR_ELEVATION_M + t.height / 2, t.z]}
            scale={[t.width, t.height, t.depth]}
            castShadow={false}
            receiveShadow={false}
          />
          <mesh
            geometry={UNIT_BOX}
            material={CROWN_MATERIAL}
            position={[t.x, -FLOOR_ELEVATION_M + t.height + 0.35, t.z]}
            scale={[t.width * 0.72, 0.7, t.depth * 0.72]}
            castShadow={false}
            receiveShadow={false}
          />
        </group>
      ))}
    </group>
  )
}
