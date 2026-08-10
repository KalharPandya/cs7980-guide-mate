import { Room } from "colyseus";
import type { Client } from "colyseus";

import { Agent, Station, WorldState } from "./schema/WorldState.js";
import { buildNavMesh } from "../nav/buildNavMesh.js";
import type { BuiltNavMesh, RoomTarget } from "../nav/buildNavMesh.js";
import { loadFloorPlan } from "../nav/loadFloorPlan.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";
import { AgentCrowd } from "../nav/crowd.js";
import type { AgentParams } from "../nav/crowd.js";
import { AGENT_HEIGHT_M, AGENT_RADIUS_M } from "../nav/agentProfile.js";
import { VisitorManager } from "./visitors.js";
import type { VisitorDebugStats, VisitorHost, VisitorManagerOptions } from "./visitors.js";
import type { RequestGuideResult } from "./escortManager.js";
import { computeGuideFleetSpawns } from "./guideFleetSpawns.js";

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
 * what keeps the crowd and the navmesh from disagreeing about what fits through a gap.
 *
 * Collision/conflict tuning (restored to the tested baseline where escorts settle to
 * idle and complete):
 * - `collisionQueryRange: 2.5` (baseline). The tighter 1.0 m tuning packed a robot and
 *   its trailing visitor tight at the destination door and made them jitter forever, so
 *   neither reached idle and escorts never completed via genuine arrival
 *   (test:visitors + test:assign-chain failed). 2.5 m is the value escorts were tested
 *   under and settle cleanly with.
 * - `pathOptimizationRange: 0` (baseline). Same reason; 0 is the tested value.
 * - The count reduction (GUIDE_ROBOT_COUNT down to 5, so a 5+5 scene), not this tuning,
 *   is what removed the crowd gridlock, so the tighter values are no longer needed.
 * - `maxSpeed`/`maxAcceleration` unchanged.
 * - `separationWeight`: see SEPARATION_WEIGHT below. */

/** Top speed (m/s) every agent's corridor steering is scaled to. Detour computes the
 * steering term as `maxSpeed * speedScale` in the direction of the next corridor corner,
 * where `speedScale` is 1 for the whole trip and only tapers inside the last
 * `radius * 2` = 0.4m before the goal -- so 1.4 is the magnitude of the "go to my
 * destination" force for all but the final 0.4m. SEPARATION_WEIGHT is derived from it. */
const AGENT_MAX_SPEED_MPS = 1.4;

