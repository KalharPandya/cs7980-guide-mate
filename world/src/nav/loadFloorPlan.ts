/**
 * Loads and validates the floor-plan JSON that both the navmesh (this module's caller,
 * buildNavMesh.ts) and the eventual three.js client derive their geometry from.
 *
 * The schema is intentionally plain data (no classes) so it round-trips through JSON.parse
 * with no extra step. See `world/data/floor-14.json` for a real example.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A 2D point on the floor plan: `[x, z]`, both in meters. */
export type Point2D = [x: number, z: number];

export interface FloorPlanHole {
  name: string;
  polygon: Point2D[];
}

export interface FloorPlanWall {
  a: Point2D;
  b: Point2D;
  height: number;
  glass: boolean;
  note?: string;
}

export interface FloorPlanRoom {
  name: string;
  aliases?: string[];
  center: Point2D;
  door: Point2D;
}

export interface FloorPlanEntrance {
  name: string;
  point: Point2D;
}

export interface FloorPlan {
  units: string;
  floor: number;
  walkableOutline: Point2D[];
  holes: FloorPlanHole[];
  walls: FloorPlanWall[];
  rooms: FloorPlanRoom[];
  entrance: FloorPlanEntrance;
}

/** Default location of the (currently) one floor-plan JSON in the repo. */
export const DEFAULT_FLOOR_PLAN_PATH = fileURLToPath(
  new URL("../../data/floor-14.json", import.meta.url),
);

/**
 * Reads a floor-plan JSON file from disk and validates it against the `FloorPlan` shape.
 * Throws a descriptive `Error` (naming the offending field and its path) if the file is
 * missing, isn't valid JSON, or doesn't match the schema.
 */
export function loadFloorPlan(path: string = DEFAULT_FLOOR_PLAN_PATH): FloorPlan {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `loadFloorPlan: could not read "${path}": ${(err as Error).message}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadFloorPlan: "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  return validateFloorPlan(data, path);
}

/** Validates an already-parsed value against the `FloorPlan` shape. Exported for testing. */
export function validateFloorPlan(data: unknown, sourcePath = "<in-memory>"): FloorPlan {
  const fail = (field: string, expected: string): never => {
    throw new Error(
      `loadFloorPlan: ${sourcePath}: field "${field}" ${expected}`,
    );
  };

  if (typeof data !== "object" || data === null) {
    return fail("<root>", "must be a JSON object");
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.units !== "string") fail("units", "must be a string");
  if (typeof obj.floor !== "number") fail("floor", "must be a number");

  const walkableOutline = validatePointArray(obj.walkableOutline, "walkableOutline", fail);
  if (walkableOutline.length < 3) {
    fail("walkableOutline", "must have at least 3 points to form a polygon");
  }

  if (!Array.isArray(obj.holes)) fail("holes", "must be an array");
  const holes: FloorPlanHole[] = (obj.holes as unknown[]).map((h, i) => {
    if (typeof h !== "object" || h === null) {
      return fail(`holes[${i}]`, "must be an object");
    }
    const hole = h as Record<string, unknown>;
    if (typeof hole.name !== "string") fail(`holes[${i}].name`, "must be a string");
    const polygon = validatePointArray(hole.polygon, `holes[${i}].polygon`, fail);
    if (polygon.length < 3) fail(`holes[${i}].polygon`, "must have at least 3 points");
    return { name: hole.name as string, polygon };
  });

  if (!Array.isArray(obj.walls)) fail("walls", "must be an array");
  const walls: FloorPlanWall[] = (obj.walls as unknown[]).map((w, i) => {
    if (typeof w !== "object" || w === null) {
      return fail(`walls[${i}]`, "must be an object");
    }
    const wall = w as Record<string, unknown>;
    const a = validatePoint(wall.a, `walls[${i}].a`, fail);
    const b = validatePoint(wall.b, `walls[${i}].b`, fail);
    if (typeof wall.height !== "number" || wall.height <= 0) {
      fail(`walls[${i}].height`, "must be a positive number");
    }
    if (typeof wall.glass !== "boolean") fail(`walls[${i}].glass`, "must be a boolean");
    if (wall.note !== undefined && typeof wall.note !== "string") {
      fail(`walls[${i}].note`, "must be a string if present");
    }
    return {
      a,
      b,
      height: wall.height as number,
      glass: wall.glass as boolean,
      note: wall.note as string | undefined,
    };
  });

  if (!Array.isArray(obj.rooms)) fail("rooms", "must be an array");
  const rooms: FloorPlanRoom[] = (obj.rooms as unknown[]).map((r, i) => {
    if (typeof r !== "object" || r === null) {
      return fail(`rooms[${i}]`, "must be an object");
    }
    const room = r as Record<string, unknown>;
    if (typeof room.name !== "string") fail(`rooms[${i}].name`, "must be a string");
    let aliases: string[] | undefined;
    if (room.aliases !== undefined) {
      if (!Array.isArray(room.aliases) || !room.aliases.every((a) => typeof a === "string")) {
        fail(`rooms[${i}].aliases`, "must be an array of strings if present");
      }
      aliases = room.aliases as string[];
    }
    const center = validatePoint(room.center, `rooms[${i}].center`, fail);
    const door = validatePoint(room.door, `rooms[${i}].door`, fail);
    return { name: room.name as string, aliases, center, door };
  });

  if (typeof obj.entrance !== "object" || obj.entrance === null) {
    return fail("entrance", "must be an object");
  }
  const entranceObj = obj.entrance as Record<string, unknown>;
  if (typeof entranceObj.name !== "string") fail("entrance.name", "must be a string");
  const entrancePoint = validatePoint(entranceObj.point, "entrance.point", fail);

  return {
    units: obj.units as string,
    floor: obj.floor as number,
    walkableOutline,
    holes,
    walls,
    rooms,
    entrance: { name: entranceObj.name as string, point: entrancePoint },
  };
}

function validatePoint(
  value: unknown,
  field: string,
  fail: (field: string, expected: string) => never,
): Point2D {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    fail(field, "must be a [x, z] tuple of two numbers");
  }
  return value as Point2D;
}

function validatePointArray(
  value: unknown,
  field: string,
  fail: (field: string, expected: string) => never,
): Point2D[] {
  if (!Array.isArray(value)) {
    fail(field, "must be an array of [x, z] points");
  }
  return (value as unknown[]).map((p, i) => validatePoint(p, `${field}[${i}]`, fail));
}
