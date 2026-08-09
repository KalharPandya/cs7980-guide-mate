import type { FloorPlanWall, Point2D } from './floorPlanTypes'

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
 *
 * VERIFIED 2026-08-02 (doc-comment audit follow-up) by parsing both GLBs' raw glTF JSON/binary
 * directly (no rendering needed -- see the throwaway scripts used, since deleted; this comment
 * is the durable record) and, separately, loading them with the project's own installed
 * three.js `GLTFLoader` in Node to reuse three's canonical (battle-tested) skinning/animation
 * math rather than hand-rolling it:
 *
 * - `robot.glb` (three.js example "RobotExpressive"): forward is +Z, measured on the REST POSE
 *   -- the only pose that matters here, since modelBake.ts freezes exactly the freshly-parsed,
 *   never-animated scene graph into one static geometry; no animation clip ever touches a robot
 *   instance. Four converging signals, all agreeing: (1) the `FootL`/`FootR` bone to its
 *   `..._end` tip -- the closest thing this rig has to a toe -- points almost purely +Z
 *   (e.g. `FootL` (0.63, 0.02, -0.14) -> `FootL_end` (0.63, 0.01, 0.19), i.e. delta ~(0, -0.01,
 *   +0.33)); (2) the rig's own `PoleTargetL`/`PoleTargetR` bones -- IK pole targets the original
 *   rig author placed by hand to define which way the knee bends -- sit far out along +Z ahead
 *   of the knee (knee Z~0.16 vs pole-target Z~1.51); (3) the visible foot mesh's bounding box is
 *   long along Z and short along X/Y, matching a foot's natural heel-to-toe axis; (4) the whole
 *   body's precise (skin-aware) bounding box is narrower in Z (2.69) than X (3.10), i.e. Z is
 *   the sagittal (front-to-back) axis. No hidden node/scene rotation exists between the raw
 *   asset and modelBake.ts -- it applies each mesh's `matrixWorld` as-authored and never rotates
 *   anything.
 *
 * - `visitor.glb` (Quaternius CC0 human): forward is ALSO +Z, but the evidence path is
 *   different because this rig IS animated (Visitor.tsx always has either the Idle or Walk clip
 *   playing from the first frame -- see VisitorInstance). The static default pose baked into the
 *   node hierarchy is a red herring: `Hips`'s default rotation carries a spurious ~43 degree
 *   yaw (quaternion [-0.0388, -0.3703, -0.0157, 0.9280]: angle 43.75 deg, rotation axis 99.4% aligned with Y -- an earlier revision of this comment said ~84%, which was wrong; recomputed from the raw GLB node), most likely a stray keyframe
 *   captured as the file's "default" rather than a true bind/T-pose -- and EVERY clip (Idle
 *   included) has its own `Hips -> quaternion` track, so that skew is fully overridden from
 *   frame 0 and is never actually what's rendered. Naively measuring the rest-pose
 *   foot-to-toe vector is therefore misleading (it comes out dominant -X, an artifact of that
 *   skew) and was discarded. Sampling the Walk clip itself instead, two independent,
 *   mutually-agreeing methods both give +Z: (1) the vector from `LeftFoot`/`RightFoot` to
 *   `LeftToeBase`/`RightToeBase` while that foot is planted (world Y near the cycle minimum) --
 *   (0.01, 1.00) and (-0.09/0.11, 0.99/0.99) per foot; (2) the standard IK "pole vector"
 *   technique (perpendicular deviation of the knee from the straight hip-ankle chord, at the
 *   frame of maximum flexion -- a human/rigged knee only ever bends toward the front) -- (0.02,
 *   1.00) combined, (0.21, 0.98) and (-0.18, 0.98) per leg. A third, cruder check (extrapolating
 *   the thigh direction past the knee) gave a conflicting -Z and was discarded: unlike the pole
 *   vector, it isn't invariant to hip ab/adduction and produces noise at high flexion angles.
 *   The precise skin-aware body bbox is also (weakly) consistent: Z (2.29) is the slightly
 *   narrower horizontal axis vs X (2.33), matching Z as the sagittal axis.
 *
 * Verdict: the code's +Z assumption is CORRECT for both models. No rotation math changed.
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