/**
 * How hard an agent is pushed away from its neighbours (Detour's `DT_CROWD_SEPARATION`
 * steering term). MUST stay strictly below AGENT_MAX_SPEED_MPS -- that is not a style
 * preference, it is the condition that makes crowd deadlock structurally impossible, and
 * violating it is a real defect this value was lowered from 2 to fix.
 *
 * ---- the defect (measured, not theorised) ----
 * Detour sums two forces into an agent's desired velocity: corridor steering (magnitude
 * `AGENT_MAX_SPEED_MPS`, pointing at the next corner) and separation. For a neighbour at
 * distance `d` within `collisionQueryRange` R, recast's separation term (Detour/DetourCrowd.cpp,
 * the `DT_CROWD_SEPARATION` block) has magnitude `separationWeight * (1 - (d/R)^2)`, pointing
 * directly away from that neighbour; with several neighbours the contributions are AVERAGED,
 * so `separationWeight` bounds the total no matter how many agents are nearby.
 *
 * At the old `separationWeight: 2` with `R = 2.5`, that magnitude reaches 1.4 -- exactly
 * AGENT_MAX_SPEED_MPS -- at d = 2.5 * sqrt(1 - 1.4/2) = 1.369m, and exceeds it for anything
 * closer. So a single neighbour standing roughly in the direction an agent wants to travel
 * could CANCEL its steering completely, and d = 1.369m is a STABLE equilibrium of that
 * cancellation: closer in, separation wins and pushes the agent back out; further out,
 * steering wins and pulls it back in. The agent parks there permanently with a perfectly
 * valid, fully-planned corridor it never walks.
 *
 * That is not a hypothetical. It was reproduced on this floor plan at the production 16.6ms
 * tick with an escort from "Classroom 1425" to the "Kitchen": the fetch leg left the robot at
 * (5.370, 12.993) just inside a doorway with the person it had collected at (5.375, 14.362),
 * i.e. 1.369m away and almost exactly in line with the robot's own first corridor corner
 * (5.40, 13.06). Instrumented, the two forces read steer = (0.005, 1.400) |1.400| and
 * separation = (-0.005, -1.400) |1.400|, summing to (-0.000, -0.000): the robot's desired
 * velocity was ZERO for the entire 90s ESCORT_TIMEOUT_S while its corridor still ran all the
 * way to (26.02, 13.09). Neither agent moved again and the person was never taken anywhere.
 * The same signature shows up on the FETCH leg in the aggregate harness
 * (`scripts/escorttest.ts`), whose timeouts cluster at a robot-to-visitor separation of
 * 1.21-1.24m -- the same equilibrium, reached from the other direction.
 *
 * ---- why 1.0 ----
 * With `separationWeight < AGENT_MAX_SPEED_MPS`, the component of the desired velocity along
 * the steering direction is at least `AGENT_MAX_SPEED_MPS - separationWeight` -- strictly
 * positive, for ANY geometry, any neighbour count and any distance -- so an agent with a valid
 * corridor always makes forward progress and this class of deadlock cannot form at all. 1.0
 * leaves 0.4 m/s (29% of top speed) of guaranteed progress, which is real margin rather than
 * the knife-edge 1.4 would be, while still holding a visible personal-space gap between agents.
 *
 * Measured on the single-escort harness across five `from_room` -> destination pairs at BOTH
 * 16.6ms and 100ms ticks: `separationWeight` 2 fails to deliver 2 of 5 pairs at 16.6ms
 * (Classroom 1425 -> Kitchen, Classroom 1425 -> Male Washroom); 1.4, 1.2 and 1.0 each deliver
 * 5 of 5 at both tick rates. Going FURTHER down is not free: 0.7 and 0.5 each newly failed
 * Kitchen -> Classroom 1425 (a different jam, where too little personal space lets the trailing
 * visitor pack into the robot), so lower is not uniformly better and 1.0 is not a "turn it down
 * until it works" number. Aggregate effect at real demo scale is in `scripts/escorttest.ts`'s
 * own recorded before/after numbers.
 *
 * The tapering `speedScale` inside the last 0.4m of a route is the one place steering can drop
 * below AGENT_MAX_SPEED_MPS, so the guarantee weakens there -- harmless, because an agent within
 * 0.4m of its goal is already inside ROBOT_DESTINATION_RADIUS_M (1.0m, escortManager.ts) and has
 * arrived.
 */
const SEPARATION_WEIGHT = 1.0;

if (SEPARATION_WEIGHT >= AGENT_MAX_SPEED_MPS) {
  // Fail loudly at import time rather than shipping a world where agents can stall forever
  // in a doorway. See SEPARATION_WEIGHT's doc comment for why this is the load-bearing
  // relationship between the two constants.
  throw new Error(
    `WorldRoom: SEPARATION_WEIGHT (${SEPARATION_WEIGHT}) must be strictly less than ` +
      `AGENT_MAX_SPEED_MPS (${AGENT_MAX_SPEED_MPS}) -- at or above it, one neighbour standing in an ` +
      "agent's path can cancel its steering completely and deadlock the crowd",
  );
}

const DEFAULT_AGENT_PARAMS: AgentParams = {
  radius: AGENT_RADIUS_M,
  height: AGENT_HEIGHT_M,
  maxAcceleration: 8,
  maxSpeed: AGENT_MAX_SPEED_MPS,
  collisionQueryRange: 2.5,
  pathOptimizationRange: 0,
  separationWeight: SEPARATION_WEIGHT,
};

