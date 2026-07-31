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
import { VisitorManager } from "./visitors.js";
import type { VisitorDebugStats, VisitorHost } from "./visitors.js";

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
/** Exported so tests (WorldRoom.test.ts's MAX_AGENTS capacity-guard test) can drive the
 * exact same number instead of duplicating the literal 128 and risking drift. */
export const MAX_AGENTS = 128;
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
  private visitors!: VisitorManager;
  private disposed = false;

  /** Task 5.2: fleet-wide kill switch state -- see pause()/resume() below. */
  private paused = false;

  /**
   * `options.disableSimulatedVisitors` exists purely for test isolation (Task 4.1's
   * requestGuide/no-double-assignment tests want to bind specific known robots without the
   * background simulated-visitor spawner also competing for them); production room
   * creation passes no options and gets the spawner running at its default target.
   */
  async onCreate(options?: { disableSimulatedVisitors?: boolean }): Promise<void> {
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

    // Task 4.1: the simulated-visitor spawner + guide-assignment bookkeeping. `visitorHost`
    // is the narrow slice of this room visitors.ts needs -- see VisitorHost's doc comment.
    const visitorHost: VisitorHost = {
      plan: this.plan,
      nav: this.nav,
      agents: this.state.agents,
      addAgent: (id, kind, spawn) => this.addAgent(id, kind, spawn),
      removeAgent: (id) => this.removeAgent(id),
      moveAgentTo: (id, target) => this.moveAgentTo(id, target),
      requestMoveTarget: (id, target) => this.crowd.requestMoveTarget(id, { x: target.x, y: 0, z: target.z }),
    };
    this.visitors = new VisitorManager(visitorHost, {
      simulatedTarget: options?.disableSimulatedVisitors ? 0 : undefined,
    });

    this.setSimulationInterval((deltaMs) => this.update(deltaMs));
  }

  /**
   * Adds a new tracked agent to both the Crowd (for steering) and the synced schema (for
   * clients). `kind` is cosmetic today -- Phase 4 will actually distinguish robots from
   * visitors; every agent added here gets the same movement tuning.
   *
   * Security-review finding (Minor, closed out here): neither this method nor the fleet
   * `assign` handler (world/src/iot/bridge.ts) used to check the live agent count against
   * MAX_AGENTS before calling into the Crowd. Judged implausible at current demo scale
   * (~95 agents under Task 1.3's load test, well under 128) and the underlying library's
   * exact at-capacity behavior was unvalidated -- now verified (see crowd.ts's
   * `AgentCrowd.addAgent` doc comment): recast-navigation's `Crowd.addAgent` doesn't
   * throw at capacity, it silently hands back a "ghost" `CrowdAgent` wrapping an invalid
   * `agentIndex` that never moves and never accepts move requests, which would have left
   * a schema `Agent` permanently stuck at its spawn point.
   *
   * Returns `false` (adds nothing to either the Crowd or the schema) if the world is
   * already at `MAX_AGENTS` -- checked here, BEFORE ever calling into the Crowd, so this
   * is the primary gate; `AgentCrowd.addAgent`'s own `agentIndex < 0` check is a second,
   * defense-in-depth backstop for a caller that reaches the Crowd some other way. Callers
   * decide what a refusal means for them: the fleet `assign` handler acks
   * failed/"world_at_capacity"; the simulated-visitor spawner just skips that spawn
   * attempt for the tick (its own `simulatedTarget` cap keeps it well under 128, so this
   * is not expected to actually fire there).
   */
  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): boolean {
    if (this.state.agents.size >= MAX_AGENTS) {
      console.warn(
        `WorldRoom.addAgent: refusing to add agent "${id}" -- world already at MAX_AGENTS (${MAX_AGENTS})`,
      );
      return false;
    }

    const added = this.crowd.addAgent(id, { x: spawn.x, y: 0, z: spawn.z }, DEFAULT_AGENT_PARAMS);
    if (!added) {
      console.warn(
        `WorldRoom.addAgent: Crowd refused agent "${id}" (at capacity) despite the MAX_AGENTS pre-check`,
      );
      return false;
    }

    const agent = new Agent();
    agent.id = id;
    agent.kind = kind;
    agent.state = "idle";
    agent.x = spawn.x;
    agent.z = spawn.z;
    this.state.agents.set(id, agent);
    return true;
  }

  /**
   * Removes a tracked agent from both the Crowd and the synced schema -- the inverse of
   * `addAgent`. Task 4.1's simulated-visitor spawner uses this to despawn a visitor once
   * it has walked back to the entrance, freeing its spawn slot. No-op if `id` isn't
   * tracked (mirrors `AgentCrowd.removeAgent`'s own no-op-on-unknown-id behavior, so a
   * double-despawn attempt can't throw).
   */
  removeAgent(id: string): void {
    this.crowd.removeAgent(id);
    this.state.agents.delete(id);
  }

  /**
   * Task 4.1: picks the nearest idle robot, binds it to `visitorId`, and sends it to
   * `roomNameOrCoords` -- the plain-TypeScript guide-assignment entry point a later task's
   * Moses/IoT bridge will call for a real visitor (this task deliberately does not touch
   * IoT/MQTT at all). Returns `null` if no robot is currently idle. All of the actual
   * bookkeeping (escort-binding maps, un-binding on arrival/timeout, the simulated-visitor
   * spawner) lives in `./visitors.ts` -- see `VisitorManager.requestGuide`.
   */
  requestGuide(visitorId: string, roomNameOrCoords: string | RoomTarget): { robotId: string } | null {
    return this.visitors.requestGuide(visitorId, roomNameOrCoords);
  }

  /**
   * Task 4.2: nav-space entrance point, for a caller (the IoT bridge's fleet `assign`
   * handler) that needs to spawn a brand-new "real" visitor agent via `addAgent` before
   * calling `requestGuide` -- `requestGuide` itself requires `visitorId` to already be a
   * tracked agent (see `VisitorManager.requestGuide`'s doc comment: it only lazily
   * creates the bookkeeping record, not the Crowd/schema agent), so a caller assigning a
   * visitor the room has never seen before must add it first. Returns the same point
   * `onCreate`'s seed robot and the simulated-visitor spawner (`visitors.ts`) already
   * spawn at, so a freshly-assigned real visitor starts in the same place a simulated
   * one would.
   */
  getEntrancePoint(): { x: number; z: number } {
    return { x: this.plan.entrance.point[0], z: this.plan.entrance.point[1] };
  }

  /** Read-only escort/spawner counters for tests and ops visibility -- see
   * `VisitorDebugStats`'s doc comments for what each field means and the invariants it's
   * meant to let a caller check (e.g. `escortedVisitors === robotBindings`). */
  getVisitorDebugStats(): VisitorDebugStats {
    return this.visitors.getDebugStats();
  }

  /**
   * Task 5.2: fleet-wide kill switch. Freezes the whole simulated world by making
   * update() skip both the Crowd tick and VisitorManager.tick() every simulation frame
   * (see update()'s early return below), rather than zeroing every agent's `maxSpeed`.
   * Skipping the tick is the simpler of the two options this task's brief called out:
   * zeroing/restoring `maxSpeed` needs per-agent bookkeeping that a newly-spawned agent
   * DURING a pause could easily miss (it would start unpaused by omission), whereas an
   * early-return tick freezes every current AND future agent uniformly with zero
   * per-agent state. It also freezes the simulated-visitor spawner/lifecycle for free
   * (dwell timers, escort trailing) instead of leaving it running while agents don't
   * move -- a half-frozen world -- which is why VisitorManager.tick() is called from
   * inside the same guarded update(), not separately.
   *
   * Triggered by a fleet-scoped `stop` Command (type="stop", name="stop") arriving on
   * the fleet MQTT topic -- see world/src/iot/bridge.ts's `handleFleetStop` for the wire
   * format and world design decision, and agent_service/guidemate_agent/admin.py's
   * `POST /api/admin/world/stop` for the admin entry point.
   *
   * Idempotent: pausing an already-paused room is a no-op, not an error -- a retried
   * admin call or a duplicate at-least-once MQTT delivery must never throw.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * The resume counterpart to pause() -- see pause()'s doc comment for why this is an
   * early-return flag flip rather than restoring per-agent speeds, and
   * world/src/iot/bridge.ts's `handleFleetStop` for the wire-level trigger: the SAME
   * `type="stop"`/`name="stop"` Command, distinguished by `params.resume === true`,
   * rather than a new Command type/name (Task 5.2 design decision; see that file for
   * the full reasoning and agent_service/guidemate_agent/admin.py's
   * `POST /api/admin/world/resume` for the admin entry point). Also idempotent.
   */
  resume(): void {
    this.paused = false;
  }

  /** Read-only for tests/the bridge -- lets a caller confirm the world is actually
   * frozen without reaching into the private `paused` field. */
  get isPaused(): boolean {
    return this.paused;
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
   *
   * Task 5.2: while paused, this is a complete no-op -- no Crowd tick, no schema sync,
   * no VisitorManager.tick() -- so every agent's position/state/route and every
   * spawner/escort timer is frozen exactly where it was. See pause()'s doc comment for
   * why an early return (vs. zeroing per-agent speed) was chosen.
   */
  update(deltaMs: number): void {
    if (this.paused) return;

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

    // Task 4.1: escort trailing/arrival + the simulated-visitor spawner. Must run AFTER
    // the crowd tick + schema sync above -- see VisitorManager.tick's doc comment for why
    // that ordering is load-bearing for arrival detection, not just a style choice.
    this.visitors.tick(dtSeconds);
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