/** A plain (x, y, z) vector -- not THREE.Vector3, so this file can stay three.js-free and stay
 * importable by the plain node:assert test scripts without a WebGL/three dependency. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * Camera-framing fix (visual QA, 2026-08-02): App.tsx used to place the camera at a fixed offset
 * derived from the floor's bounds (`bounds.sizeX * 0.45` etc, no regard for the camera's fov or
 * the viewport's aspect ratio), which is why on a 1600x900 capture the building filled only the
 * middle band of the screen -- the offset was simply pulled back much farther than the frustum
 * at that fov/aspect actually required. This computes, instead, the SMALLEST distance along a
 * given fixed viewing direction that still keeps every point of `outline` (each vertex extruded
 * from `minHeight` to `maxHeight`, to also cover the walls standing on it) inside a perspective
 * camera's frustum, for a given vertical fov/aspect, with `margin` held back as blank space on
 * every side (0 = geometry touches the frame edge, 1 = degenerate/infinite distance).
 *
 * Fits the outline polygon's OWN vertices, not its axis-aligned bounding box: floor-14.json's
 * footprint is a non-convex "pinwheel" (see cameraFraming.test.ts's doc comment), so the AABB's
 * own corners routinely land on points nowhere near the real building (e.g. (maxX, maxZ) here is
 * a corner of empty space -- maxX and maxZ each come from a DIFFERENT, unrelated outline vertex).
 * A first version of this function fit the AABB's 8 corners and was strictly worse than the
 * original hand-tuned camera: that phantom corner sits almost directly in the camera's own
 * viewing direction, so it's simultaneously very close to the camera AND has a large lateral
 * offset, demanding far more distance than the real, non-convex building ever needed. Fitting the
 * outline's actual vertices instead tracks the real shape. This relies on the same containment
 * property cameraFraming.test.ts already pins (every wall endpoint / room center+door / entrance
 * point lies within `CONTAINMENT_SLACK_M` of the outline) rather than re-deriving it here -- see
 * that test for why walls/rooms/entrance don't need to be fit separately.
 *
 * The math: place the camera at `target - forward * d` for unknown distance d (forward is the
 * unit vector from camera to target, i.e. the negation of `direction`). For each of the outline's
 * vertices extruded to minHeight/maxHeight, its position relative to target decomposes (via the
 * camera's right/up/forward basis) into (viewX, viewY, viewZ); its depth from the camera is then
 * `d + viewZ`. The frustum's half-width/half-height at that depth are
 * `depth * tan(fovY/2) * aspect` and `depth * tan(fovY/2)` (shrunk by `1 - margin`). Requiring
 * |viewX| and |viewY| to stay within those bounds, for every point, rearranges into a lower bound
 * on d; the largest such bound across every point and both axes is the tightest distance that
 * still fits everything.
 */
export function fitDistanceAlongDirection(
  outline: Point2D[],
  target: { x: number; z: number },
  minHeight: number,
  maxHeight: number,
  direction: Vec3,
  fovYDeg: number,
  aspect: number,
  margin: number,
): number {
  const forward = normalize({ x: -direction.x, y: -direction.y, z: -direction.z })
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 }
  const right = normalize(cross(forward, worldUp))
  const camUp = cross(right, forward)

  const halfFovYRad = (fovYDeg * Math.PI) / 180 / 2
  const kY = Math.tan(halfFovYRad) * (1 - margin)
  const kX = kY * aspect

  let requiredDistance = 0.5 // sane positive floor; never returns a non-positive/degenerate distance
  for (const [x, z] of outline) {
    for (const y of [minHeight, maxHeight]) {
      const rel: Vec3 = { x: x - target.x, y, z: z - target.z }
      const viewX = dot(rel, right)
      const viewY = dot(rel, camUp)
      const viewZ = dot(rel, forward)

      const dNeededX = Math.abs(viewX) / kX - viewZ
      const dNeededY = Math.abs(viewY) / kY - viewZ
      requiredDistance = Math.max(requiredDistance, dNeededX, dNeededY)
    }
  }

  return requiredDistance
}

/** `target + normalize(direction) * distance` -- the companion to fitDistanceAlongDirection:
 * that function returns a scalar distance along a direction whose magnitude doesn't matter (it
 * normalizes internally), so callers need this to turn (target, direction, distance) back into
 * an actual world-space camera position without duplicating the normalize step themselves. */
