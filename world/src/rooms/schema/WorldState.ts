import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

/**
 * Minimal synced state for one guide-robot or one visitor in the virtual world.
 *
 * `route` (Task 3.3) is the flattened (x0, z0, x1, z1, ...) polyline of the agent's
 * CURRENT navigation path, for the client's glowing route-line renderer
 * (world-client/src/scene/RouteLine.tsx) -- empty when idle. Flattened numbers were
 * chosen over `ArraySchema<Point>` (a tiny nested Schema class with its own x/z fields):
 * each element in an `ArraySchema<Schema>` is itself a full schema instance with its own
 * refId/changeTree bookkeeping, which is real per-point overhead for what is otherwise
 * two plain floats -- a flattened `ArraySchema<number>` encodes/decodes as a primitive
 * collection with none of that, and world-server (WorldRoom.moveAgentTo) already deals
 * in flat `{x, z}` doubles everywhere else, so a Point schema would just be reboxing.
 * The client (useWorldRoom.ts) reads this back as (route[2i], route[2i+1]) pairs.
 */
export class Agent extends Schema {
  @type("string") id!: string;
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") heading = 0;
  @type("string") kind!: "robot" | "visitor";
  @type("string") state = "idle";
  @type(["number"]) route = new ArraySchema<number>();
}

export class WorldState extends Schema {
  @type({ map: Agent }) agents = new MapSchema<Agent>();
  @type("number") floor = 0;
}
