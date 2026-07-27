/**
 * Builds a recast-navigation NavMesh from the floor-plan JSON (see loadFloorPlan.ts).
 *
 * Pipeline:
 *   1. Triangulate `walkableOutline` (minus `holes`) with earcut -> floor triangles at y=0.
 *   2. Emit a vertical quad (2 triangles) per `walls[]` entry, from y=0 to y=`height`.
 *   3. Concatenate positions/indices and hand them to `generateSoloNavMesh`.
 *
 * `recast-navigation` loads a WASM module asynchronously; `init()` must resolve once before
 * any generation call. This module never calls `init()` at module-load time (a top-level
 * `await`/side effect would race any other code that also imports recast-navigation and
 * would silently reuse -- or double-fire -- init depending on import order). Instead
 * `buildNavMesh()` is an async factory: it awaits a module-scoped, memoized init promise,
 * then builds. Safe to call more than once; the underlying `init()` call itself only runs
 * once (recast-navigation's `init()` is idempotent too, but we don't rely on that).
 */
import { init, NavMesh, NavMeshQuery } from "recast-navigation";
import type { SoloNavMeshGeneratorConfig } from "recast-navigation/generators";
import { generateSoloNavMesh } from "recast-navigation/generators";
import earcut from "earcut";

import type { FloorPlan, FloorPlanWall, Point2D } from "./loadFloorPlan.js";
import { loadFloorPlan } from "./loadFloorPlan.js";
import { AGENT_HEIGHT_M, AGENT_RADIUS_M } from "./agentProfile.js";

export interface RoomTarget {
  x: number;
  z: number;
}

export interface BuiltNavMesh {
  navMesh: NavMesh;
  navMeshQuery: NavMeshQuery;
  /**
   * Looks up `rooms[].name`/`aliases` case-insensitively and returns the room's `door`
   * point snapped onto the navmesh via `NavMeshQuery.findClosestPoint`. Returns `null` if
   * the name doesn't match any room, or if the door point isn't close enough to any polygon
   * on the navmesh to snap (see `NavMeshQuery.defaultQueryHalfExtents`).
   */
  findRoomTarget: (nameOrAlias: string) => RoomTarget | null;
}

// Module-scoped, memoized: multiple calls to buildNavMesh() (e.g. from separate tests)
// must not race separate init() calls or re-init after the first successful one.
let initPromise: Promise<void> | null = null;

function ensureRecastInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init();
  }
  return initPromise;
}

// Voxelization: cell size (cs) is the xz-plane voxel edge, cell height (ch) is the y-axis
// voxel edge, both in meters. Small so the ~0.6-1.2m door gaps in floor-14.json resolve
// (they'd get eroded shut by a coarser grid). walkableRadius/walkableHeight/walkableClimb
// below are expressed in VOXEL counts in RecastConfig (not meters) -- they're derived here
// from meter figures using cs/ch so that intent stays legible at the call site.
const CS = 0.1;
const CH = 0.1;

// AGENT_RADIUS_M / AGENT_HEIGHT_M live in ./agentProfile.js: WorldRoom.ts's Detour Crowd
// agents must be sized identically to the footprint the navmesh below is eroded for, or
// the crowd and the navmesh will disagree about what fits through a gap.
/** Maximum step/ledge height the agent can climb (floor unevenness, thresholds). */
const AGENT_MAX_CLIMB_M = 0.2;

const NAV_MESH_CONFIG: Partial<SoloNavMeshGeneratorConfig> = {
  cs: CS,
  ch: CH,
  walkableRadius: Math.ceil(AGENT_RADIUS_M / CS),
  walkableHeight: Math.ceil(AGENT_HEIGHT_M / CH),
  walkableClimb: Math.ceil(AGENT_MAX_CLIMB_M / CH),
};

/**
 * Triangulates the walkable floor outline (with holes) using earcut, appending flattened
 * (x, 0, z) positions and CCW-corrected (viewed from +Y, i.e. from above) triangle indices
 * into the given accumulator arrays.
 *
 * earcut's output winding isn't guaranteed to match "upward-facing" once the 2D (x, z) ring
 * is embedded as 3D (x, 0, z) points -- it depends on the ring's traversal direction in the
 * source data, which floor-plan authors won't reliably get "right" for a 3D convention they
 * aren't thinking in. So instead of assuming a fixed convention, each triangle's up/down
 * facing is checked directly (cross product of its two edge vectors) and flipped if it
 * would come out marked as a downward-facing (thus "too steep", thus non-walkable) face by
 * Recast's `markWalkableTriangles`.
 */
