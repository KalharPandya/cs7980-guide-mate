import { Room } from "@colyseus/core";
import type { Client } from "@colyseus/core";

import { WorldState } from "./schema/WorldState.js";

/**
 * Bare Colyseus room skeleton for the virtual guide fleet.
 *
 * No navigation logic here on purpose -- Task 1.1/1.2 add the recast-navigation
 * Crowd simulation and named-room routing on top of this room in a separate task.
 * No per-connection auth yet either -- that's Phase 4.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  onCreate(): void {
    this.setState(new WorldState());
    console.log("WorldRoom created");
  }

  onJoin(client: Client): void {
    console.log(`WorldRoom: client joined (sessionId=${client.sessionId})`);
  }

  onLeave(client: Client): void {
    console.log(`WorldRoom: client left (sessionId=${client.sessionId})`);
  }
}
