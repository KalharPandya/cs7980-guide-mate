import type { BuiltNavMesh } from "../nav/buildNavMesh.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";
import { AGENT_RADIUS_M } from "../nav/agentProfile.js";

/**
 * Deterministic spawn-point layout for the guide-robot fleet (see WorldRoom.ts's
 * `GUIDE_ROBOT_COUNT`). Spawning all N robots on top of each other at the entrance -- the
 * bug this replaces, see WorldRoom.ts's onCreate() doc comment -- would have every robot
 * interpenetrating at t=0, and Detour's local avoidance would spend the first several
 * ticks shoving them apart into a scrum instead of the fleet reading as "already spread
 * out and ready to guide" the instant the demo starts.
 *
 * Approach: lay a fixed-step grid over the walkable floor's bounding box (derived from
 * `plan.walkableOutline`), snap every grid point onto the navmesh via
 * `NavMeshQuery.findClosestPoint` (the same snapping `buildNavMesh.ts`'s `findRoomTarget`
 * already relies on), discard any snap that moved too far from where it was asked to land
 * (that means the raw grid point was actually off the walkable area entirely -- inside a
 * wall, in a hole, past the building's edge -- and got pulled onto some unrelated sliver of
 * mesh instead), then greedily accept points in fixed grid-scan order as long as each is at
 * least `MIN_SPACING_M` from every point already accepted.
 *
 * This is entirely deterministic (no `Math.random` -- reproducible startup matters for
 * debugging a 50-robot fleet) and, because the grid spans the whole bounding box rather
 * than radiating out from one point, spreads the fleet across the whole floor rather than
 * clustering it near the entrance/corridor.
 *
 * Tuned against `world/data/floor-14.json` (a ~36m x 21m bounding box): the initial grid
 * step yields 52 on-mesh candidates for 50 requested spawns, spread edge-to-edge across the
 * floor with >2m between neighbors -- comfortable slack over both the requested count and
 * the minimum-spacing requirement.
 */

/** Initial grid step (meters) used to sample candidate spawn points across the floor's
 * bounding box. See this module's doc comment for why this value was chosen against
 * floor-14.json. */
const INITIAL_GRID_STEP_M = 4.0;

/** A raw grid point only counts as "on the navmesh" if `findClosestPoint` snapped it within
 * this fraction of the grid step -- otherwise the point was outside the walkable area and
 * got pulled onto some unrelated, possibly-distant polygon instead. */
const SNAP_TOLERANCE_FACTOR = 0.75;

/** Minimum center-to-center distance enforced between any two chosen spawns. AGENT_RADIUS_M
 * is 0.2m (so 2x = 0.4m is the absolute floor before initial footprints overlap); this uses
 * 3x for margin so Detour's local avoidance doesn't have to immediately shove two
 * just-spawned agents apart on tick 1. */
const MIN_SPACING_M = 3 * AGENT_RADIUS_M;

/** How many times to halve the grid step and retry before giving up. Each halving
 * quadruples the number of raw candidates scanned, so this should never need to go far on
 * any floor plan sized like a real building -- it exists as a safety net for a much
 * smaller/more fragmented floor plan than the one this was tuned against, not because
 * floor-14.json is expected to need it. */
const MAX_GRID_REFINEMENTS = 5;

export interface GuideFleetSpawn {
  x: number;
  z: number;
}

function collectCandidates(plan: FloorPlan, nav: BuiltNavMesh, step: number): GuideFleetSpawn[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of plan.walkableOutline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const tolerance = step * SNAP_TOLERANCE_FACTOR;
  const candidates: GuideFleetSpawn[] = [];

  for (let x = minX; x <= maxX; x += step) {
    for (let z = minZ; z <= maxZ; z += step) {
      const snap = nav.navMeshQuery.findClosestPoint({ x, y: 0, z });
      if (!snap.success) continue;
      if (Math.hypot(snap.point.x - x, snap.point.z - z) > tolerance) continue;
      candidates.push({ x: snap.point.x, z: snap.point.z });
    }
  }

  return candidates;
}

function greedySelect(candidates: GuideFleetSpawn[], count: number): GuideFleetSpawn[] {
  const chosen: GuideFleetSpawn[] = [];
  for (const candidate of candidates) {
    let farEnough = true;
    for (const existing of chosen) {
      if (Math.hypot(candidate.x - existing.x, candidate.z - existing.z) < MIN_SPACING_M) {
        farEnough = false;
        break;
      }
    }
    if (farEnough) chosen.push(candidate);
    if (chosen.length >= count) break;
  }
  return chosen;
}

/**
 * Returns exactly `count` deterministic, navmesh-snapped spawn points, each at least
 * `MIN_SPACING_M` from every other, spread across the walkable floor's bounding box.
 *
 * Throws if `count` points can't be found even after `MAX_GRID_REFINEMENTS` step-halvings --
 * a floor plan too small/fragmented to fit the requested fleet size is a configuration error
 * worth failing loudly on at startup, not silently spawning fewer robots than asked for.
 */
export function computeGuideFleetSpawns(
  plan: FloorPlan,
  nav: BuiltNavMesh,
  count: number,
): GuideFleetSpawn[] {
  let step = INITIAL_GRID_STEP_M;
  for (let attempt = 0; attempt <= MAX_GRID_REFINEMENTS; attempt++) {
    const candidates = collectCandidates(plan, nav, step);
    const chosen = greedySelect(candidates, count);
    if (chosen.length >= count) return chosen;
    step /= 2;
  }

  throw new Error(
    `computeGuideFleetSpawns: could not find ${count} well-spaced navmesh spawn points ` +
      `after ${MAX_GRID_REFINEMENTS} grid refinements (finest step tried: ${step.toFixed(3)}m)`,
  );
}