export function positionAlongDirection(target: Vec3, direction: Vec3, distance: number): Vec3 {
  const dirUnit = normalize(direction)
  return {
    x: target.x + dirUnit.x * distance,
    y: target.y + dirUnit.y * distance,
    z: target.z + dirUnit.z * distance,
  }
}

export interface CameraFraming {
  /** Where the camera looks -- also what App.tsx passes to <MapControls target=...>, so this
   * doubles as the orbit pivot. Always on the y=0 (floor) plane: see the loop below for why. */
  target: Vec3
  position: Vec3
}

/**
 * fitDistanceAlongDirection alone (aiming at `anchor`, the outline's raw bounding-box center)
 * still left the framing visibly lopsided: verified against floor-14.json by projecting through a
 * real THREE.PerspectiveCamera, that combination put the building's bottom edge within 0.1% of
 * the frame's bottom edge while leaving ~16% completely empty at the top, and ~20% empty on BOTH
 * left and right (a lopsided top gap, not the symmetric margin `margin` asks for). The outline's
 * bounding-box center is not, in general, the center of its own PROJECTED (screen-space) extent
 * for an oblique camera -- those only coincide for a shape that's symmetric around that center
 * along the view axis, which floor-14.json's non-convex "pinwheel" footprint isn't.
 *
 * This fixes that by also solving for WHERE the camera aims (not just how far back it sits),
 * shifting the aim point within the floor's own (x, z) plane -- never off it, so it stays a
 * sensible <MapControls target> orbit pivot -- until the outline's projected extent is centered
 * in the frame. Each iteration: (1) fitDistanceAlongDirection's own math re-fits the distance for
 * the current aim, (2) every outline vertex (both heights) is projected to normalized device
 * coordinates at that distance to read off how far the projected extent's own center sits from
 * true frame-center (0, 0), (3) a Newton step -- using a numerically-estimated 2x2 Jacobian of
 * that NDC-center error with respect to a small (x, z) aim nudge -- solves for the aim shift that
 * should cancel it. Converges in ~4-5 iterations on floor-14.json (verified: NDC center error
 * drops from ~0.15 to <0.001); capped at MAX_ITERATIONS regardless, so a pathological future
 * floor plan can't hang the render loop -- it would just fall back to whatever the last iteration
 * reached, which is still a valid (if imperfectly centered) fit, never an invalid one.
 */
const CAMERA_FIT_MAX_ITERATIONS = 8
const CAMERA_FIT_NDC_TOLERANCE = 1e-3
const CAMERA_FIT_JACOBIAN_PROBE_M = 0.5

