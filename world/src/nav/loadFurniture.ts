/**
 * Loads `world/data/floor-14-furniture.json` and turns each rendered furniture item into an
 * obstacle FOOTPRINT polygon that `buildNavMesh.ts` can carve out of the walkable navmesh, so
 * robots and visitors route AROUND furniture instead of walking through it.
 *
 * WHY A SEPARATE FILE (and why the client's Furniture.tsx doc-comment used to say "RENDER-ONLY").
 * Furniture was originally kept out of the navmesh on purpose: ~96 extra obstacles scattered
 * through the rooms risk carving the navmesh up and breaking the 18/18 room-reachability gate for
 * a purely cosmetic gain. This module makes furniture solid WITHOUT taking that risk, by (1)
 * INSETTING every footprint a few cm so it never quite touches a wall (a furniture box flush
 * against a wall would otherwise fuse with it and eat the AGENT_RADIUS_M clearance a doorway
 * needs), and (2) SKIPPING any item that sits on a room door / the entrance or that shrinks to
 * nothing once inset. The remaining items are handed to buildNavMesh as obstacle polygons and the
 * nav reachability gate (`buildNavMesh.furniture.test.ts`) is the safety check: every room must
 * still be reachable with no PARTIAL path.
 *
 * COORDINATE FRAME. The furniture file uses the SAME floor-plan (x, z) meters as floor-14.json's
 * `walls`/`walkableOutline` (world-client/src/scene/Furniture.tsx mounts furniture in the exact
 * same untranslated group as the walls and floor). So a footprint polygon computed here is
 * directly comparable to wall coordinates -- no transform.
 *
 * FOOTPRINT GEOMETRY. Mirrors how the client draws each item (Furniture.tsx / floorPlanUtils
 * directionToYRotation): a box centered at `center`, its LONG side (`size[0]`) along the unit
 * vector `axis`, its SHORT side (`size[1]`) perpendicular to it. The four corners are therefore
 * `center +/- (halfLong)*axis +/- (halfShort)*perp`, where `perp` is `axis` rotated 90 degrees in
 * the (x, z) plane. A rectangle's corner set is identical for `perp` and `-perp`, so the choice of
 * perpendicular sign is irrelevant here (unlike the render, which also needs the box's facing).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Point2D } from "./loadFloorPlan.js";
import type { FloorPlan } from "./loadFloorPlan.js";

/** One extracted furniture item. `axis` is a unit vector along the long side, floor-plan coords. */
export interface FurnitureItem {
  center: Point2D;
  /** `[longSide, shortSide]` in meters. */
  size: [long: number, short: number];
  axis: Point2D;
  height: number;
}

export interface FurniturePlan {
  units: string;
  floor: number;
  items: FurnitureItem[];
}

/** Default location of the furniture JSON, resolved next to the floor-plan JSON. */
export const DEFAULT_FURNITURE_PATH = fileURLToPath(
  new URL("../../data/floor-14-furniture.json", import.meta.url),
);

/**
 * How far each side of a furniture footprint is pulled IN before it becomes an obstacle, in
 * meters. A footprint flush against a wall would voxel-fuse with that wall and eat into the
 * AGENT_RADIUS_M (0.20m) clearance the erosion already reserves along it, which is exactly how a
 * room interior or a doorway gap closes. 0.06m per side (0.12m off each dimension) keeps the
 * obstacle strictly inside the drawn footprint so it can sit against a wall in the render while
 * leaving a hair of navigable gap in the mesh. Deliberately smaller than AGENT_RADIUS_M so the
 * obstacle still blocks the agent's CENTER by roughly the amount the render shows.
 */
export const FURNITURE_INSET_M = 0.06;

/**
 * Minimum SHORT side (after inset) for an item to be worth carving, in meters. Below this an item
 * is a stool/planter/side-table whose footprint is a sliver: it blocks essentially nothing a
 * 0.20m-radius agent would notice, and a sliver obstacle sitting near a wall or doorway is pure
 * reachability risk for no navigational gain. Skipped rather than carved.
 */
export const FURNITURE_MIN_SHORT_SIDE_M = 0.25;

/**
 * Clearance a footprint must keep from any room `door` or the building `entrance`, in meters. An
 * obstacle within this of a door narrows (or closes) the one gap that connects that room to the
 * corridor, which is what breaks reachability. Any item whose footprint comes within this of a
 * door/entrance point is skipped. Sized a touch over one agent DIAMETER (2 * 0.20m) so a kept
 * obstacle can never pinch a doorway below the width a single agent needs to pass.
 */
export const FURNITURE_DOOR_CLEARANCE_M = 0.55;

/** Rotates (x, z) 90 degrees in the floor plane. Used to get the short-side direction from `axis`. */
function perpendicular([x, z]: Point2D): Point2D {
  return [-z, x];
}

/**
 * The four corners of one item's obstacle footprint, in floor-plan meters, after shrinking each
 * side by `insetM`. Corners are returned in consistent winding (they trace the rectangle) so the
 * caller can treat them as a polygon.
 */