/**
 * Real guide-robot fleet size, seeded on room creation (replaces the single
 * `TEST_AGENT_ID` demo robot the original Task 1.2 scaffold seeded, which left every
 * visitor past the first with no idle robot to assign -- `EscortManager.requestGuide`
 * (escortManager.ts) returns `null` when no `kind: "robot"` agent is idle, so ~44 of
 * `SIMULATED_VISITOR_TARGET`'s 45 concurrent visitors piled up motionless at the entrance
 * forever with only one robot ever moving).
 *
 * Robot ids are `"virtual/1"`..`"virtual/${GUIDE_ROBOT_COUNT}"` via `guideRobotId()` below
 * -- this exact format is load-bearing, not cosmetic: `world/src/iot/bridge.ts`'s
 * `extractRobotId` pulls the full `"virtual/<n>"` segment straight out of the MQTT topic
 * (`guidemate/virtual/<n>/cmd`) and uses it AS-IS as the `WorldRoom` agent id, and Task
 * 2.2's IAM policy scopes device access to the `guidemate/virtual/*` topic root. A robot
 * spawned here must already carry the id Moses/the IoT bridge will address it by.
 *
 * 5 robots + `SIMULATED_VISITOR_TARGET` (5, simulatedVisitorSpawner.ts) = 10 agents:
 * a deliberately small, legible scene (the earlier ~95-agent design point gridlocked the
 * floor). Well under `MAX_AGENTS` (128), leaving ample headroom for real (non-simulated)
 * visitors the IoT bridge spawns on top.
 */
export const GUIDE_ROBOT_COUNT = 5;

function guideRobotId(oneBasedIndex: number): string {
  return `virtual/${oneBasedIndex}`;
}

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

/**
 * How close (meters) a robot must be to its home charging station to count as "parked".
 * update()'s return-home block only issues a fresh move-home when a robot is idle, not
 * escorting, AND farther than this from home -- so once it settles within tolerance it stops
 * being re-targeted every tick and simply rests on its pad. 0.4m is comfortably above the
 * ~0.2m AGENT_RADIUS_M footprint (a robot resting dead-centre on its pad reads as parked) yet
 * small enough that the pad, drawn at ~0.35m radius client-side, still visually contains it.
 */
const PARK_TOLERANCE_M = 0.4;

export class WorldRoom extends Room<{ state: WorldState }> {
  private nav!: BuiltNavMesh;
  private plan!: FloorPlan;
  private crowd!: AgentCrowd;
  private visitors!: VisitorManager;
  private disposed = false;

  /**
   * Free-list of previously-used `Agent` schema instances, reused across spawn/despawn
   * cycles by `addAgent`/`removeAgent` below INSTEAD of `new Agent()` on every spawn --
   * see `addAgent`'s doc comment for the full memory-leak story this closes. Bounded by
   * construction: an instance only ever enters this pool via `removeAgent` (so its count
   * can never exceed the historical peak of `state.agents.size`, itself capped at
   * `MAX_AGENTS`), and `addAgent` always drains it before ever calling `new Agent()` again.
   */
  private readonly agentPool: Agent[] = [];

  /**
   * Each guide robot's home charging station (its deterministic spawn point, see onCreate's
   * fleet-seeding loop). update() steers an idle, not-escorting robot back to its home so it
   * parks on its pad instead of drifting where an escort happened to end -- see the
   * return-home block at the end of update(). Keyed by robot agent id; the same points are
   * also mirrored into `this.state.stations` for the client to draw the visible pads.
   */
  private readonly robotHomes = new Map<string, { x: number; z: number }>();

  /**
   * Task 3.3 (rework): each robot's CURRENT move goal (nav-space `{x, z}`), set by
   * `moveAgentTo` and read every tick by `update()`'s route-line publishing. Two jobs:
   *   1. It marks "this robot has an active goal", so a robot moving for some OTHER reason
   *      (e.g. shoved by a passing visitor before it has ever been dispatched) draws no line.
   *   2. It is the fallback endpoint when Detour's `corners()` is momentarily empty (see
   *      update()), so a line still shows on the tick a target is first set.
   * Only robots are ever tracked here -- visitors never draw a route line. Entries are
   * overwritten on each new `moveAgentTo` and dropped in `removeAgent`; a stale entry left
   * behind after a robot parks is harmless because the idle branch clears the visual line
   * regardless (it is only ever read while the robot is actually moving).
   */
  private readonly robotTargets = new Map<string, { x: number; z: number }>();

  /** Task 5.2: fleet-wide kill switch state -- see pause()/resume() below. */
  private paused = false;