export function fitCameraToOutline(
  outline: Point2D[],
  anchor: { x: number; z: number },
  minHeight: number,
  maxHeight: number,
  direction: Vec3,
  fovYDeg: number,
  aspect: number,
  margin: number,
): CameraFraming {
  // ndcCenter(aim) fits the distance for that aim (reusing fitDistanceAlongDirection) and returns
  // both that distance and how far the resulting projection's extent center sits from (0, 0) in
  // normalized device coordinates -- the two numbers the Newton step below needs.
  const forward = normalize({ x: -direction.x, y: -direction.y, z: -direction.z })
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 }
  const right = normalize(cross(forward, worldUp))
  const camUp = cross(right, forward)
  const halfFovYRad = (fovYDeg * Math.PI) / 180 / 2
  const kY = Math.tan(halfFovYRad) * (1 - margin)
  const kX = kY * aspect

  function fitAndCenter(aim: { x: number; z: number }): { distance: number; ndcCenterX: number; ndcCenterY: number } {
    const distance = fitDistanceAlongDirection(outline, aim, minHeight, maxHeight, direction, fovYDeg, aspect, margin)

    let minNdcX = Infinity
    let maxNdcX = -Infinity
    let minNdcY = Infinity
    let maxNdcY = -Infinity
    for (const [x, z] of outline) {
      for (const y of [minHeight, maxHeight]) {
        const rel: Vec3 = { x: x - aim.x, y, z: z - aim.z }
        const viewX = dot(rel, right)
        const viewY = dot(rel, camUp)
        const viewZ = dot(rel, forward)
        const depth = distance + viewZ
        const ndcX = viewX / (depth * kX)
        const ndcY = viewY / (depth * kY)
        if (ndcX < minNdcX) minNdcX = ndcX
        if (ndcX > maxNdcX) maxNdcX = ndcX
        if (ndcY < minNdcY) minNdcY = ndcY
        if (ndcY > maxNdcY) maxNdcY = ndcY
      }
    }
    return { distance, ndcCenterX: (minNdcX + maxNdcX) / 2, ndcCenterY: (minNdcY + maxNdcY) / 2 }
  }

  let aim = { x: anchor.x, z: anchor.z }
  let distance = 0.5

  for (let iter = 0; iter < CAMERA_FIT_MAX_ITERATIONS; iter++) {
    const at = fitAndCenter(aim)
    distance = at.distance
    if (Math.abs(at.ndcCenterX) < CAMERA_FIT_NDC_TOLERANCE && Math.abs(at.ndcCenterY) < CAMERA_FIT_NDC_TOLERANCE) {
      break
    }

    // Numeric Jacobian of (ndcCenterX, ndcCenterY) with respect to (aim.x, aim.z): probe a small
    // step in each axis independently, take the finite difference, then solve the 2x2 linear
    // system for the (x, z) nudge that should cancel (at.ndcCenterX, at.ndcCenterY) in one step
    // (Newton's method) -- exact for a linear system, and the fixed-point loop above corrects any
    // remaining error from this problem's actual mild non-linearity (perspective depth changes
    // slightly with aim too) over the next iteration(s).
    const eps = CAMERA_FIT_JACOBIAN_PROBE_M
    const probeX = fitAndCenter({ x: aim.x + eps, z: aim.z })
    const probeZ = fitAndCenter({ x: aim.x, z: aim.z + eps })
    const j00 = (probeX.ndcCenterX - at.ndcCenterX) / eps
    const j01 = (probeZ.ndcCenterX - at.ndcCenterX) / eps
    const j10 = (probeX.ndcCenterY - at.ndcCenterY) / eps
    const j11 = (probeZ.ndcCenterY - at.ndcCenterY) / eps
    const determinant = j00 * j11 - j01 * j10
    if (Math.abs(determinant) < 1e-9) break // degenerate Jacobian (shouldn't happen for an oblique
    // view) -- stop rather than divide by ~0 and fling the aim point somewhere absurd.

    const dx = -(j11 * at.ndcCenterX - j01 * at.ndcCenterY) / determinant
    const dz = -(-j10 * at.ndcCenterX + j00 * at.ndcCenterY) / determinant
    aim = { x: aim.x + dx, z: aim.z + dz }
  }

  const target: Vec3 = { x: aim.x, y: 0, z: aim.z }
  return { target, position: positionAlongDirection(target, direction, distance) }
}

/* ---------------------------------------------------------------------------------------------
 * Wall thickness hierarchy (visual QA, 2026-08-09)
 * ------------------------------------------------------------------------------------------ */

/**
 * floor-14.json gives each wall only a centerline (`a` -> `b`), a `height`, and a `glass` flag --
 * no thickness. Walls.tsx used to extrude every one of the 79 segments as the same 0.15m slab,
 * which is what made the render read as a wall DIAGRAM rather than a building: a load-bearing
 * exterior envelope wall and a washroom partition came out visually identical, so the eye got no
 * hierarchy to latch onto. Real construction has one, so these give the render one too.
 *
 * The classes are derived from the data at runtime (see classifyWall), never from hardcoded wall
 * indices, so this keeps working if floor-14.json is re-authored or replaced:
 *
 * - `exterior` 0.30m: the wall lies along `walkableOutline`, i.e. it IS the building envelope.
 *   0.30m is a plausible real exterior assembly (structure + insulation + cladding) and is the
 *   thickest thing on the floor, which is exactly the read we want. Not made thicker than that
 *   because of the overhang problem: these walls are centred ON the outline while the floor slab
 *   STOPS at the outline, so half the thickness hangs past the slab edge. See
 *   OUTLINE_WALL_OUTER_FACE_OVERHANG_M for how that half-overhang is neutralised.
 * - `glass` 0.08m: a glazed panel is a PANE, not an assembly, and is thin whether it sits on the
 *   envelope or inside the floor. So `glass` is checked BEFORE `exterior`, and the one glass
 *   segment that does lie on the outline stays a pane instead of becoming a 0.30m block. Glass
 *   walls stay visually distinct exactly as before (Walls.tsx's GLASS_MATERIAL); thinness only
 *   reinforces that.
 * - `partition` 0.09m: a full-height wall runs floor to structure; a wall authored SHORTER than
 *   the floor's tallest wall is by definition a stub/partition (in floor-14.json today: the 12
 *   washroom partitions at 2.1m against everything else's 2.7m). The threshold is the plan's own
 *   tallest wall height (tallestWallHeight), not a hardcoded 2.7, so a plan authored in different
 *   absolute heights classifies the same way.
 * - `structural` 0.15m: everything else, i.e. full-height interior walls. Deliberately left at the
 *   OLD uniform value so this change only ADDS contrast at the two extremes and never restyles the
 *   bulk of the floor out from under the previously-reviewed look.
 */
