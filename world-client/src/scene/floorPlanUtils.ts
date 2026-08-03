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