  /**
   * Optional per-section timing hook, set ONLY by scripts/frametest.ts's harness (the
   * true full-frame-cost measurement task) -- no production code path ever sets this.
   * `undefined` on every real request (world/src/index.ts never touches it), and update()
   * below pays exactly one falsy property read per section boundary when it's unset --
   * zero `process.hrtime.bigint()` calls happen at all in that case, so this is a no-op on
   * the production path, not a permanent instrumentation cost.
   *
   * This exists because crowd.tick() / the schema sync loop / visitors.tick() run as three
   * back-to-back sections of ONE method with no external seam a caller could time
   * separately without either duplicating update()'s body outside this class (real drift
   * risk: a later change to update() would silently desync the copy) or reaching into
   * private fields to hand-reconstruct it (same drift risk, worse -- it could also silently
   * desync from update()'s actual control flow, e.g. the pause() early return above). A
   * tiny opt-in hook inside the real method avoids both failure modes: the code path
   * measured is always the exact code path production runs.
   */
  onUpdateSectionTiming?: (section: "crowdTick" | "schemaSync" | "visitorsTick", ms: number) => void;

  /**
   * `options.disableSimulatedVisitors` exists purely for test isolation (Task 4.1's
   * requestGuide/no-double-assignment tests want to bind specific known robots without the
   * background simulated-visitor spawner also competing for them); production room
   * creation passes no options and gets the spawner running at its default target.
   *
   * `options.disableGuideRobots` exists for the same reason: tests that want to control
   * their own exact robot population (e.g. "exactly one idle robot exists" or "here are 50
   * hand-placed test robots") would otherwise have to account for the real
   * `GUIDE_ROBOT_COUNT`-sized fleet this method seeds by default; production room creation
   * passes no options and gets the real fleet.
   *
   * `options.visitorManagerOptions` exists purely so `world/scripts/soaktest.ts` (the
   * persistent-world memory-leak soak harness) can compress the simulated-visitor
   * spawn-stagger/dwell timings to get far more spawn/despawn cycles per wall-clock minute
   * than the real demo ever would, WITHOUT touching the shipped defaults in
   * `simulatedVisitorSpawner.ts` -- production room creation passes no options and gets
   * those real defaults untouched. Deliberately a passthrough of the whole
   * `VisitorManagerOptions` bag (not individual named params) so a future option added to
   * that type is automatically injectable here too. `simulatedTarget` inside it is still
   * overridden by `disableSimulatedVisitors` below, same as before this option existed.
   */
  async onCreate(options?: {
    disableSimulatedVisitors?: boolean;
    disableGuideRobots?: boolean;
    visitorManagerOptions?: VisitorManagerOptions;
  }): Promise<void> {
    // The world-server is the authoritative simulation (per
    // docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md): Moses
    // dispatches virtual robots over IoT Core independently of any browser client, and
    // the demo runs unattended on a kiosk for hours. Colyseus's `autoDispose` defaults to
    // true, which disposes this room (and every guide-robot/visitor agent in it) the
    // moment the last WebSocket client disconnects -- a browser refresh, a projector
    // hiccup, or simply nobody currently watching the big screen. The next join then pays
    // the ~30s simulated-visitor ramp-up from zero AND, worse, world/src/index.ts's
    // `activeRoom` tracking (see its doc comment) goes undefined for that whole window, so
    // a `navigate`/`assign` command arriving from the IoT bridge acks
    // failed/"world_not_ready" even though nothing is actually wrong -- just that no
    // browser tab happened to be open. Disabling autoDispose here (verified against the
    // installed colyseus 0.17.10's typings, node_modules/@colyseus/core/build/
    // Room.d.ts's `autoDispose: boolean` property) makes the simulation persist for the
    // life of the process regardless of viewers; the room is still disposed correctly on
    // a real server shutdown because `Server.gracefullyShutdown()` -> `matchMaker.
    // gracefullyShutdown()` -> `disconnectAll()` calls `Room.disconnect()`, which force-sets
    // `autoDispose = true` before disposing (node_modules/@colyseus/core/build/Room.mjs's
    // `disconnect()`) -- so onDispose()'s native WASM cleanup below is never orphaned.
    this.autoDispose = false;

    this.setState(new WorldState());
    console.log("WorldRoom created");

    this.plan = loadFloorPlan();
    this.state.floor = this.plan.floor;
    this.nav = await buildNavMesh(this.plan);

    this.crowd = new AgentCrowd(this.nav.navMesh, {
      maxAgents: MAX_AGENTS,
      maxAgentRadius: MAX_AGENT_RADIUS_M,
    });

    if (!options?.disableGuideRobots) {
      // See guideFleetSpawns.ts's doc comment: deterministic navmesh-snapped positions
      // spread across the whole floor, NOT all stacked on the entrance point (that
      // would interpenetrate at t=0 and make Detour's local avoidance spend its first
      // several ticks shoving them apart into a scrum).
      const spawns = computeGuideFleetSpawns(this.plan, this.nav, GUIDE_ROBOT_COUNT);
      for (let i = 0; i < GUIDE_ROBOT_COUNT; i++) {
        const id = guideRobotId(i + 1);
        const spawn = spawns[i];
        this.addAgent(id, "robot", spawn);
        // Each robot's spawn point is its home charging station: remember it so update() can
        // send the robot back to park there when idle (fixing idle-drift), and publish a
        // matching Station into synced state so the client draws a visible pad at that spot.
        this.robotHomes.set(id, { x: spawn.x, z: spawn.z });
        const station = new Station();
        station.id = id;
        station.x = spawn.x;
        station.z = spawn.z;
        this.state.stations.set(id, station);
      }
    }

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
      ...options?.visitorManagerOptions,
      simulatedTarget: options?.disableSimulatedVisitors
        ? 0
        : options?.visitorManagerOptions?.simulatedTarget,
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
   *
   * Soak-test finding (world/scripts/soaktest.ts, the persistent-world memory-leak audit):
   * this used to construct a brand-new `new Agent()` on every call. That leaks, at the
   * @colyseus/schema layer, NOT anywhere in this room's own bookkeeping -- verified by a
   * churn-isolation diagnostic (same tick count/duration, spawner enabled vs. disabled):
   * +2.83MB heapUsed over 20,000 simulated seconds with the simulated-visitor spawner
   * cycling agents through this method, vs. -0.03MB (pure GC noise) over the identical
   * window with a static, never-added-to-after-boot population. Root cause (verified
   * against the installed @colyseus/schema 4.0.30's
   * node_modules/@colyseus/schema/build/index.mjs): the encoder-side `Root.remove()`
   * deletes a removed reference's entry from its `changeTrees` map but only ZEROES (never
   * deletes) its entry in `refCount`, a plain object keyed by an ever-incrementing integer
   * `refId` that every `new Agent()` (and its nested `route` ArraySchema) consumes a fresh
   * one of -- so every historical spawn leaves a permanently-dangling zero-count property
   * behind, growing with total LIFETIME spawn count, not live population. `Root.add()`
   * explicitly supports re-adding the SAME instance without minting a new refId (`if
   * (ref[$refId] === undefined)` only assigns one the first time), so reusing Agent
   * instances via `agentPool` (instead of fighting this inside a pinned third-party
   * dependency) sidesteps the leak entirely: once the pool has been primed up to this
   * room's peak concurrent agent count, `new Agent()` is never called again for the rest
   * of the process's life.
   */
  addAgent(
    id: string,
    kind: "robot" | "visitor",
    spawn: { x: number; z: number },
    name = "",
  ): boolean {
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

    const agent = this.agentPool.pop() ?? new Agent();
    agent.id = id;
    agent.kind = kind;
    agent.state = "idle";
    agent.x = spawn.x;
    agent.z = spawn.z;
    agent.heading = 0;
    // Empty by default (simulated visitors and seeded robots pass nothing); only a real
    // operator/user-supplied name sets this. Reset explicitly since a pooled Agent
    // instance may carry a previous occupant's name.
    agent.name = name;
    if (agent.route.length > 0) agent.route.clear();
    this.state.agents.set(id, agent);
    return true;
  }

