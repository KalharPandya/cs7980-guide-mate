import type { MapSchema } from "@colyseus/schema";

import type { Agent } from "./schema/WorldState.js";
import type { BuiltNavMesh, RoomTarget } from "../nav/buildNavMesh.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";

/**
 * Task 4.1: server-side simulated-visitor spawner + guide-assignment bookkeeping,
 * factored out of WorldRoom.ts so that file doesn't sprawl. WorldRoom owns one
 * `VisitorManager` instance and:
 *   - exposes its own `requestGuide()` as a one-line passthrough to this module's
 *     `requestGuide()` (the plan requires the PUBLIC method to live on WorldRoom; the
 *     bookkeeping/logic behind it lives here).
 *   - calls `tick(dtSeconds)` once per `WorldRoom.update()`, AFTER the crowd tick + schema
 *     sync (see the ordering note on `tick()` below -- it's load-bearing for arrival
 *     detection, not just a style choice).
 *
 * `VisitorHost` is the narrow slice of WorldRoom this module needs: the already-built
 * nav/plan (read-only, stable for the room's lifetime), the live synced agents map, and
 * three callbacks that route back through WorldRoom's own `addAgent`/`removeAgent`/
 * `moveAgentTo` (so the "both the Crowd and the schema move together" invariant those
 * methods already enforce isn't duplicated here) plus a raw `requestMoveTarget` for the
 * visitor-trailing case, which deliberately bypasses `moveAgentTo` -- see `updateTrailTarget`.
 */
export interface VisitorHost {
  readonly plan: FloorPlan;
  readonly nav: BuiltNavMesh;
  readonly agents: MapSchema<Agent>;
  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): void;
  removeAgent(id: string): void;
  moveAgentTo(agentId: string, roomNameOrCoords: string | RoomTarget): boolean;
  requestMoveTarget(agentId: string, target: { x: number; z: number }): boolean;
}

/** ~45 concurrent simulated visitors is the Phase 4 target headcount (matches
 * scripts/loadtest.ts's "50 robots + 45 visitors" 95-agent design point). Exported so
 * tests can reference the same number instead of a duplicated magic constant. */
export const SIMULATED_VISITOR_TARGET = 45;

/** Minimum gap between successive spawn attempts, in simulated seconds. This is what
 * staggers the initial ramp-up (spawning 45 visitors 0.5s apart takes ~22.5s of simulated
 * time to fill, instead of one instantaneous burst on tick 1) and also throttles retries
 * once at target. */
const SPAWN_STAGGER_INTERVAL_S = 0.5;

/** How often a visitor stuck in "waiting_for_robot" (spawned, but no idle robot was free
 * yet) retries `requestGuide`. Short enough that a robot freeing up gets noticed quickly,
 * long enough not to spam requestGuide's O(robots) scan every tick for every waiting visitor. */
const ROBOT_RETRY_INTERVAL_S = 1.0;

/** Randomized "look around the room" dwell time before a simulated visitor heads back to
 * the entrance. Short, per the task spec -- this is a demo, not a real dwell simulation. */
const DWELL_MIN_S = 3;
const DWELL_MAX_S = 8;

/** Safety valve for an escort that never reaches "idle" (e.g. a target that turned out to
 * be unreachable after all, or the robot got stuck). 90s is a generous multiple of the
 * ~33s worst-case single-robot convergence time observed in WorldRoom.test.ts's
 * Classroom-1425 run, so a real in-progress escort should never hit this in practice --
 * it exists purely so a stuck escort can't wedge a robot/visitor pair forever. */
const ESCORT_TIMEOUT_S = 90;