function addFloorTriangles(
  plan: FloorPlan,
  positions: number[],
  indices: number[],
): void {
  const baseVertexIndex = positions.length / 3;

  const flat: number[] = [];
  const holeIndices: number[] = [];

  for (const [x, z] of plan.walkableOutline) {
    flat.push(x, z);
  }
  for (const hole of plan.holes) {
    holeIndices.push(flat.length / 2);
    for (const [x, z] of hole.polygon) {
      flat.push(x, z);
    }
  }

  const triangles = earcut(flat, holeIndices.length > 0 ? holeIndices : null, 2);

  for (let i = 0; i < flat.length; i += 2) {
    positions.push(flat[i], 0, flat[i + 1]);
  }

  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t];
    const i1 = triangles[t + 1];
    const i2 = triangles[t + 2];

    const p0x = flat[i0 * 2];
    const p0z = flat[i0 * 2 + 1];
    const p1x = flat[i1 * 2];
    const p1z = flat[i1 * 2 + 1];
    const p2x = flat[i2 * 2];
    const p2z = flat[i2 * 2 + 1];

    // Cross product (p1-p0) x (p2-p0) of points on the y=0 plane has zero x/z components;
    // its y component is (p1.z-p0.z)*(p2.x-p0.x) - (p1.x-p0.x)*(p2.z-p0.z). Positive means
    // the face normal points up (+Y) -- the orientation Recast requires for a walkable floor.
    const normalY =
      (p1z - p0z) * (p2x - p0x) - (p1x - p0x) * (p2z - p0z);

    const [a, b, c] =
      normalY > 0 ? [i0, i1, i2] : [i0, i2, i1];

    indices.push(baseVertexIndex + a, baseVertexIndex + b, baseVertexIndex + c);
  }
}

/**
 * Emits a vertical quad (2 triangles) for one wall segment, from y=0 to y=`height`.
 * Winding follows the recast-navigation README's "right-handed, CCW" convention for the
 * `(a, 0)-(b, 0)-(b, height)` / `(a, 0)-(b, height)-(a, height)` triangle pair; a near-vertical
 * quad's face normal is always ~perpendicular to +Y regardless of which way it's wound, so
 * `markWalkableTriangles` marks it "too steep" (an obstruction) either way -- CCW is kept
 * here for consistency with the floor triangles and the library's documented convention,
 * not because getting it backwards would silently misbehave.
 */
function addWallQuad(wall: FloorPlanWall, positions: number[], indices: number[]): void {
  const baseVertexIndex = positions.length / 3;
  const [ax, az] = wall.a;
  const [bx, bz] = wall.b;

  positions.push(
    ax, 0, az, // v0: a, bottom
    bx, 0, bz, // v1: b, bottom
    bx, wall.height, bz, // v2: b, top
    ax, wall.height, az, // v3: a, top
  );

  indices.push(
    baseVertexIndex + 0, baseVertexIndex + 1, baseVertexIndex + 2,
    baseVertexIndex + 0, baseVertexIndex + 2, baseVertexIndex + 3,
  );
}

function buildGeometry(plan: FloorPlan): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];

  addFloorTriangles(plan, positions, indices);
  for (const wall of plan.walls) {
    addWallQuad(wall, positions, indices);
  }

  return { positions, indices };
}

function normalizeRoomKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Builds the navmesh for a floor plan (defaults to loading `world/data/floor-14.json`).
 * Awaits recast-navigation's WASM init exactly once (memoized across calls) before
 * generating. Safe to call multiple times (e.g. once per test file).
 */
export async function buildNavMesh(floorPlan?: FloorPlan): Promise<BuiltNavMesh> {
  await ensureRecastInit();

  const plan = floorPlan ?? loadFloorPlan();
  const { positions, indices } = buildGeometry(plan);

  const result = generateSoloNavMesh(positions, indices, NAV_MESH_CONFIG);
  if (!result.success) {
    throw new Error(`buildNavMesh: generateSoloNavMesh failed: ${result.error}`);
  }

  const { navMesh } = result;
  const navMeshQuery = new NavMeshQuery(navMesh);

  const roomLookup = new Map<string, Point2D>();
  for (const room of plan.rooms) {
    roomLookup.set(normalizeRoomKey(room.name), room.door);
    for (const alias of room.aliases ?? []) {
      roomLookup.set(normalizeRoomKey(alias), room.door);
    }
  }

  const findRoomTarget = (nameOrAlias: string): RoomTarget | null => {
    const door = roomLookup.get(normalizeRoomKey(nameOrAlias));
    if (!door) return null;

    const [x, z] = door;
    const { success, point } = navMeshQuery.findClosestPoint({ x, y: 0, z });
    if (!success) return null;

    return { x: point.x, z: point.z };
  };

  return { navMesh, navMeshQuery, findRoomTarget };
}

// Exported for unit testing the triangulation/winding logic in isolation from WASM.
export const __internal = { buildGeometry, addFloorTriangles, addWallQuad };