  /**
   * Removes a tracked agent from both the Crowd and the synced schema -- the inverse of
   * `addAgent`. Task 4.1's simulated-visitor spawner uses this to despawn a visitor once
   * it has walked back to the entrance, freeing its spawn slot. No-op if `id` isn't
   * tracked (mirrors `AgentCrowd.removeAgent`'s own no-op-on-unknown-id behavior, so a
   * double-despawn attempt can't throw).
   *
   * Returns the removed `Agent` instance to `agentPool` instead of letting it become
   * garbage -- see `addAgent`'s doc comment for why reusing the instance (not just letting
   * it get GC'd and constructing a fresh one next time) is what actually closes the
   * @colyseus/schema refId leak this method's caller (the simulated-visitor spawner's
   * despawn/respawn cycle) would otherwise trigger continuously for the life of the room.
   */
  removeAgent(id: string): void {
    this.crowd.removeAgent(id);
    this.robotTargets.delete(id);
    const agent = this.state.agents.get(id);
    this.state.agents.delete(id);
    if (agent) this.agentPool.push(agent);
  }

  /**
   * Task 4.1: picks the nearest idle robot, binds it to `visitorId`, and sends it to
   * `roomNameOrCoords` -- the plain-TypeScript guide-assignment entry point a later task's
   * Moses/IoT bridge will call for a real visitor (this task deliberately does not touch
   * IoT/MQTT at all). Returns `{ robotId: null, reason }` if no robot is currently idle, or
   * if `roomNameOrCoords` couldn't be resolved -- see `RequestGuideResult`'s doc comment
   * (escortManager.ts) for the two distinct reasons. All of the actual bookkeeping
   * (escort-binding maps, un-binding on arrival/timeout, the simulated-visitor spawner)
   * lives in `./visitors.ts` -- see `VisitorManager.requestGuide`.
   */
  requestGuide(visitorId: string, roomNameOrCoords: string | RoomTarget): RequestGuideResult {
    return this.visitors.requestGuide(visitorId, roomNameOrCoords);
  }