export type WallClass = 'exterior' | 'glass' | 'structural' | 'partition'

export const WALL_THICKNESS_M: Record<WallClass, number> = {
  exterior: 0.3,
  glass: 0.08,
  structural: 0.15,
  partition: 0.09,
}

/**
 * The single thickness every wall used before the hierarchy above existed. Retained as a named
 * constant (not folded into WALL_THICKNESS_M.structural) because it also defines the legacy
 * silhouette that OUTLINE_WALL_OUTER_FACE_OVERHANG_M preserves.
 */
export const LEGACY_WALL_THICKNESS_M = 0.15

/**
 * How far an outline wall's OUTER face is allowed to sit past the floor slab's edge, in meters.
 *
 * Walls are authored on their centerline and the floor's ShapeGeometry (Floor.tsx) is cut exactly
 * on `walkableOutline`, so an outline wall of thickness T already overhangs the slab by T/2 with
 * nothing under it. At the old uniform 0.15m that overhang was 0.075m and invisible. At the new
 * 0.30m exterior thickness it would have doubled to 0.15m of wall floating past the slab edge,
 * the "floating ledge" failure mode. Rather than compromise on the exterior thickness, outline
 * walls are INSET: each is shifted along its outline edge's inward normal by
 * `thickness / 2 - OUTLINE_WALL_OUTER_FACE_OVERHANG_M`, which pins the outer face exactly where the
 * old uniform 0.15m wall put it. The building's outer silhouette is therefore unchanged from the
 * previously-reviewed render, and the extra thickness grows INWARD only, where there is floor
 * underneath it to stand on.
 *
 * (The shift is signed, so it also works for classes THINNER than the legacy value: the one glass
 * segment on the outline gets a small negative, i.e. outward, shift, which likewise keeps its outer
 * face on the same plane as every other envelope wall rather than letting a thin pane recess into
 * the facade.)
 */
export const OUTLINE_WALL_OUTER_FACE_OVERHANG_M = LEGACY_WALL_THICKNESS_M / 2

/**
 * How close (in meters) BOTH of a wall's endpoints must sit to a single `walkableOutline` edge for
 * that wall to count as part of the building envelope. Measured against floor-14.json: the match
 * count is 20 walls and does not move anywhere across 0.02m..0.10m (and only picks up a 21st,
 * a clearly-interior glass segment, at 0.20m), so 0.10m sits in the middle of a wide stable
 * plateau: loose enough to absorb the authored geometry's rounding, tight enough not to capture
 * interior walls that merely run near the facade.
 */
export const OUTLINE_MATCH_TOLERANCE_M = 0.1

/** Distance from point (px, pz) to the finite segment (ax, az)-(bx, bz), all in floor-plan meters. */
function pointSegmentDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  // A degenerate (zero-length) outline edge collapses to its own endpoint rather than dividing by 0.
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

/**
 * Shoelace signed area of a closed polygon in the (x, z) plane treated as a standard (X, Y) plane.
 * Only the SIGN is used here, to learn the outline's winding: positive means counter-clockwise,
 * which is what tells computeWallPlacement which side of an edge is "inside".
 */
export function polygonSignedArea(points: Point2D[]): number {
  let doubleArea = 0
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i]
    const [bx, bz] = points[(i + 1) % points.length]
    doubleArea += ax * bz - bx * az
  }
  return doubleArea / 2
}

/**
 * Index of the `walkableOutline` edge this wall lies along, or -1 if it is an interior wall. A wall
 * counts as lying along an edge only when BOTH endpoints are within `tolerance` of that ONE edge.
 * Requiring a single shared edge (rather than "each endpoint is near the outline somewhere") is
 * what stops an interior wall that happens to start and end near two different facades from being
 * misread as part of the envelope.
 */
