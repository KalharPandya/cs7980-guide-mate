import type { RoomTarget } from "../nav/buildNavMesh.js";
import type { VisitorHost } from "./visitors.js";
import { AGENT_RADIUS_M } from "../nav/agentProfile.js";

/**
 * Deferred cleanup of Task 4.1's visitors.ts (flagged by that task's reviewer): this file
 * holds the assignment/binding bookkeeping (`requestGuide`, the `robotId <-> visitorId`
 * maps) and the trailing-follow physics (the position-history "conga line" logic), i.e.
 * everything driven by the escort tick loop. The two were split out of `visitors.ts`
 * specifically BECAUSE they're tightly coupled through that loop -- `tick()`'s arrival
 * check un-binds an escort in the same pass that re-aims the trailing target, and both
 * need the same per-visitor record on every call. `simulatedVisitorSpawner.ts` holds the
 * separable concern: the simulated-visitor spawn/dwell/despawn lifecycle, which only
 * touches this module through `requestGuide` and the read-only stats below -- see that
 * file's header comment and `VisitorManager` in `visitors.ts` (the composition root that
 * wires the two together) for the full picture.
 */

type VisitorKind = "simulated" | "real";
type SimulatedPhase = "waiting_for_robot" | "walking_to_room" | "dwelling" | "walking_to_entrance";

/**
 * One record per visitor -- the single source of truth this subsystem keeps per visitor,
 * per Task 4.1's instruction to distinguish simulated/real "with a boolean/enum on the
 * visitor record, not a second parallel data structure". `robotId` is the forward half of
 * the bidirectional escort binding (the task's "Map<visitorId, robotId>"); the reverse
 * index (robotId -> visitorId, needed to filter "already escorting" robots in O(1) and to
 * make double-assignment structurally impossible) is `EscortManager.robotToVisitor` below
 * -- keeping robotId only on this record (instead of ALSO in a raw `Map<visitorId,
 * robotId>`) avoids the two ever drifting out of sync with each other.
 *
 * The `simulated*` fields are only ever read/written by `simulatedVisitorSpawner.ts` --
 * they live on this shared record (rather than a second per-visitor struct there) for the
 * same reason: a real visitor's record and a simulated visitor's record are otherwise
 * indistinguishable to `requestGuide`/the escort tick loop, and a second map keyed by the
 * same visitor id would be one more place the two could drift apart. The one exception is
 * `endEscort` below, which kicks off the "dwelling" phase transition -- see its doc comment.
 */
export interface VisitorRecord {
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
   * happens after escort ends -- is "wait for the next Moses instruction", i.e. nothing
   * this subsystem drives on its own). Owned by simulatedVisitorSpawner.ts. */
  simulatedPhase: SimulatedPhase | null;
  /** The room name this simulated visitor is (or was, mid-escort) heading to. Owned by
   * simulatedVisitorSpawner.ts. */
  simulatedTargetRoom: string | null;
  /** Countdown (simulated seconds) to the next lifecycle action: retrying requestGuide
   * while "waiting_for_robot", or ending the dwell while "dwelling". Unused in the other
   * two phases. Owned by simulatedVisitorSpawner.ts (this module only seeds it once, on
   * escort-end -- see `endEscort`). */
  simulatedCooldownSeconds: number;
}

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