/**
 * Minimum simulated seconds an escort must have existed before its robot's schema `state
 * === "idle"` is trusted as "arrived". Without this, binding can misfire on its very first
 * real crowd tick: empirically (two agents added at nearly the same point, one of them
 * immediately re-targeted), the newly-bound robot's realized speed on that first tick can
 * still read below IDLE_SPEED_THRESHOLD_MPS -- not because it arrived, but because Detour
 * hasn't ramped up its avoidance-adjusted velocity yet with another agent that close --
 * which would otherwise read as instant arrival and un-bind the escort before the robot
 * ever moved. 0.3s is many multiples of a single ~16ms tick (so it fully absorbs that
 * startup blip) but negligible against real inter-room travel times of several seconds+,
 * so it doesn't meaningfully delay genuine arrivals.
 */
const ARRIVAL_GRACE_PERIOD_S = 0.3;

/** Target trailing gap behind the escorting robot. AGENT_RADIUS_M is 0.2m, so 1.0m leaves
 * ~0.6m of clear space between the two agents' collision circles -- enough that the
 * visitor doesn't visually overlap/collide with the robot it's following, small enough to
 * read as "being led" rather than "wandering independently nearby" at demo camera distance. */
const TRAIL_DISTANCE_M = 1.0;

/** How often the visitor's trailing target is re-aimed while under escort (and how often a
 * robot-position sample is recorded into the history buffer below). Re-issuing
 * `requestMoveTarget` every physics tick (up to 45 escorted visitors at once) would mean up
 * to 45 corridor replans per frame for a purely cosmetic "stay behind the leader" effect;
 * ~6-7Hz is well above the rate a human eye needs to read "the visitor is following the
 * robot" and cuts replan cost ~9x at the default 60Hz tick. */
const TRAIL_UPDATE_INTERVAL_S = 0.15;

/**
 * The trailing target is a point from the robot's OWN recent-position history (a small
 * "conga line" buffer), NOT a live geometric offset behind its current heading.
 *
 * The geometric-offset version was tried first and empirically deadlocks: a point
 * `TRAIL_DISTANCE_M` behind the robot's CURRENT heading sits, by construction, on (or very
 * near) the corridor the robot is about to curve through next. Since that point is always
 * within the default `collisionQueryRange` (2.5m) of the robot, Detour's own local
 * avoidance treats the visitor as a dynamic obstacle directly in the robot's path that
 * never goes away (it keeps pursuing along the same curve) -- observed on real floor-plan
 * geometry (Classroom 1426's door to Classroom 1425's door, ~5m apart) as the robot's
 * velocity gradually decaying to zero and permanently stalling ~4m short of its target,
 * confirmed via a debug harness that a STATIONARY nearby agent does NOT reproduce (the
 * robot routes around a stationary agent and completes its move fine) -- it's specifically
 * the continuous chase that deadlocks it.
 *
 * Sampling the robot's position every TRAIL_UPDATE_INTERVAL_S and aiming the visitor at the
 * OLDEST sample instead fixes this by construction: that point is ground the robot has
 * already vacated (it walked there and moved on), so it can never coincide with the robot's
 * current or future path -- there's no "moving obstacle in the way" for Detour to fight.
 * TRAIL_HISTORY_SAMPLES is derived so the oldest sample is roughly `TRAIL_DISTANCE_M` behind
 * at the robot's max speed, so a config change to either constant keeps them in sync instead
 * of a hand-computed number silently drifting stale.
 */
const ASSUMED_ROBOT_SPEED_MPS = 1.4; // matches WorldRoom.ts's DEFAULT_AGENT_PARAMS.maxSpeed
const TRAIL_HISTORY_SAMPLES = Math.max(
  1,
  Math.round(TRAIL_DISTANCE_M / ASSUMED_ROBOT_SPEED_MPS / TRAIL_UPDATE_INTERVAL_S),
);

type VisitorKind = "simulated" | "real";
type SimulatedPhase = "waiting_for_robot" | "walking_to_room" | "dwelling" | "walking_to_entrance";

/**
 * One record per visitor -- the single source of truth this module keeps per visitor,
 * per the task's instruction to distinguish simulated/real "with a boolean/enum on the
 * visitor record, not a second parallel data structure". `robotId` is the forward half of
 * the bidirectional escort binding (the task's "Map<visitorId, robotId>"); the reverse
 * index (robotId -> visitorId, needed to filter "already escorting" robots in O(1) and to
 * make double-assignment structurally impossible) is `VisitorManager.robotToVisitor`
 * below -- keeping robotId only on this record (instead of ALSO in a raw
 * `Map<visitorId, robotId>`) avoids the two ever drifting out of sync with each other.
 */