export function findOutlineEdgeIndex(
  wall: FloorPlanWall,
  outline: Point2D[],
  tolerance: number = OUTLINE_MATCH_TOLERANCE_M,
): number {
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i]
    const [bx, bz] = outline[(i + 1) % outline.length]
    const worstEndpoint = Math.max(
      pointSegmentDistance(wall.a[0], wall.a[1], ax, az, bx, bz),
      pointSegmentDistance(wall.b[0], wall.b[1], ax, az, bx, bz),
    )
    if (worstEndpoint <= tolerance) return i
  }
  return -1
}

/**
 * The tallest `height` in a wall list: the reference a `partition` is measured as shorter than.
 * Falls back to 0 for an empty list so callers never propagate -Infinity into geometry.
 */
export function tallestWallHeight(walls: FloorPlanWall[]): number {
  let tallest = 0
  for (const wall of walls) {
    if (wall.height > tallest) tallest = wall.height
  }
  return tallest
}

/** See WallClass's doc comment for the full reasoning behind this order and each threshold. */
export function classifyWall(
  wall: FloorPlanWall,
  outline: Point2D[],
  tallest: number,
  outlineEdgeIndex: number = findOutlineEdgeIndex(wall, outline),
): WallClass {
  if (wall.glass) return 'glass'
  if (outlineEdgeIndex >= 0) return 'exterior'
  if (wall.height < tallest) return 'partition'
  return 'structural'
}

export interface WallPlacement {
  wallClass: WallClass
  thickness: number
  /** Midpoint of the extruded box, already inset if the wall sits on the outline. Floor-plan meters. */
  center: Point2D
  /** True when this wall lies along `walkableOutline` (i.e. it is part of the building envelope). */
  onOutline: boolean
}

/**
 * Everything Walls.tsx needs to place one wall box: which class it is, how thick to extrude it, and
 * where its center goes once the outline inset (see OUTLINE_WALL_OUTER_FACE_OVERHANG_M) is applied.
 * Kept here rather than in Walls.tsx so it is pure, three.js-free, and directly testable by the
 * package's plain node:assert test scripts without a WebGL context.
 *
 * The inward direction is derived from the OUTLINE EDGE, never from the wall's own a->b direction:
 * a wall may be authored running either way along its edge, so its own direction says nothing about
 * which side the building is on. For a counter-clockwise outline (positive signed area) the interior
 * lies to the LEFT of each directed edge, and the left normal of (dx, dz) is (-dz, dx); a clockwise
 * outline flips that, hence the `sign` factor. Verified against floor-14.json: stepping 0.3m along
 * this normal from the midpoint of all 20 outline edges lands inside the polygon 20/20 times (this
 * is re-asserted in floorGeometry.test.ts, which also covers the clockwise case).
 */
export function computeWallPlacement(
  wall: FloorPlanWall,
  outline: Point2D[],
  tallest: number,
  signedArea: number = polygonSignedArea(outline),
): WallPlacement {
  const outlineEdgeIndex = findOutlineEdgeIndex(wall, outline)
  const wallClass = classifyWall(wall, outline, tallest, outlineEdgeIndex)
  const thickness = WALL_THICKNESS_M[wallClass]

  const midX = (wall.a[0] + wall.b[0]) / 2
  const midZ = (wall.a[1] + wall.b[1]) / 2
  if (outlineEdgeIndex < 0) {
    return { wallClass, thickness, center: [midX, midZ], onOutline: false }
  }

  const [ax, az] = outline[outlineEdgeIndex]
  const [bx, bz] = outline[(outlineEdgeIndex + 1) % outline.length]
  const dx = bx - ax
  const dz = bz - az
  const edgeLength = Math.hypot(dx, dz)
  if (edgeLength === 0) {
    // Degenerate outline edge: no meaningful normal, so leave the wall on its centerline rather
    // than dividing by zero and flinging it to NaN.
    return { wallClass, thickness, center: [midX, midZ], onOutline: true }
  }

  const sign = signedArea > 0 ? 1 : -1
  const inwardX = (sign * -dz) / edgeLength
  const inwardZ = (sign * dx) / edgeLength
  const inset = thickness / 2 - OUTLINE_WALL_OUTER_FACE_OVERHANG_M

  return {
    wallClass,
    thickness,
    center: [midX + inwardX * inset, midZ + inwardZ * inset],
    onOutline: true,
  }
}
