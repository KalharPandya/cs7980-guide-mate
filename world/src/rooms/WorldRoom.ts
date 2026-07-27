import { Room } from "colyseus";
import type { Client } from "colyseus";

import { Agent, WorldState } from "./schema/WorldState.js";
import { buildNavMesh } from "../nav/buildNavMesh.js";
import type { BuiltNavMesh, RoomTarget } from "../nav/buildNavMesh.js";
import { loadFloorPlan } from "../nav/loadFloorPlan.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";
import { AgentCrowd } from "../nav/crowd.js";
import type { AgentParams } from "../nav/crowd.js";
import { AGENT_HEIGHT_M, AGENT_RADIUS_M } from "../nav/agentProfile.js";

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

/** Guide-robot / visitor-avatar movement tuning. `radius`/`height` come from
 * `../nav/agentProfile.js`, the same footprint buildNavMesh.ts erodes the walkable area
 * by -- importing the shared constants (instead of re-declaring the literals here) is
 * what keeps the crowd and the navmesh from disagreeing about what fits through a gap. */
const DEFAULT_AGENT_PARAMS: AgentParams = {
  radius: AGENT_RADIUS_M,
  height: AGENT_HEIGHT_M,
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

/** Below this speed (m/s), the synced schema reports the agent as "idle" rather than
 * "moving". Distinct from crowd.ts's `MIN_HEADING_SPEED_MPS` (0.01): that one keeps a
 * stopped agent's *heading* from jittering to atan2(0, 0); this one is purely the
 * idle-vs-moving classification exposed to clients, and the two thresholds are allowed to
 * (and do) differ. */
const IDLE_SPEED_THRESHOLD_MPS = 0.05;

export class WorldRoom extends Room<{ state: WorldState }> {
  private nav!: BuiltNavMesh;
  private plan!: FloorPlan;
  private crowd!: AgentCrowd;
  private disposed = false;

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
      return requested;
    }

    this.updateAgentRoute(agentId, target);
    return requested;
  }

  /**
   * Task 3.3: computes the DISPLAY polyline for the client's glowing route-line renderer
   * and stores it (flattened x,z pairs) on the agent's synced `route`. This is a one-shot
   * snapshot taken here, at the moment the move is requested -- NOT re-derived from
   * Detour's internal corridor every tick (see nav/crowd.ts's module doc comment: the
   * Crowd already owns per-frame steering/avoidance; asking it to also expose its live
   * corridor every tick would mean re-walking/re-encoding a schema array 20x/second per
   * agent for a line that's only cosmetic). `navMeshQuery.computePath` gives the same
   * "as the crow flies across the navmesh" polyline Task 1.1's `findRoomTarget` already
   * relies on `findClosestPoint` for, so no new nav primitive is introduced.
   *
   * Uses the agent's last-synced (x, z) as the path start -- this fires in the same
   * synchronous call as `requestMoveTarget`, before `update()` has moved the agent again,
   * so it's the agent's real current position, not stale.
   *
   * Failure (no path found) clears the route rather than leaving a stale one and returns
   * without throwing: the crowd steering request above already succeeded independently of
   * this, so a missing DISPLAY path shouldn't be treated as `moveAgentTo` failing overall.
   */
  private updateAgentRoute(agentId: string, target: RoomTarget): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;

    agent.route.clear();

    const { success, path } = this.nav.navMeshQuery.computePath(
      { x: agent.x, y: 0, z: agent.z },
      { x: target.x, y: 0, z: target.z },
    );
    if (!success) {
      console.warn(
        `WorldRoom.moveAgentTo: computePath failed for agent "${agentId}"; route line will be empty`,
      );
      return;
    }

    for (const point of path) {
      agent.route.push(point.x, point.z);
    }
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

      const nextState = snap.speed >= IDLE_SPEED_THRESHOLD_MPS ? "moving" : "idle";
      // Task 3.3: the route line is only meaningful while the agent is actually en route --
      // clear it the moment the schema settles to "idle" (arrival, or any other reason the
      // crowd agent stops) so the client never keeps drawing a route to a destination the
      // agent already reached.
      if (nextState === "idle" && agent.route.length > 0) {
        agent.route.clear();
      }
      agent.state = nextState;
    }
  }

  onJoin(client: Client): void {
    console.log(`WorldRoom: client joined (sessionId=${client.sessionId})`);
  }

  onLeave(client: Client): void {
    console.log(`WorldRoom: client left (sessionId=${client.sessionId})`);
  }

  /**
   * Frees the WASM-backed native allocations this room owns: the Detour Crowd, then the
   * NavMesh/NavMeshQuery it steps on. Colyseus's `autoDispose` defaults to true, meaning
   * this room IS disposed the moment its last client disconnects -- a browser refresh, a
   * dropped WS, a kiosk reboot -- so this has to actually run reliably, not just exist for
   * an explicit shutdown path. This also closes the NavMesh/NavMeshQuery disposal gap
   * Task 1.1's review flagged: WorldRoom is the sole owner of all three native objects, so
   * one onDispose here resolves both.
   *
   * Guarded so it's safe to call more than once (a native double-free would be a crash,
   * not a soft failure) and safe to call even if onCreate() never finished setting up
   * `crowd`/`nav` (defensive only -- Colyseus does not call onDispose before onCreate
   * resolves).
   *
   * Order matters: the crowd holds a reference to the navmesh it was constructed with, so
   * it must be destroyed before the navmesh/query underneath it.
   */
  onDispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.crowd?.destroy();
    this.nav?.navMesh.destroy();
    this.nav?.navMeshQuery.destroy();
  }
}