  /**
   * Task 4.2: nav-space entrance point, for a caller (the IoT bridge's fleet `assign`
   * handler) that needs to spawn a brand-new "real" visitor agent via `addAgent` before
   * calling `requestGuide` -- `requestGuide` itself requires `visitorId` to already be a
   * tracked agent (see `VisitorManager.requestGuide`'s doc comment: it only lazily
   * creates the bookkeeping record, not the Crowd/schema agent), so a caller assigning a
   * visitor the room has never seen before must add it first. Returns the same point the
   * simulated-visitor spawner (`simulatedVisitorSpawner.ts`) already spawns visitors at,
   * so a freshly-assigned real visitor starts in the same place a simulated one would.
   * (The guide-robot fleet spawns spread across the floor instead -- see
   * `guideFleetSpawns.ts` -- since robots aren't arriving at the building, they're already
   * stationed and waiting to guide.)
   */
  getEntrancePoint(): { x: number; z: number } {
    return { x: this.plan.entrance.point[0], z: this.plan.entrance.point[1] };
  }

  /**
   * Resolves a room name/alias to the SAME nav-space point `moveAgentTo(id, roomName)`
   * would drive an agent to (both go through Task 1.1's `nav.findRoomTarget`, so a spawn
   * point and a navigation target for the same room name can never disagree). Returns
   * `null` if the name matches no room, or if the room's door point doesn't snap onto the
   * navmesh -- see `findRoomTarget`'s doc comment in buildNavMesh.ts.
   *
   * Added for the fleet `assign` command's optional `from_room` param (the answer to
   * Moses's "where are you in the building?"): the IoT bridge has to turn that room name
   * into a spawn point BEFORE calling `addAgent`, and there is no agent to `moveAgentTo`
   * yet at that moment. Deliberately a read-only resolver, not a second spawn helper --
   * the caller decides what to do with the point (or with `null`).
   */
  resolveRoomPoint(roomName: string): RoomTarget | null {
    return this.nav.findRoomTarget(roomName);
  }

  /** Read-only escort/spawner counters for tests and ops visibility -- see
   * `VisitorDebugStats`'s doc comments for what each field means and the invariants it's
   * meant to let a caller check (e.g. `escortedVisitors === robotBindings`). */
  getVisitorDebugStats(): VisitorDebugStats {
    return this.visitors.getDebugStats();
  }