/**
 * Defect fix (found by assignChain.test.ts's `testEscortEndsOnRobotArrivalNotVisitorArrival`):
 * `tick()` used to release an escort the instant the ROBOT's own schema state settled to
 * "idle", with no reference to where the VISITOR actually was. Combined with `requestGuide`
 * picking the idle robot nearest to the VISITOR's spawn (not nearest to the DESTINATION), a
 * robot that happened to already be close to the requested room finished its own trip in
 * seconds while a visitor that started far away (e.g. at the entrance) was still most of its
 * own trip away -- the binding released anyway, the robot became reassignable to someone
 * else, and `tick()` never re-aims an unbound visitor's trailing target again, so the first
 * visitor was genuinely abandoned mid-floor.
 *
 * The fix gates completion on the VISITOR having caught up to the (now-idle) robot too -- see
 * `tick()`'s `visitorCaughtUpToRobot`, which requires BOTH the visitor's own schema `state
 * === "idle"` (Detour's own "I'm done moving" signal for the FOLLOWER, the same kind of
 * signal already trusted for the robot's `robotIdleAtDestination`) AND this distance sanity
 * bound. Checking distance to the ROBOT (not a separately-resolved destination point) is
 * deliberate: the robot's own `state === "idle"` already means Detour considers IT at the
 * destination (see DOOR_TOLERANCE_M in WorldRoom.test.ts/visitors.test.ts/
 * assignChain.test.ts), so "visitor near the now-idle robot" transitively means "visitor near
 * the actual destination" -- with no new nav resolution or extra per-visitor bookkeeping
 * needed.
 *
 * This is NOT `TRAIL_DISTANCE_M + AGENT_RADIUS_M` (1.2m), even though that was the first,
 * more "reuse an existing constant" instinct -- measured against the real Detour Crowd
 * (`scripts/_debug_settle*.ts`-style harness, several room pairs, fleet enabled/disabled):
 * once the visitor's trailing target converges onto the STOPPED robot's own resting point
 * (see recordHistoryAndRetarget's doc comment -- the "conga line" history buffer flushes to
 * the robot's exact position after it stops moving), the visitor settles at ~1.4-1.65m from
 * the robot, not ~1.2m -- `separationWeight`'s local-avoidance repulsion between two
 * `collisionQueryRange`-aware agents holds a wider personal-space gap once the goal is
 * effectively "stand where the other agent's body is" than the ~1.0m TRAIL_DISTANCE_M gap
 * achievable while actively CHASING a point that's still ahead of a MOVING robot (a
 * different, less contested geometry -- see TRAIL_HISTORY_SAMPLES' doc comment). Using the
 * too-tight 1.2m bound made `visitorCaughtUpToRobot` permanently false and every escort ran
 * out the clock on ESCORT_TIMEOUT_S instead of completing on genuine arrival -- caught by
 * this fix's own test coverage before landing, not a theoretical concern. 2.5m keeps real
 * margin above the measured ~1.65m worst case while still safely excluding "visitor is still
 * out in the corridor, just between moving-fast frames" (a plainly stationary-but-nearby
 * visitor within 2.5m of an idle robot is not a state that occurs mid-route). Requiring the
 * visitor's OWN `state === "idle"` alongside this (not distance alone) is the belt-and-
 * suspenders half: it's what actually filters out "still en route, just below
 * IDLE_SPEED_THRESHOLD_MPS for one congested tick" -- distance alone can't tell that apart
 * from genuine arrival at a route that happens to pass within 2.5m of the destination.
 *
 * No deadlock: this can never make "arrived" permanently unreachable, because once the robot
 * stops, `tick()` keeps calling `recordHistoryAndRetarget` every TRAIL_UPDATE_INTERVAL_S
 * below regardless of whether `arrived` is currently true (the check failing is NOT treated
 * as "done", so the tick loop falls through to the normal trailing-update path, same as
 * mid-route) -- so the visitor keeps being re-aimed at the robot's position until it
 * genuinely settles nearby, or the ESCORT_TIMEOUT_S safety valve fires regardless if it
 * physically never can.
 */
const VISITOR_ARRIVAL_DISTANCE_M = 2.5;

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

/** Randomized "look around the room" dwell time before a simulated visitor heads back to
 * the entrance. Short, per the task spec -- this is a demo, not a real dwell simulation.
 * Read only by `endEscort` below (to seed the dwell countdown the instant an escort ends);
 * simulatedVisitorSpawner.ts owns ticking that countdown down on every subsequent call. */
const DWELL_MIN_S = 3;
const DWELL_MAX_S = 8;

/**
 * Fires once per escort ending, right before the binding is released (`tick()` has the
 * robot/visitor positions and the arrival/timeout verdict in hand at exactly that point --
 * see `tick()`'s call site). Optional, no-op by default, same "opt-in instrumentation hook
 * inside the real method" convention as `WorldRoom.ts`'s `onUpdateSectionTiming` -- no
 * production code path sets this, so it costs one falsy-property check per escort ending on
 * the real server. Exists so a measurement harness (see `scripts/escorttest.ts`) can collect
 * the full completed-vs-timed-out distribution (durations, final separation) without
 * per-completion `console.log` noise at ~45 concurrent visitors -- see that script's header
 * for why this was needed: `EscortManager` used to log ONLY on timeout, so nobody could tell
 * a healthy minority of timeouts apart from most escorts failing.
 */
