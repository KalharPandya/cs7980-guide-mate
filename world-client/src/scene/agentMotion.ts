import * as THREE from 'three'

/**
 * Per-second easing rate used to smooth an agent's rendered (x, z) position toward its latest
 * synced snapshot. The world-server patches state at ~20Hz while the client renders at ~60fps
 * (see Robot.tsx/Visitor.tsx), so snapping straight to each new snapshot on arrival would look
 * jittery -- position eases toward it instead. Higher = snappier/less smoothing, lower = more lag
 * but smoother motion. `6` was picked so a full correction settles in well under a second at
 * 60fps without looking sluggish.
 */
export const POSITION_LERP_RATE = 6

/**
 * Eases `object3D`'s (x, z) position toward (targetX, targetZ) at POSITION_LERP_RATE,
 * framerate-independent via `delta` (seconds since the last frame, from useFrame). Shared by
 * Robot.tsx's RobotInstance and Visitor.tsx's VisitorInstance, which both drive a live
 * AgentSnapshot's position onto a three.js object every frame identically -- only what's being
 * moved (an <Instance>'s transform vs. a SkeletonUtils clone's root) differs between them.
 */
export function lerpXZToward(object3D: THREE.Object3D, targetX: number, targetZ: number, delta: number): void {
  const lerpFactor = Math.min(delta * POSITION_LERP_RATE, 1)
  object3D.position.x = THREE.MathUtils.lerp(object3D.position.x, targetX, lerpFactor)
  object3D.position.z = THREE.MathUtils.lerp(object3D.position.z, targetZ, lerpFactor)
}