  /** Read-only crowd-side agent count, for `world/scripts/soaktest.ts` to check that
   * `AgentCrowd`'s internal `byId`/`lastHeading` maps (crowd.ts) track `state.agents.size`
   * 1:1 over many spawn/despawn cycles -- a divergence between the two would itself be
   * evidence of a leak (an agent removed from one side but not the other), which
   * `state.agents.size` alone can't reveal since it only ever sees the schema side. */
  getCrowdAgentCount(): number {
    return this.crowd.size;
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

    // Task 3.3 (rework): remember this robot's goal so update() can publish the DISPLAY
    // route line every tick from Detour's ACTUAL remaining corridor (see
    // publishRobotRoute). Only robots draw a line, so only robots are tracked. This
    // replaces the old one-shot `navMeshQuery.computePath` snapshot taken here -- that
    // snapshot diverged from where the crowd's corridor + local avoidance actually walked
    // the agent, so the client's reconstruction of it cut across walls. There is now a
    // single source of truth: the per-tick corners.
    const agent = this.state.agents.get(agentId);
    if (agent?.kind === "robot") {
      this.robotTargets.set(agentId, { x: target.x, z: target.z });
    }
    return requested;
  }

  /**
   * Task 3.3 (rework): publishes one robot's DISPLAY route line onto its synced `route`
   * (flattened x,z pairs) from Detour's ACTUAL remaining corridor, called once per tick
   * from update() after the crowd step + schema sync. This is the single source of truth
   * for the route line, replacing the old one-shot `navMeshQuery.computePath` snapshot.
   *
   * The old snapshot was taken once at `moveAgentTo` time and never re-derived, so it
   * diverged from where the crowd's corridor + local avoidance actually walked the agent;
   * the client then reconstructed a "remaining path" off that stale polyline and drew a
   * straight connector from the robot to it that cut across walls. Re-deriving from the
   * live corridor every tick fixes that: the line always matches the movement and always
   * stays inside the navmesh. At the current small fleet (GUIDE_ROBOT_COUNT robots)
   * re-encoding a handful of points per tick is cheap, so correctness wins over the
   * cost-saving argument the one-shot approach was originally justified on.
   *
   * The line is the robot's current (x, z) PREPENDED to `crowd.corners(id)` (the
   * string-pulled remaining waypoints). Prepending the live position makes the line start
   * exactly at the robot -- and since the robot is on its own corridor, that first segment
   * stays walkable. `corners()` is inherently the remaining path, so the line shrinks as
   * the robot advances (corners get consumed).
   *
   * A line is only drawn for a robot that is actively MOVING toward a goal:
   *   - idle (arrived, greeting, parked): clear the visual route.
   *   - moving but no goal recorded (e.g. shoved before ever dispatched): clear it too.
   *   - moving with a goal but `corners()` momentarily empty: fall back to a straight
   *     current->target segment so a line still shows.
   */
  private publishRobotRoute(agent: Agent, isMoving: boolean): void {
    if (!isMoving || !this.robotTargets.has(agent.id)) {
      if (agent.route.length > 0) agent.route.clear();
      return;
    }

    const points: number[] = [agent.x, agent.z];
    const corners = this.crowd.corners(agent.id);
    if (corners.length > 0) {
      for (const c of corners) points.push(c.x, c.z);
    } else {
      const target = this.robotTargets.get(agent.id)!;
      points.push(target.x, target.z);
    }

    this.syncRouteArray(agent, points);
  }