interface VisitorRecord {
  readonly id: string;
  readonly kind: VisitorKind;
  robotId: string | null;
  /** Simulated-time seconds this visitor has been under its current escort binding;
   * reset on bind, only meaningful while `robotId != null`. Drives the ESCORT_TIMEOUT_S
   * safety valve. */
  escortElapsedSeconds: number;
  /** Simulated-time seconds since the last trailing-target re-aim; only meaningful while
   * `robotId != null`. Drives the TRAIL_UPDATE_INTERVAL_S throttle. */
  escortSinceLastTrailUpdateSeconds: number;
  /** Rolling "conga line" buffer of the escorting robot's recent (x, z) positions, oldest
   * first, capped at TRAIL_HISTORY_SAMPLES entries; only meaningful while `robotId != null`.
   * See TRAIL_HISTORY_SAMPLES's doc comment for why the trailing target is drawn from this
   * instead of a live heading offset. */
  robotPositionHistory: { x: number; z: number }[];
  /** Simulated-visitor lifecycle state; `null` for "real" visitors (their lifecycle -- what
   * happens after escort ends -- is "wait for the next Moses instruction", i.e. nothing this
   * module drives). */
  simulatedPhase: SimulatedPhase | null;
  /** The room name this simulated visitor is (or was, mid-escort) heading to. */
  simulatedTargetRoom: string | null;
  /** Countdown (simulated seconds) to the next lifecycle action: retrying requestGuide
   * while "waiting_for_robot", or ending the dwell while "dwelling". Unused in the other
   * two phases. */
  simulatedCooldownSeconds: number;
}

export interface VisitorManagerOptions {
  /** Target concurrent simulated-visitor count. 0 disables the spawner entirely (useful
   * for tests that want to call `requestGuide` directly without the background spawner
   * competing for robots) while leaving `requestGuide` itself fully usable. Defaults to
   * `SIMULATED_VISITOR_TARGET`. */
  simulatedTarget?: number;
  spawnStaggerSeconds?: number;
  dwellMinSeconds?: number;
  dwellMaxSeconds?: number;
  escortTimeoutSeconds?: number;
}

