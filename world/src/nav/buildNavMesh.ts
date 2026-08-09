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
   * Resolves a free-text room reference to that room's `door` point, snapped onto the
   * navmesh via `NavMeshQuery.findClosestPoint`. Resolution is forgiving on purpose: both
   * the LLM and real visitors fuzz room names ("Classroom 1408" for the room named "1408",
   * "the kitchen", "north collab"), so a single exact string compare would fail on common,
   * unambiguous phrasings. See `makeRoomResolver` for the ordered fallback layers. Returns
   * `null` when nothing matches CONFIDENTLY (an unmatched query the visitor can re-phrase is
   * strictly better than silently escorting them to the wrong room), or if the door point
   * isn't close enough to any polygon on the navmesh to snap.
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

// Generic filler tokens that carry no disambiguating meaning on THIS floor: they either
// recur across many room names ("Classroom 1417", "Wellness Room", "Event Space") or are
// pure grammar glue ("the"). Stripping them lets "Classroom 1408" and "1408", "the kitchen"
// and "Kitchen", "north collaboration space" and "north collaboration" collapse to one key.
// Matched as WHOLE tokens only -- critical so "washroom" never loses its embedded "room".
const GENERIC_TOKENS = new Set(["the", "classroom", "room", "space"]);

/**
 * Lowercases, turns punctuation into spaces (keeping the apostrophe in "women's"), collapses
 * whitespace, and drops the generic filler tokens above. Two strings with the same stripped
 * form name the same place regardless of phrasing noise (case, extra spaces, a trailing ".",
 * a leading "the", or a generic "room"/"classroom"/"space" word).
 */
function stripNoise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !GENERIC_TOKENS.has(tok))
    .join(" ");
}

/**
 * Builds the free-text -> room-index resolver used by `findRoomTarget`. All four layers are
 * deterministic, tried in order, first hit wins, and every one is built to return `null`
 * (not a guess) the moment a query is ambiguous, because a wrong destination is worse than a
 * re-ask. The layers, and WHY each exists:
 *
 *   1. Exact normalized name/alias (trim + lowercase) -- the original behavior, kept as the
 *      fast, zero-ambiguity path for names/aliases passed verbatim ("room 1430", "1409").
 *   2. Stripped-noise equality -- strips case, punctuation, whitespace, a leading "the", and
 *      the generic words room/classroom/space from BOTH sides, then compares. This is what
 *      resolves "Classroom 1408" -> "1408", "the kitchen" -> "Kitchen", and "north
 *      collaboration space" -> "North Collaboration Space". Only fires when exactly one room
 *      owns that stripped form.
 *   3. 4-digit-number extraction -- if the query contains a 4-digit number that appears in
 *      exactly one room's name or aliases, return that room. Catches "1408 room", "go to
 *      1417", etc. All nine numbered rooms (1407/1408/1409/1417/1418/1425/1426/1429/1430)
 *      are unique by number, so this never has to guess; a number no room owns ("1499")
 *      falls through to null.
 *   4. Distinctive-keyword containment (LAST resort) -- only tokens that are GLOBALLY UNIQUE
 *      to a single room (computed here, not hardcoded) count as distinctive, so "kitchen",
 *      "wellness", "event", "quiet", "north"/"south", "female"/"male", "gender" each pin one
 *      room, while shared words like "washroom" (3 rooms) and "collaboration" (2 rooms) are
 *      deliberately NON-distinctive and match nothing on their own. This is what lets "north
 *      collab" resolve (the token "north" is distinctive; the abbreviation "collab" is simply
 *      ignored). Returns null unless exactly one room is implicated.
 */
function makeRoomResolver(
  rooms: readonly FloorPlan["rooms"][number][],
): (query: string) => number | null {
  const addTo = (map: Map<string, Set<number>>, key: string, i: number): void => {
    if (!key) return;
    const set = map.get(key) ?? new Set<number>();
    set.add(i);
    map.set(key, set);
  };

  const exact = new Map<string, number>(); // layer 1: normalized name/alias -> room
  const stripped = new Map<string, Set<number>>(); // layer 2: stripped form -> rooms
  const byNumber = new Map<string, Set<number>>(); // layer 3: 4-digit number -> rooms
  const tokenRooms = new Map<string, Set<number>>(); // token -> rooms (for layer 4 uniqueness)

  rooms.forEach((room, i) => {
    const surfaces = [room.name, ...(room.aliases ?? [])];
    for (const surface of surfaces) {
      exact.set(normalizeRoomKey(surface), i);
      addTo(stripped, stripNoise(surface), i);
      for (const tok of stripNoise(surface).split(/\s+/)) addTo(tokenRooms, tok, i);
    }
    for (const match of surfaces.join(" ").matchAll(/\d{4}/g)) addTo(byNumber, match[0], i);
  });

  // A token is "distinctive" only if it belongs to exactly one room. Shared words
  // (washroom, collaboration) are intentionally excluded so layer 4 can never send a
  // "washroom" query to one of the three washrooms arbitrarily.
  const distinctive = new Map<string, number>();
  for (const [tok, set] of tokenRooms) {
    if (set.size === 1) distinctive.set(tok, [...set][0]);
  }

  const only = (set: Set<number> | undefined): number | null =>
    set && set.size === 1 ? [...set][0] : null;

  return (query: string): number | null => {
    const key = normalizeRoomKey(query);
    if (!key) return null; // empty / whitespace-only

    // Layer 1: exact normalized name or alias.
    const hit = exact.get(key);
    if (hit !== undefined) return hit;

    // Layer 2: stripped-noise equality.
    const strippedKey = stripNoise(query);
    const byStripped = only(stripped.get(strippedKey));
    if (byStripped !== null) return byStripped;

    // Layer 3: a 4-digit number that uniquely identifies one room.
    const numberMatches = new Set<number>();
    for (const match of query.matchAll(/\d{4}/g)) {
      for (const i of byNumber.get(match[0]) ?? []) numberMatches.add(i);
    }
    const byNum = only(numberMatches);
    if (byNum !== null) return byNum;

    // Layer 4: exactly one distinctive keyword present in the query (last resort).
    const keywordMatches = new Set<number>();
    for (const tok of strippedKey.split(/\s+/)) {
      const i = distinctive.get(tok);
      if (i !== undefined) keywordMatches.add(i);
    }
    return only(keywordMatches);
  };
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

  const resolveRoomIndex = makeRoomResolver(plan.rooms);

  const findRoomTarget = (nameOrAlias: string): RoomTarget | null => {
    const idx = resolveRoomIndex(nameOrAlias);
    if (idx === null) return null;

    const [x, z]: Point2D = plan.rooms[idx].door;
    const { success, point } = navMeshQuery.findClosestPoint({ x, y: 0, z });
    if (!success) return null;

    return { x: point.x, z: point.z };
  };

  return { navMesh, navMeshQuery, findRoomTarget };
}

// Exported for unit testing the triangulation/winding logic and the room-name resolution
// layers in isolation from WASM (makeRoomResolver is pure string logic; it needs no navmesh).
export const __internal = {
  buildGeometry,
  addFloorTriangles,
  addWallQuad,
  makeRoomResolver,
  stripNoise,
};