  /**
   * Writes `points` (flattened x,z pairs) into `agent.route` only if they differ from
   * what is already there -- a light "re-encode only when the corner list actually
   * changed" guard so a robot whose corridor is unchanged this tick doesn't churn the
   * Colyseus change tree. During active movement the leading (x, z) shifts every tick so
   * this usually does rewrite, which is fine at this fleet size; the guard mainly spares
   * the redundant clear+push in the (common at the destination) case where the array is
   * already exactly equal.
   */
  private syncRouteArray(agent: Agent, points: number[]): void {
    const route = agent.route;
    if (route.length === points.length) {
      let same = true;
      for (let i = 0; i < points.length; i++) {
        if (route[i] !== points[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    route.clear();
    for (const value of points) route.push(value);
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
    const timingHook = this.onUpdateSectionTiming;

    const crowdStartNs = timingHook ? process.hrtime.bigint() : 0n;
    const snapshots = this.crowd.tick(dtSeconds);
    if (timingHook) timingHook("crowdTick", Number(process.hrtime.bigint() - crowdStartNs) / 1e6);

    const syncStartNs = timingHook ? process.hrtime.bigint() : 0n;
    for (const snap of snapshots) {
      const agent = this.state.agents.get(snap.id);
      if (!agent) continue;
      agent.x = snap.x;
      agent.z = snap.z;
      agent.heading = snap.heading;

      const isMoving = snap.speed >= IDLE_SPEED_THRESHOLD_MPS;
      agent.state = isMoving ? "moving" : "idle";

      // Task 3.3 (rework): re-derive the DISPLAY route line from Detour's ACTUAL remaining
      // corridor every tick (robots only) -- so the line always matches where the robot is
      // really walking and never crosses a wall. Idle/parked/greeting robots and visitors
      // draw nothing. See publishRobotRoute for the full rationale.
      if (agent.kind === "robot") {
        this.publishRobotRoute(agent, isMoving);
      }
    }
    if (timingHook) timingHook("schemaSync", Number(process.hrtime.bigint() - syncStartNs) / 1e6);

    // Task 4.1: escort trailing/arrival + the simulated-visitor spawner. Must run AFTER
    // the crowd tick + schema sync above -- see VisitorManager.tick's doc comment for why
    // that ordering is load-bearing for arrival detection, not just a style choice.
    const visitorsStartNs = timingHook ? process.hrtime.bigint() : 0n;
    this.visitors.tick(dtSeconds);
    if (timingHook) timingHook("visitorsTick", Number(process.hrtime.bigint() - visitorsStartNs) / 1e6);

    this.returnIdleRobotsHome();
  }

  /**
   * Sends any guide robot that is idle, not currently escorting, and off its home charging
   * station back to park on that station. Runs AFTER the escort/visitor tick above so it sees
   * this frame's final escort bindings (a robot whose escort just ended this tick is now
   * un-bound and eligible to head home) and the freshly-synced schema state/position.
   *
   * This is what fixes idle-drift: after an escort ends a robot used to get no new target, so
   * it sat wherever it stopped and the separation force from a nearby visitor slowly shoved it
   * around. Now an idle robot always has a target (its pad) until it is parked.
   *
   * The `> PARK_TOLERANCE_M` guard is load-bearing: it only issues a move-home when the robot
   * is actually away from its pad, so once parked it is NOT re-targeted every tick (which would
   * fight Detour's settle and re-arm the route line forever). A robot resting within tolerance
   * is left completely alone.
   */
  private returnIdleRobotsHome(): void {
    for (const [id, home] of this.robotHomes) {
      const agent = this.state.agents.get(id);
      if (!agent) continue;
      if (agent.state !== "idle") continue;
      if (this.visitors.isRobotEscorting(id)) continue;

      const distFromHome = Math.hypot(agent.x - home.x, agent.z - home.z);
      if (distFromHome <= PARK_TOLERANCE_M) continue;

      this.moveAgentTo(id, { x: home.x, z: home.z });
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
   * NavMesh/NavMeshQuery it steps on. This also closes the NavMesh/NavMeshQuery disposal
   * gap Task 1.1's review flagged: WorldRoom is the sole owner of all three native
   * objects, so one onDispose here resolves both.
   *
   * `onCreate()` now sets `autoDispose = false` (world persistence fix, see that method's
   * doc comment), so a client disconnecting -- even the last one -- no longer triggers
   * this on its own; the room and its native resources now live for the process lifetime.
   * This still has to run reliably on an ACTUAL server shutdown though:
   * `Server.gracefullyShutdown()` calls `Room.disconnect()`, which force-sets
   * `autoDispose = true` before disposing regardless of what onCreate() set it to (see
   * node_modules/@colyseus/core/build/Room.mjs's `disconnect()`), so this is never
   * orphaned. A test harness that constructs `WorldRoom` directly (`WorldRoom.test.ts`,
   * `visitors.test.ts`) and calls `onDispose()` explicitly is also unaffected -- this
   * method doesn't care how/why it was invoked.
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