export interface EscortOutcome {
  readonly visitorId: string;
  readonly robotId: string;
  readonly outcome: "completed" | "timed_out";
  /** `visitor.escortElapsedSeconds` at the moment the binding ended -- simulated time, so
   * this is correct-by-construction across a pause (see `tick()`'s doc comment). */
  readonly durationSeconds: number;
  /** Robot-to-visitor distance at the moment the binding ended. For a completed escort this
   * is by definition `<= VISITOR_ARRIVAL_DISTANCE_M`; for a timeout it's whatever the gap
   * genuinely was, which is the number that answers "did the visitor almost make it, or was
   * it never following at all". */
  readonly separationM: number;
  /** Whether the ROBOT half of `arrived` (`robotIdleAtDestination`) was true at the moment
   * the binding ended -- lets a caller tell "robot arrived, visitor just didn't catch up in
   * time" apart from "robot itself never finished its own trip either". Always `true` for a
   * completed escort (both halves of `arrived` are required); may be `true` or `false` for a
   * timeout. */
  readonly robotIdleAtDestination: boolean;
}

export interface EscortManagerOptions {
  escortTimeoutSeconds?: number;
  dwellMinSeconds?: number;
  dwellMaxSeconds?: number;
  /** See `EscortOutcome`'s doc comment. */
  onEscortOutcome?: (outcome: EscortOutcome) => void;
}

/** The subset of `VisitorDebugStats` (see visitors.ts) this module can answer on its own --
 * `simulatedActive` needs simulatedVisitorSpawner.ts's own bookkeeping, so `VisitorManager`
 * (the composition root) merges this with that module's count. */
