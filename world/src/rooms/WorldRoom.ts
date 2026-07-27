import { Room } from "colyseus";
import type { Client } from "colyseus";

import { Agent, WorldState } from "./schema/WorldState.js";
import { buildNavMesh } from "../nav/buildNavMesh.js";
import type { BuiltNavMesh, RoomTarget } from "../nav/buildNavMesh.js";
import { loadFloorPlan } from "../nav/loadFloorPlan.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";
import { AgentCrowd } from "../nav/crowd.js";
import type { AgentParams } from "../nav/crowd.js";

/**
 * Task 1.2: the real Detour Crowd simulation loop, replacing the single-demo-agent
 * scaffold from commit ae830c1 (that scaffold walked one agent along a raw
 * `NavMeshQuery.computePath` path by hand -- no local avoidance, no agent pool; it was
 * explicitly scaffolding for this task to replace, not extend).
 *
 * One `AgentCrowd` (world/src/nav/crowd.ts) owns every agent's steering/local-avoidance;
 * WorldRoom's job is just: build the navmesh, own the crowd, step it on a fixed
 * simulated timestep, and mirror each crowd agent's resulting position/heading into the
 * synced `WorldState.agents` schema map every tick.
 */
const MAX_AGENTS = 128;
const MAX_AGENT_RADIUS_M = 0.5;

/** Guide-robot / visitor-avatar movement tuning. `radius`/`height` match the footprint
 * buildNavMesh.ts already eroded the walkable area by -- keep these two in sync if that
 * changes, or the crowd will think agents fit through gaps the navmesh doesn't actually
 * have room for (or vice versa). */
const DEFAULT_AGENT_PARAMS: AgentParams = {
  radius: 0.2,
  height: 1.8,
  maxAcceleration: 8,
  maxSpeed: 1.4,
  collisionQueryRange: 2.5,
  pathOptimizationRange: 0,
  separationWeight: 2,
};

/** No visitors/robots distinction concept yet (that's Phase 4) -- this is the one test
 * agent seeded on room creation so Task 1.2 is independently testable without the IoT
 * bridge or Moses. */
const TEST_AGENT_ID = "test-robot-1";

/** Colyseus's setSimulationInterval callback delivers deltaTime in MILLISECONDS; Detour's
 * `crowd.update()` expects SECONDS. Clamped so a stall (e.g. a slow tick after GC) can't
 * teleport an agent through a wall in a single step. (Verified-correct pattern carried
 * over from the demo scaffold this task replaces.) */
const MAX_TICK_SECONDS = 0.1;

export class WorldRoom extends Room<{ state: WorldState }> {
  private nav!: BuiltNavMesh;
  private plan!: FloorPlan;
  private crowd!: AgentCrowd;

  async onCreate(): Promise<void> {
    this.setState(new WorldState());
    console.log("WorldRoom created");

    this.plan = loadFloorPlan();
    this.state.floor = this.plan.floor;
    this.nav = await buildNavMesh(this.plan);

    this.crowd = new AgentCrowd(this.nav.navMesh, {
      maxAgents: MAX_AGENTS,
      maxAgentRadius: MAX_AGENT_RADIUS_M,
    });

    this.addAgent(TEST_AGENT_ID, "robot", {
      x: this.plan.entrance.point[0],
      z: this.plan.entrance.point[1],
    });

    this.setSimulationInterval((deltaMs) => this.update(deltaMs));
  }

  /**
   * Adds a new tracked agent to both the Crowd (for steering) and the synced schema (for
   * clients). `kind` is cosmetic today -- Phase 4 will actually distinguish robots from
   * visitors; every agent added here gets the same movement tuning.
   */
  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): void {
    this.crowd.addAgent(id, { x: spawn.x, y: 0, z: spawn.z }, DEFAULT_AGENT_PARAMS);

    const agent = new Agent();
    agent.id = id;
    agent.kind = kind;
    agent.state = "idle";
    agent.x = spawn.x;
    agent.z = spawn.z;
    this.state.agents.set(id, agent);
  }

  /**
   * Resolves `roomNameOrCoords` (a room name/alias via Task 1.1's `findRoomTarget`, or a
   * literal nav-space `{x, z}` point) and requests the crowd agent `agentId` move there.
   * Returns `false` (and logs why) if the agent id is unknown or the target can't be
   * resolved -- this never edits floor-14.json to work around an unreachable room; an
   * unresolvable target is reported, not silently worked around.
   */
  moveAgentTo(agentId: string, roomNameOrCoords: string | RoomTarget): boolean {
    const target =
      typeof roomNameOrCoords === "string"
        ? this.nav.findRoomTarget(roomNameOrCoords)
        : roomNameOrCoords;

    if (!target) {
      console.warn(
        `WorldRoom.moveAgentTo: could not resolve target ${JSON.stringify(roomNameOrCoords)} ` +
          `for agent "${agentId}"`,
      );
      return false;
    }

    const requested = this.crowd.requestMoveTarget(agentId, {
      x: target.x,
      y: 0,
      z: target.z,
    });
    if (!requested) {
      console.warn(
        `WorldRoom.moveAgentTo: requestMoveTarget failed for agent "${agentId}" -> ` +
          `(${target.x.toFixed(2)}, ${target.z.toFixed(2)})`,
      );
    }
    return requested;
  }

  /**
   * The simulation tick: converts Colyseus's millisecond deltaTime to the seconds Detour
   * expects (clamped, see MAX_TICK_SECONDS), steps the crowd, and mirrors each agent's
   * resulting position/heading into its synced schema entry.
   *
   * Public (not just wired via setSimulationInterval) so tests can drive deterministic,
   * wall-clock-free simulated time by calling this directly with a synthetic deltaMs
   * instead of waiting on Colyseus's real interval timer.
   */
  update(deltaMs: number): void {
    const dtSeconds = Math.min(deltaMs / 1000, MAX_TICK_SECONDS);
    const snapshots = this.crowd.tick(dtSeconds);

    for (const snap of snapshots) {
      const agent = this.state.agents.get(snap.id);
      if (!agent) continue;
      agent.x = snap.x;
      agent.z = snap.z;
      agent.heading = snap.heading;
      agent.state = snap.speed >= 0.05 ? "moving" : "idle";
    }
  }

  onJoin(client: Client): void {
    console.log(`WorldRoom: client joined (sessionId=${client.sessionId})`);
  }

  onLeave(client: Client): void {
    console.log(`WorldRoom: client left (sessionId=${client.sessionId})`);
  }
}
