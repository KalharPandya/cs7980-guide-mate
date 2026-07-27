/**
 * Client-side mirror of the server's floor-plan schema (see world/src/nav/loadFloorPlan.ts and
 * world/data/floor-14.json). Duplicated here -- not imported -- because world-client is a
 * separate Vite/browser build and can't reach into the world/ server package's TypeScript
 * sources or its node:fs-based loader. Keep this in sync with world/src/nav/loadFloorPlan.ts by
 * hand if the schema changes; there is deliberately no runtime validation here (that already
 * happens server-side via validateFloorPlan) since world-client/public/data/floor-14.json is a
 * demo-time copy of the same file the server validates.
 */

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