export function furnitureFootprint(item: FurnitureItem, insetM: number): Point2D[] {
  const [cx, cz] = item.center;
  const halfLong = Math.max(0, item.size[0] / 2 - insetM);
  const halfShort = Math.max(0, item.size[1] / 2 - insetM);

  const [ux, uz] = item.axis;
  const [px, pz] = perpendicular(item.axis);

  const corner = (sLong: number, sShort: number): Point2D => [
    cx + sLong * halfLong * ux + sShort * halfShort * px,
    cz + sLong * halfLong * uz + sShort * halfShort * pz,
  ];

  // Wound so consecutive corners are adjacent (not diagonal): (+,+) (+,-) (-,-) (-,+).
  return [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
}

/** Distance from point `p` to the finite segment `a`-`b`, floor-plan meters. */
function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** True if point `p` lies inside the convex polygon `poly` (winding-agnostic ray-independent test). */
function pointInPolygon(p: Point2D, poly: Point2D[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Smallest distance from point `p` to any edge of (or the interior of) polygon `poly`. 0 if inside. */
function pointPolygonDistance(p: Point2D, poly: Point2D[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let nearest = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

export interface FurnitureSelection {
  /** Footprints (inset, floor-plan meters) to carve into the navmesh as obstacles. */
  obstacles: Point2D[][];
  /** Per-item outcome, index-aligned with `plan.items`, for reporting/testing. */
  decisions: {
    index: number;
    included: boolean;
    reason: string;
  }[];
}

/**
 * Turns a furniture plan into the obstacle footprints buildNavMesh should carve, applying the
 * inset + skip rules above. Pure and deterministic (no navmesh needed), so it is unit-testable on
 * its own; the reachability gate that PROVES the kept set is safe lives in the nav test that then
 * feeds these obstacles through buildNavMesh.
 */
export function selectFurnitureObstacles(
  furniture: FurniturePlan,
  floorPlan: FloorPlan,
  options: {
    insetM?: number;
    minShortSideM?: number;
    doorClearanceM?: number;
  } = {},
): FurnitureSelection {
  const insetM = options.insetM ?? FURNITURE_INSET_M;
  const minShortSideM = options.minShortSideM ?? FURNITURE_MIN_SHORT_SIDE_M;
  const doorClearanceM = options.doorClearanceM ?? FURNITURE_DOOR_CLEARANCE_M;

  // Every point a kept obstacle must stay clear of: each room's door plus the entrance.
  const doorPoints: Point2D[] = [
    ...floorPlan.rooms.map((r) => r.door),
    floorPlan.entrance.point,
  ];

  const obstacles: Point2D[][] = [];
  const decisions: FurnitureSelection["decisions"] = [];

  furniture.items.forEach((item, index) => {
    const shortAfterInset = item.size[1] / 2 - insetM;
    const longAfterInset = item.size[0] / 2 - insetM;

    if (shortAfterInset <= 0 || longAfterInset <= 0) {
      decisions.push({ index, included: false, reason: "degenerate after inset (dimension <= 0)" });
      return;
    }
    if (item.size[1] < minShortSideM) {
      decisions.push({
        index,
        included: false,
        reason: `short side ${item.size[1].toFixed(2)}m < ${minShortSideM}m (sliver; skipped)`,
      });
      return;
    }

    const footprint = furnitureFootprint(item, insetM);

    let blockedDoor: { point: Point2D; dist: number } | null = null;
    for (const door of doorPoints) {
      const d = pointPolygonDistance(door, footprint);
      if (d < doorClearanceM && (blockedDoor === null || d < blockedDoor.dist)) {
        blockedDoor = { point: door, dist: d };
      }
    }
    if (blockedDoor) {
      decisions.push({
        index,
        included: false,
        reason:
          `footprint is ${blockedDoor.dist.toFixed(2)}m from a door/entrance ` +
          `[${blockedDoor.point[0]}, ${blockedDoor.point[1]}] < ${doorClearanceM}m clearance`,
      });
      return;
    }

    obstacles.push(footprint);
    decisions.push({ index, included: true, reason: "included" });
  });

  return { obstacles, decisions };
}

/** Reads and validates the furniture JSON from disk. Throws a descriptive Error on any problem. */
export function loadFurniture(path: string = DEFAULT_FURNITURE_PATH): FurniturePlan {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`loadFurniture: could not read "${path}": ${(err as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadFurniture: "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  return validateFurniture(data, path);
}

/** Validates an already-parsed value against the `FurniturePlan` shape. Exported for testing. */
export function validateFurniture(data: unknown, sourcePath = "<in-memory>"): FurniturePlan {
  const fail = (field: string, expected: string): never => {
    throw new Error(`loadFurniture: ${sourcePath}: field "${field}" ${expected}`);
  };

  if (typeof data !== "object" || data === null) return fail("<root>", "must be a JSON object");
  const obj = data as Record<string, unknown>;

  if (typeof obj.units !== "string") fail("units", "must be a string");
  if (typeof obj.floor !== "number") fail("floor", "must be a number");
  if (!Array.isArray(obj.items)) fail("items", "must be an array");

  const items: FurnitureItem[] = (obj.items as unknown[]).map((it, i) => {
    if (typeof it !== "object" || it === null) return fail(`items[${i}]`, "must be an object");
    const o = it as Record<string, unknown>;
    const center = validatePair(o.center, `items[${i}].center`, fail);
    const size = validatePair(o.size, `items[${i}].size`, fail);
    const axis = validatePair(o.axis, `items[${i}].axis`, fail);
    if (typeof o.height !== "number" || o.height <= 0) {
      fail(`items[${i}].height`, "must be a positive number");
    }
    return { center, size, axis, height: o.height as number };
  });

  return { units: obj.units as string, floor: obj.floor as number, items };
}

function validatePair(
  value: unknown,
  field: string,
  fail: (field: string, expected: string) => never,
): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    fail(field, "must be a [a, b] tuple of two numbers");
  }
  return value as [number, number];
}