export interface EscortDebugStats {
  /** Every visitor this module is currently tracking (simulated + real). */
  totalVisitors: number;
  /** Visitors currently bound to a robot (forward count, from visitor records). */
  escortedVisitors: number;
  /** Robots currently bound to a visitor (reverse-map count). Should always equal
   * `escortedVisitors` -- if it doesn't, the two sides of the binding have drifted, which
   * would mean a robot is (or isn't) escorting without a matching visitor-side record. */
  robotBindings: number;
  /** Lifetime count (since this `EscortManager` was constructed) of escorts that ended via
   * genuine arrival (`arrived` in `tick()`) -- a cheap running counter, not a per-completion
   * log line, so it stays safe to read cheaply from ops tooling/tests without flooding the
   * log at ~45 concurrent visitors. Pairs with `timedOutEscorts` below to answer "what
   * fraction of escorts actually complete" without needing to reconstruct it from log lines
   * (the old `console.warn`-on-timeout-only behavior this replaces made that fraction
   * unanswerable -- see `scripts/escorttest.ts`'s header for the investigation this closed). */
  completedEscorts: number;
  /** Lifetime count (since this `EscortManager` was constructed) of escorts that ended via
   * the `ESCORT_TIMEOUT_S` safety valve. Still logged once per occurrence via
   * `console.warn` (unchanged -- a timeout is an anomaly worth a log line on its own), but
   * this counter is what lets a caller see the RATE without grepping/counting log lines. */
  timedOutEscorts: number;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Defect fix (found by assignChain.test.ts's `testAssignToNonexistentRoom`): `requestGuide`
 * used to collapse two structurally different failures -- "no robot is idle" and "an idle
 * robot WAS available, but `roomNameOrCoords` didn't resolve to a reachable nav-space
 * point" -- into a single `null`, which meant `bridge.ts`'s `handleFleetCommand` always
 * attributed a failed `assign` to reason "no_idle_robot", even when idle robots were
 * plentiful and the real problem was an unresolvable room name. `"target_unresolved"` is
 * the SAME string `bridge.ts`'s per-robot `navigate` path already uses for its own
 * `moveAgentTo` failure (see `handleCommand`'s ack), reused here rather than inventing a
 * differently-named reason for what is, from the caller's point of view, the same kind of
 * failure on a different code path.
 */
export type RequestGuideFailureReason = "no_idle_robot" | "target_unresolved";

/** `requestGuide`'s result: either the bound robot's id, or `robotId: null` plus WHY no
 * robot was bound -- see `RequestGuideFailureReason`'s doc comment. Deliberately keeps
 * `robotId` present (rather than `null` as a bare sentinel) on both branches so callers can
 * narrow with a single `if (result.robotId)` check without a separate discriminant field. */
export type RequestGuideResult = { robotId: string } | { robotId: null; reason: RequestGuideFailureReason };

/**
 * Owns guide-assignment (`requestGuide`), the bidirectional escort binding, and the
 * trailing-follow physics -- everything driven once per tick by the escort loop.
 * `simulatedVisitorSpawner.ts` depends on this class (constructed first by
 * `VisitorManager` in visitors.ts and handed to the spawner), calling `requestGuide` the
 * exact same way a real Moses-driven assignment would, and using `registerVisitor`/
 * `allVisitors`/`removeVisitor` to keep its own simulated records in this module's single
 * shared visitor map (see `VisitorRecord`'s doc comment for why there's only one map).
 */
export class EscortManager {
  private readonly host: VisitorHost;
  private readonly escortTimeoutS: number;
  private readonly dwellMinS: number;
  private readonly dwellMaxS: number;
  private readonly onEscortOutcome?: (outcome: EscortOutcome) => void;

  /** Lifetime running counters backing `EscortDebugStats.completedEscorts`/`timedOutEscorts`
   * -- see those fields' doc comments. */
  private completedEscorts = 0;
  private timedOutEscorts = 0;

  /** Every visitor this subsystem knows about, keyed by visitor id. Single source of truth
   * per visitor (see VisitorRecord's doc comment). Shared with simulatedVisitorSpawner.ts
   * via `registerVisitor`/`allVisitors`/`removeVisitor` -- deliberately not two separate
   * maps, so a visitor's escort state and its simulated-lifecycle state can never disagree
   * about which visitor id they're describing. */
  private readonly visitors = new Map<string, VisitorRecord>();
  /** Reverse index: robotId -> the visitorId currently escorting with it. The thing that
   * makes "pick an idle robot that isn't already escorting" and "a robot can't be
   * double-assigned" O(1)/structural rather than a linear re-derivation every call. */
  private readonly robotToVisitor = new Map<string, string>();

  constructor(host: VisitorHost, options: EscortManagerOptions = {}) {
    this.host = host;
    this.escortTimeoutS = options.escortTimeoutSeconds ?? ESCORT_TIMEOUT_S;
    this.dwellMinS = options.dwellMinSeconds ?? DWELL_MIN_S;
    this.dwellMaxS = options.dwellMaxSeconds ?? DWELL_MAX_S;
    this.onEscortOutcome = options.onEscortOutcome;
  }

  /**
   * Picks the nearest currently-idle `kind: "robot"` agent (idle = schema `state ===
   * "idle"` AND not already bound in `robotToVisitor` -- a robot can be schema-idle for a
   * split second mid-route between two `requestMoveTarget` calls, so speed/state alone
   * isn't enough; the reverse-map check is what actually prevents double-assignment),
   * binds it to `visitorId`, and asks it to move to `roomNameOrCoords` via the host's
   * `moveAgentTo` (the exact same method a direct `WorldRoom.moveAgentTo` call would use --
   * this is deliberate: it's what lets simulatedVisitorSpawner.ts call THIS method instead
   * of duplicating the assignment logic).
   *
   * Lazily creates a `VisitorRecord` (kind "real") the first time it sees a visitor id it
   * doesn't already track -- simulatedVisitorSpawner.ts always pre-registers its own
   * visitors as kind "simulated" (via `registerVisitor`) before calling this, so by
   * construction any id that reaches this lazy-create branch is one this subsystem has
   * never spawned itself, i.e. a real visitor a later task's IoT bridge added via
   * `addAgent` directly.
   *
   * Returns `{ robotId: null, reason }` (no throw) if: `visitorId` isn't a tracked agent at
   * all, the visitor already has a robot bound, no robot is idle (all three: reason
   * "no_idle_robot"), or the target can't be resolved (reason "target_unresolved", in which
   * case nothing is bound -- a resolution failure must not consume a robot). See
   * `RequestGuideFailureReason`'s doc comment for why only the target-resolution failure
   * gets its own distinct reason.
   */
  requestGuide(visitorId: string, roomNameOrCoords: string | RoomTarget): RequestGuideResult {
    const visitorAgent = this.host.agents.get(visitorId);
    if (!visitorAgent) {
      console.warn(`EscortManager.requestGuide: unknown visitor id "${visitorId}"`);
      return { robotId: null, reason: "no_idle_robot" };
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
        `EscortManager.requestGuide: visitor "${visitorId}" already has robot "${record.robotId}" assigned`,
      );
      return { robotId: null, reason: "no_idle_robot" };
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

    if (!bestRobotId) return { robotId: null, reason: "no_idle_robot" };

    const moved = this.host.moveAgentTo(bestRobotId, roomNameOrCoords);
    // unresolvable/unreachable target -- don't bind a robot for nothing; an idle robot WAS
    // available, so this is distinctly "target_unresolved", not "no_idle_robot" (see
    // RequestGuideFailureReason's doc comment).
    if (!moved) return { robotId: null, reason: "target_unresolved" };

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

  /** Inserts a visitor record simulatedVisitorSpawner.ts built itself (kind "simulated")
   * into this module's single shared visitor map, BEFORE that visitor's first
   * `requestGuide` call -- so `requestGuide`'s lazy-create branch above sees it already
   * tracked (with kind "simulated" intact) instead of overwriting it with a fresh "real"
   * record. */
  registerVisitor(record: VisitorRecord): void {
    this.visitors.set(record.id, record);
  }

  /** Read-only iteration over every tracked visitor record, for simulatedVisitorSpawner.ts
   * to drive its own per-visitor lifecycle (filtering to `kind === "simulated"` itself --
   * this module doesn't filter on its callers' behalf so it stays agnostic of what
   * "simulated" even means beyond the one exception documented on `endEscort`). */
  allVisitors(): IterableIterator<VisitorRecord> {
    return this.visitors.values();
  }

  /** Removes a visitor's bookkeeping entirely (both the shared record and, defensively, any
   * dangling robot-side binding) -- the bookkeeping half of simulatedVisitorSpawner.ts's
   * despawn (the other half, removing the Crowd/schema agent, stays there since it's the
   * spawner that owns the agent's lifecycle end-to-end). */
  removeVisitor(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (visitor?.robotId) this.robotToVisitor.delete(visitor.robotId); // defensive; shouldn't be bound here
    this.visitors.delete(visitorId);
  }

  /** Read-only snapshot for callers/tests to check the escort-binding invariants (see
   * EscortDebugStats' doc comments) without this module exposing its internal maps. */
  getDebugStats(): EscortDebugStats {
    let escorted = 0;
    for (const visitor of this.visitors.values()) {
      if (visitor.robotId) escorted++;
    }
    return {
      totalVisitors: this.visitors.size,
      escortedVisitors: escorted,
      robotBindings: this.robotToVisitor.size,
      completedEscorts: this.completedEscorts,
      timedOutEscorts: this.timedOutEscorts,
    };
  }

  /**
   * Advances every bound escort by `dtSeconds` of simulated time: checks arrival/timeout
   * and un-binds accordingly, otherwise re-aims the trailing target on the
   * TRAIL_UPDATE_INTERVAL_S throttle.
   *
   * Must be called BEFORE `SimulatedVisitorSpawner.tick()` within the same simulated
   * frame -- see `VisitorManager.tick()` in visitors.ts (the composition root) for the
   * full three-step ordering and why it's load-bearing, not just a style choice. In short:
   * this step evaluates escorts bound on a PREVIOUS frame against agent state that already
   * had a real crowd tick applied since binding (WorldRoom.update() calls `crowd.tick()` +
   * syncs schema state before calling into this subsystem at all), which is what makes
   * "robot schema state settled back to idle" a safe, race-free ROBOT-arrival signal: a
   * robot can never go idle -> (bound this call) -> re-checked-idle within the same tick(),
   * because new bindings only happen in the spawner step, which runs after this one. The
   * robot going idle is only HALF of "arrived", though -- see VISITOR_ARRIVAL_DISTANCE_M's
   * doc comment for why completion also requires the VISITOR to have caught up to it.
   */
  tick(dtSeconds: number): void {
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
          `EscortManager: escorting robot "${visitor.robotId}" vanished mid-escort for visitor "${visitor.id}"; releasing binding`,
        );
        this.endEscort(visitor);
        continue;
      }

      visitor.escortElapsedSeconds += dtSeconds;

      // Defect fix: "arrived" used to be JUST the robot's own idle state -- see
      // VISITOR_ARRIVAL_DISTANCE_M's doc comment for why that stranded visitors that
      // started far from a robot which happened to be close to the destination. Now it
      // also requires the VISITOR to have closed the gap to the (idle) robot. When the
      // robot is idle but the visitor hasn't caught up yet, `arrived` is false and this
      // falls through to the normal trailing-update path below every tick, same as
      // mid-route -- so the visitor keeps getting re-aimed at the robot's (now stationary)
      // position until it does catch up, or the timeout below fires regardless.
      const robotIdleAtDestination =
        visitor.escortElapsedSeconds >= ARRIVAL_GRACE_PERIOD_S && robotAgent.state === "idle";
      // Requires the visitor's OWN state to also be "idle" (Detour's own "I stopped moving"
      // signal for the follower), not distance alone -- see VISITOR_ARRIVAL_DISTANCE_M's doc
      // comment for why: distance alone can't tell "still actively closing the gap, just
      // below IDLE_SPEED_THRESHOLD_MPS for one tick" apart from "genuinely settled nearby".
      const visitorCaughtUpToRobot =
        visitorAgent.state === "idle" &&
        Math.hypot(visitorAgent.x - robotAgent.x, visitorAgent.z - robotAgent.z) <=
          VISITOR_ARRIVAL_DISTANCE_M;
      const arrived = robotIdleAtDestination && visitorCaughtUpToRobot;
      const timedOut = !arrived && visitor.escortElapsedSeconds >= this.escortTimeoutS;

      if (arrived || timedOut) {
        if (timedOut) {
          console.warn(
            `EscortManager: escort timeout for visitor "${visitor.id}" / robot "${visitor.robotId}" ` +
              `after ${visitor.escortElapsedSeconds.toFixed(1)}s -- releasing binding`,
          );
          this.timedOutEscorts++;
        } else {
          this.completedEscorts++;
        }
        // Deliberately fires BEFORE endEscort() below -- endEscort() nulls visitor.robotId
        // and resets escortElapsedSeconds, and this hook's whole point (see EscortOutcome's
        // doc comment) is to report the state the escort actually ended in, not the reset
        // state right after.
        this.onEscortOutcome?.({
          visitorId: visitor.id,
          robotId: visitor.robotId,
          outcome: timedOut ? "timed_out" : "completed",
          durationSeconds: visitor.escortElapsedSeconds,
          separationM: Math.hypot(visitorAgent.x - robotAgent.x, visitorAgent.z - robotAgent.z),
          robotIdleAtDestination,
        });
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

  /**
   * Un-binds `visitor` from its robot (freeing the robot back to idle-for-assignment) and,
   * for a simulated visitor, kicks off its post-escort dwell.
   *
   * That dwell kickoff is the one place this module reaches past pure escort bookkeeping
   * into simulatedVisitorSpawner.ts's territory (`simulatedPhase`/`simulatedCooldownSeconds`).
   * It stays here rather than behind a callback into the spawner because the ordering is
   * load-bearing: `VisitorManager.tick()` runs this escort step BEFORE the spawner's own
   * lifecycle step in the SAME simulated frame, and the spawner's "dwelling" case expects
   * to find the cooldown already seeded (and starts counting it down) the instant the
   * escort ends -- splitting that into a same-frame callback round-trip would add
   * indirection without removing the coupling, since the two still have to agree on what
   * "escort just ended" means for a simulated visitor. A real visitor (kind "real") has no
   * further lifecycle here -- it waits for the next Moses instruction, which is a later
   * task's concern.
   */
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
}