export interface VisitorDebugStats {
  /** Every visitor this module is currently tracking (simulated + real). */
  totalVisitors: number;
  /** Visitors with `kind === "simulated"` currently tracked (i.e. not yet despawned) --
   * this is the number Task 4.1's acceptance criteria calls "the concurrent count". */
  simulatedActive: number;
  /** Visitors currently bound to a robot (forward count, from visitor records). */
  escortedVisitors: number;
  /** Robots currently bound to a visitor (reverse-map count). Should always equal
   * `escortedVisitors` -- if it doesn't, the two sides of the binding have drifted, which
   * would mean a robot is (or isn't) escorting without a matching visitor-side record. */
  robotBindings: number;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class VisitorManager {
  private readonly host: VisitorHost;
  private readonly simulatedTarget: number;
  private readonly spawnStaggerS: number;
  private readonly dwellMinS: number;
  private readonly dwellMaxS: number;
  private readonly escortTimeoutS: number;

  /** Every visitor this module knows about, keyed by visitor id. Single source of truth
   * per visitor (see VisitorRecord's doc comment). */
  private readonly visitors = new Map<string, VisitorRecord>();
  /** Reverse index: robotId -> the visitorId currently escorting with it. The thing that
   * makes "pick an idle robot that isn't already escorting" and "a robot can't be
   * double-assigned" O(1)/structural rather than a linear re-derivation every call. */
  private readonly robotToVisitor = new Map<string, string>();

  private spawnCooldownSeconds: number;
  private nextSimulatedId = 0;

  constructor(host: VisitorHost, options: VisitorManagerOptions = {}) {
    this.host = host;
    this.simulatedTarget = options.simulatedTarget ?? SIMULATED_VISITOR_TARGET;
    this.spawnStaggerS = options.spawnStaggerSeconds ?? SPAWN_STAGGER_INTERVAL_S;
    this.dwellMinS = options.dwellMinSeconds ?? DWELL_MIN_S;
    this.dwellMaxS = options.dwellMaxSeconds ?? DWELL_MAX_S;
    this.escortTimeoutS = options.escortTimeoutSeconds ?? ESCORT_TIMEOUT_S;

    // Stagger the very FIRST spawn too (not just subsequent ones) so a freshly-created
    // room doesn't burst all 45 in the same tick just because spawnCooldownSeconds started
    // at 0 -- see the "stagger initial spawns" requirement.
    this.spawnCooldownSeconds = this.simulatedTarget > 0 ? randomBetween(0, this.spawnStaggerS) : Infinity;
  }

  /**
   * Picks the nearest currently-idle `kind: "robot"` agent (idle = schema `state ===
   * "idle"` AND not already bound in `robotToVisitor` -- a robot can be schema-idle for a
   * split second mid-route between two `requestMoveTarget` calls, so speed/state alone
   * isn't enough; the reverse-map check is what actually prevents double-assignment),
   * binds it to `visitorId`, and asks it to move to `roomNameOrCoords` via the host's
   * `moveAgentTo` (the exact same method a direct `WorldRoom.moveAgentTo` call would use --
   * this is deliberate: it's what lets the simulated spawner below call THIS method
   * instead of duplicating the assignment logic).
   *
   * Lazily creates a `VisitorRecord` (kind "real") the first time it sees a visitor id it
   * doesn't already track -- the simulated spawner always pre-registers its own visitors
   * as kind "simulated" before calling this, so by construction any id that reaches this
   * lazy-create branch is one this module has never spawned itself, i.e. a real visitor a
   * later task's IoT bridge added via `addAgent` directly.
   *
   * Returns `null` (no throw) if: `visitorId` isn't a tracked agent at all, the visitor
   * already has a robot bound, no robot is idle, or the target can't be resolved (in which
   * case nothing is bound -- a resolution failure must not consume a robot).
   */
  requestGuide(visitorId: string, roomNameOrCoords: string | RoomTarget): { robotId: string } | null {
    const visitorAgent = this.host.agents.get(visitorId);
    if (!visitorAgent) {
      console.warn(`VisitorManager.requestGuide: unknown visitor id "${visitorId}"`);
      return null;
    }

    let record = this.visitors.get(visitorId);
    if (!record) {
      record = {
        id: visitorId,
        kind: "real",
        robotId: null,
        escortElapsedSeconds: 0,
        escortSinceLastTrailUpdateSeconds: 0,
        robotPositionHistory: [],
        simulatedPhase: null,
        simulatedTargetRoom: null,
        simulatedCooldownSeconds: 0,
      };
      this.visitors.set(visitorId, record);
    }

    if (record.robotId) {
      console.warn(
        `VisitorManager.requestGuide: visitor "${visitorId}" already has robot "${record.robotId}" assigned`,
      );
      return null;
    }

    let bestRobotId: string | null = null;
    let bestDistance = Infinity;
    for (const [id, agent] of this.host.agents) {
      if (agent.kind !== "robot") continue;
      if (agent.state !== "idle") continue;
      if (this.robotToVisitor.has(id)) continue; // already escorting -- not idle for OUR purposes

      const distance = Math.hypot(agent.x - visitorAgent.x, agent.z - visitorAgent.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRobotId = id;
      }
    }

    if (!bestRobotId) return null;

    const moved = this.host.moveAgentTo(bestRobotId, roomNameOrCoords);
    if (!moved) return null; // unresolvable/unreachable target -- don't bind a robot for nothing

    this.robotToVisitor.set(bestRobotId, visitorId);
    record.robotId = bestRobotId;
    record.escortElapsedSeconds = 0;
    record.escortSinceLastTrailUpdateSeconds = 0;
    record.robotPositionHistory = [];

    // Seed the visitor's trailing target immediately (one history sample + retarget)
    // rather than waiting for the first TRAIL_UPDATE_INTERVAL_S window to elapse, so it
    // starts moving the same tick the robot does instead of sitting still for up to 0.15s.
    const robotAgent = this.host.agents.get(bestRobotId);
    if (robotAgent) this.recordHistoryAndRetarget(record, robotAgent);

    return { robotId: bestRobotId };
  }

  /** Read-only snapshot for callers/tests to check the escort-binding invariants (see
   * VisitorDebugStats' doc comments) without this module exposing its internal maps. */
  getDebugStats(): VisitorDebugStats {
    let escorted = 0;
    let simulatedActive = 0;
    for (const visitor of this.visitors.values()) {
      if (visitor.robotId) escorted++;
      if (visitor.kind === "simulated") simulatedActive++;
    }
    return {
      totalVisitors: this.visitors.size,
      simulatedActive,
      escortedVisitors: escorted,
      robotBindings: this.robotToVisitor.size,
    };
  }

  /**
   * Advances everything this module owns by `dtSeconds` of simulated time. Call ORDER
   * within this method matters, and so does WHEN the caller invokes `tick()` relative to
   * its own crowd step:
   *
   *   1. `tickEscorts` first, so an escort bound on a PREVIOUS call is evaluated against
   *      agent state that has already had at least one real crowd tick applied to it since
   *      binding (WorldRoom.update() calls `crowd.tick()` + syncs schema state BEFORE
   *      calling this method -- see WorldRoom.ts). That ordering is what makes "robot
   *      schema state settled back to idle" a safe, race-free arrival signal on its own:
   *      a robot can never go idle -> (bound this call) -> re-checked-idle within the SAME
   *      tick(), because binding happens in step 2/3, AFTER this step already ran.
   *   2. `tickSimulatedSpawner` may bind a NEW escort (via requestGuide, called with a
   *      target robot that is schema-idle right now). Its arrival won't be (mis)checked
   *      until the NEXT tick() call, by which point a real crowd tick has run -- see (1).
   *   3. `tickSimulatedLifecycle` last, so a visitor that JUST started dwelling (via
   *      tickEscorts ending its escort this same call) doesn't also immediately re-evaluate
   *      its (freshly reset) dwell cooldown in the same pass.
   */
  tick(dtSeconds: number): void {
    this.tickEscorts(dtSeconds);
    this.tickSimulatedSpawner(dtSeconds);
    this.tickSimulatedLifecycle(dtSeconds);
  }

  private tickEscorts(dtSeconds: number): void {
    for (const visitor of this.visitors.values()) {
      if (!visitor.robotId) continue;

      const visitorAgent = this.host.agents.get(visitor.id);
      if (!visitorAgent) {
        // Visitor vanished out from under us (shouldn't happen via this module's own API,
        // but never leave a dangling robot-side binding if it does).
        this.robotToVisitor.delete(visitor.robotId);
        this.visitors.delete(visitor.id);
        continue;
      }

      const robotAgent = this.host.agents.get(visitor.robotId);
      if (!robotAgent) {
        console.warn(
          `VisitorManager: escorting robot "${visitor.robotId}" vanished mid-escort for visitor "${visitor.id}"; releasing binding`,
        );
        this.endEscort(visitor);
        continue;
      }

      visitor.escortElapsedSeconds += dtSeconds;

      const arrived =
        visitor.escortElapsedSeconds >= ARRIVAL_GRACE_PERIOD_S && robotAgent.state === "idle";
      const timedOut = !arrived && visitor.escortElapsedSeconds >= this.escortTimeoutS;

      if (arrived || timedOut) {
        if (timedOut) {
          console.warn(
            `VisitorManager: escort timeout for visitor "${visitor.id}" / robot "${visitor.robotId}" ` +
              `after ${visitor.escortElapsedSeconds.toFixed(1)}s -- releasing binding`,
          );
        }
        this.endEscort(visitor);
        continue;
      }

      visitor.escortSinceLastTrailUpdateSeconds += dtSeconds;
      if (visitor.escortSinceLastTrailUpdateSeconds >= TRAIL_UPDATE_INTERVAL_S) {
        visitor.escortSinceLastTrailUpdateSeconds = 0;
        this.recordHistoryAndRetarget(visitor, robotAgent);
      }
    }
  }

  /** Un-binds `visitor` from its robot (freeing the robot back to idle-for-assignment) and
   * transitions a simulated visitor into its post-escort dwell; a real visitor is simply
   * left unescorted (kind "real" has no further lifecycle here -- it waits for the next
   * Moses instruction, which is a later task's concern). */
  private endEscort(visitor: VisitorRecord): void {
    if (visitor.robotId) this.robotToVisitor.delete(visitor.robotId);
    visitor.robotId = null;
    visitor.escortElapsedSeconds = 0;
    visitor.escortSinceLastTrailUpdateSeconds = 0;
    visitor.robotPositionHistory = [];

    if (visitor.kind === "simulated") {
      visitor.simulatedPhase = "dwelling";
      visitor.simulatedCooldownSeconds = randomBetween(this.dwellMinS, this.dwellMaxS);
    }
  }

  /**
   * Records the robot's current position into the escort's history buffer, then re-aims
   * the visitor's own Crowd target at the OLDEST sample in that buffer (see
   * TRAIL_HISTORY_SAMPLES's doc comment for why "history point" instead of "live heading
   * offset"). The sample is snapped onto the navmesh via `findClosestPoint` (belt-and-
   * suspenders -- the robot's own position should already be on-mesh, but this is the same
   * snapping `buildNavMesh.ts`'s `findRoomTarget` relies on, so it costs nothing to reuse).
   *
   * Deliberately calls the host's raw `requestMoveTarget` -- NOT `moveAgentTo` -- because
   * `moveAgentTo` also computes and publishes the Task 3.3 glowing route-line polyline,
   * which is meaningless (and would be needlessly expensive, recomputed every
   * TRAIL_UPDATE_INTERVAL_S) for a constantly-moving "stay behind the leader" target that
   * isn't a real destination.
   *
   * No-ops the retarget (leaving the visitor's previous target in place; the history
   * sample is still recorded) if the oldest sample doesn't snap onto the navmesh -- a
   * missed re-aim this cycle isn't worth failing the escort over.
   */
  private recordHistoryAndRetarget(visitor: VisitorRecord, robotAgent: { x: number; z: number }): void {
    const history = visitor.robotPositionHistory;
    history.push({ x: robotAgent.x, z: robotAgent.z });
    while (history.length > TRAIL_HISTORY_SAMPLES) history.shift();

    const trailPoint = history[0];
    const snap = this.host.nav.navMeshQuery.findClosestPoint({ x: trailPoint.x, y: 0, z: trailPoint.z });
    if (!snap.success) return;

    this.host.requestMoveTarget(visitor.id, { x: snap.point.x, z: snap.point.z });
  }

  private countActiveSimulated(): number {
    let count = 0;
    for (const visitor of this.visitors.values()) {
      if (visitor.kind === "simulated") count++;
    }
    return count;
  }

  /**
   * Maintains ~`simulatedTarget` concurrent simulated visitors: spawns one at a time (never
   * more than one per `spawnStaggerS` window, which both staggers the initial ramp-up and
   * throttles the "still below target" retry rate) whenever the current simulated count is
   * below target.
   */
  private tickSimulatedSpawner(dtSeconds: number): void {
    if (this.simulatedTarget <= 0) return;

    this.spawnCooldownSeconds -= dtSeconds;
    if (this.spawnCooldownSeconds > 0) return;
    this.spawnCooldownSeconds = this.spawnStaggerS;

    if (this.countActiveSimulated() >= this.simulatedTarget) return;

    const id = `sim-visitor-${this.nextSimulatedId++}`;
    const spawn = { x: this.host.plan.entrance.point[0], z: this.host.plan.entrance.point[1] };
    this.host.addAgent(id, "visitor", spawn);

    const room = this.pickRandomRoom();
    const record: VisitorRecord = {
      id,
      kind: "simulated",
      robotId: null,
      escortElapsedSeconds: 0,
      escortSinceLastTrailUpdateSeconds: 0,
      robotPositionHistory: [],
      simulatedPhase: "waiting_for_robot",
      simulatedTargetRoom: room,
      simulatedCooldownSeconds: 0,
    };
    this.visitors.set(id, record);

    this.tryStartEscort(record);
  }

  private pickRandomRoom(): string {
    const rooms = this.host.plan.rooms;
    return rooms[Math.floor(Math.random() * rooms.length)].name;
  }

  /** Attempts to bind a robot for a "waiting_for_robot" simulated visitor via the exact
   * same `requestGuide` a real Moses-driven assign would use. On failure (no idle robot
   * right now), stays in "waiting_for_robot" and arms a short retry cooldown instead of
   * despawning -- a spawned-but-not-yet-escorted visitor is still a "concurrent visitor"
   * for the purposes of the ~45-target headcount. */
  private tryStartEscort(record: VisitorRecord): void {
    const result = this.requestGuide(record.id, record.simulatedTargetRoom!);
    if (result) {
      record.simulatedPhase = "walking_to_room";
    } else {
      record.simulatedCooldownSeconds = ROBOT_RETRY_INTERVAL_S;
    }
  }

  /** Advances the non-escort parts of each simulated visitor's lifecycle:
   * "waiting_for_robot" retries requestGuide on cooldown; "dwelling" counts down then
   * sends the visitor walking back to the entrance (solo -- no robot needed to leave);
   * "walking_to_entrance" despawns once the visitor's own schema state settles back to
   * "idle" (the same settled-idle signal `tickEscorts` uses for robot arrival, applied
   * here to the visitor's own agent instead of an escorting robot's). "walking_to_room" is
   * intentionally not handled here -- that phase is entirely driven by `tickEscorts`. */
  private tickSimulatedLifecycle(dtSeconds: number): void {
    for (const visitor of this.visitors.values()) {
      if (visitor.kind !== "simulated") continue;

      switch (visitor.simulatedPhase) {
        case "waiting_for_robot": {
          visitor.simulatedCooldownSeconds -= dtSeconds;
          if (visitor.simulatedCooldownSeconds <= 0) this.tryStartEscort(visitor);
          break;
        }

        case "dwelling": {
          visitor.simulatedCooldownSeconds -= dtSeconds;
          if (visitor.simulatedCooldownSeconds <= 0) {
            visitor.simulatedPhase = "walking_to_entrance";
            const entrance = {
              x: this.host.plan.entrance.point[0],
              z: this.host.plan.entrance.point[1],
            };
            const ok = this.host.moveAgentTo(visitor.id, entrance);
            if (!ok) {
              // The entrance should always be reachable; don't strand the visitor forever
              // if it somehow isn't.
              console.warn(
                `VisitorManager: could not route simulated visitor "${visitor.id}" back to the entrance; despawning`,
              );
              this.despawn(visitor.id);
            }
          }
          break;
        }

        case "walking_to_entrance": {
          const agent = this.host.agents.get(visitor.id);
          if (agent && agent.state === "idle") this.despawn(visitor.id);
          break;
        }

        case "walking_to_room":
        default:
          break;
      }
    }
  }

  /** Removes a simulated visitor entirely (both the Crowd/schema agent via the host, and
   * this module's own bookkeeping), freeing its spawn slot for a fresh visitor on a later
   * `tickSimulatedSpawner` call. */
  private despawn(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (visitor?.robotId) this.robotToVisitor.delete(visitor.robotId); // defensive; shouldn't be bound here
    this.visitors.delete(visitorId);
    this.host.removeAgent(visitorId);
  }
}
