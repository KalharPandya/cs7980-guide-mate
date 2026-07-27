import { MapSchema, Schema, type } from "@colyseus/schema";

/**
 * Minimal synced state for one guide-robot or one visitor in the virtual world.
 * No navigation fields yet (path/target) -- those land with the Crowd sim in Task 1.2.
 */
export class Agent extends Schema {
  @type("string") id!: string;
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") heading = 0;
  @type("string") kind!: "robot" | "visitor";
  @type("string") state = "idle";
}

export class WorldState extends Schema {
  @type({ map: Agent }) agents = new MapSchema<Agent>();
  @type("number") floor = 0;
}
