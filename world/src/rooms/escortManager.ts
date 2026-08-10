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
type SimulatedPhase = "waiting_for_robot" | "walking_to_room" | "dwelling";

/**
 * The three phases of a single escort, driven by `EscortManager.tick()`:
 *  - "approaching": the robot navigates to the PERSON's current location; the person waits
 *    in place (no trailing yet).
 *  - "greeting": the robot has reached the person; both stay put for a randomized
 *    GREET_MIN_S..GREET_MAX_S pause.
 *  - "leading": the robot heads to the stored destination and the person now follows behind
 *    it (the existing "conga line" trailing), releasing only once the ROBOT is measurably at
 *    that destination and the person has caught up to it.
 * `null` whenever the visitor isn't bound to a robot (mirrors `robotId` being null).
 */
type EscortPhase = "approaching" | "greeting" | "leading";

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
  /** Which of the three escort phases this visitor is currently in (see `EscortPhase`);
   * `null` whenever `robotId == null`. Set to "approaching" on bind, advanced by
   * `EscortManager.tick()`. */
  escortPhase: EscortPhase | null;
  /** Countdown (simulated seconds) remaining in the "greeting" pause; only meaningful while
   * `escortPhase === "greeting"`. Seeded to a random GREET_MIN_S..GREET_MAX_S when the robot
   * reaches the person, ticked down each frame, transitions to "leading" at <= 0. */
  greetSecondsRemaining: number;
  /** Where the robot should lead the person once the greeting ends, resolved to a nav-space
   * point at bind time (a real visitor's destination is passed to `requestGuide`; a
   * simulated visitor's is `simulatedTargetRoom`). Persisted for ALL bound escorts because
   * `requestGuide` now sends the robot to the PERSON first, so the destination has to be
   * remembered for the later "leading" phase instead of being used immediately. `null`
   * whenever `robotId == null`. */
  escortDestination: RoomTarget | null;
  /**
   * The destination point the ROBOT was ACTUALLY dispatched to when the guide leg started --
   * set (from `escortDestination`) only once `moveAgentTo` has accepted the move at the
   * "greeting" -> "leading" transition, `null` at every other moment of the escort's life.
   *
   * Deliberately a SEPARATE field from `escortDestination` rather than a re-read of it, because
   * it carries a different fact. `escortDestination` means "where this person asked to go" and
   * is set the instant the escort binds -- it is already true throughout the fetch leg, before
   * the robot has been pointed at it at all. This field means "the guide leg is genuinely under
   * way: the robot has been told to go there", which is the precondition the completion test
   * needs and the one whose absence caused the defect below. Being non-null is therefore both
   * the point to measure the robot against AND the "was actually dispatched" flag; if the
   * dispatch is ever refused, this stays `null`, no completion test can pass, and the escort
   * ends on the ESCORT_TIMEOUT_S valve instead of falsely reporting success.
   *
   * DEFECT THIS CLOSES (reproduced against the real WorldRoom on floor-14.json): a visitor
   * standing in "Classroom 1425" asked to be taken to the "Kitchen" (20.3m away) and the nearest
   * idle robot happened to spawn 2.96m from them. The robot finished its FETCH leg normally, so
   * at the instant the phase flipped to "leading" it was standing next to the person AND
   * schema-idle (it had just stopped). The robot half of the completion test accepted a bare
   * `robotAgent.state === "idle"` as "the robot has arrived", and the visitor half was satisfied
   * because the person it had just walked over to was 1.37m away -- so the escort reported
   * `{"outcome":"completed","phase":"leading","separationM":1.37,"robotIdleAtDestination":true}`
   * 4.0s into the guide leg with BOTH of them still ~20.7m from the Kitchen. The person was never
   * taken anywhere. "Robot is idle" was standing in for "robot is idle AT THE DESTINATION", and
   * those two differ by exactly the length of the trip that had not happened yet.
   */
  escortLeadTarget: RoomTarget | null;
  /** Simulated-time seconds elapsed within the CURRENT escort phase; reset to 0 on bind and
   * on every phase transition, only meaningful while `robotId != null`. Drives the
   * ESCORT_TIMEOUT_S safety valve per-phase (so a normal long escort -- approach + up to
   * GREET_MAX_S greeting + lead -- never trips it, and the greeting pause never counts as
   * "stuck"). */
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
  /** Countdown (simulated seconds) until a delivered REAL visitor auto-despawns, or `null`
   * when no despawn is scheduled. `null` for the whole life of a simulated visitor (their
   * removal is driven by simulatedVisitorSpawner.ts's walk-back lifecycle, not this field).
   * For a real visitor it is `null` while it is being escorted, seeded to
   * REAL_VISITOR_DESPAWN_S by `endEscort` the instant its escort ends, ticked down by
   * `tickRealDespawns`, RE-ARMED back to the full REAL_VISITOR_DESPAWN_S by
   * `keepAliveRealVisitor` on every chat turn of the visitor's still-active session (so it is
   * a post-inactivity window, not a fixed timer), and cleared back to `null` if the visitor is
   * (re)bound to a new escort so it is never removed mid-escort. See REAL_VISITOR_DESPAWN_S's
   * doc comment. */
  realDespawnSeconds: number | null;
}

/** Safety valve for an escort phase that never reaches its own "done" condition (e.g. a
 * target that turned out to be unreachable after all, or the robot got stuck). Applied
 * PER PHASE (`escortElapsedSeconds` resets to 0 on every phase transition), so it bounds
 * the "approaching" leg and the "leading" leg independently and never counts the
 * "greeting" pause at all -- a normal escort (approach + up to GREET_MAX_S greeting + lead)
 * can therefore never trip it. 90s is a generous multiple of the ~33s worst-case
 * single-robot convergence time observed in WorldRoom.test.ts's Classroom-1425 run, so a
 * real in-progress leg should never hit this in practice; it exists purely so a stuck leg
 * can't wedge a robot/visitor pair forever. */
const ESCORT_TIMEOUT_S = 90;

/** Randomized "the guide greets the visitor" pause (simulated seconds) between the robot
 * reaching the person ("approaching" done) and setting off toward the destination
 * ("leading" begins). Both agents stay put for this window. 10-15s reads as a deliberate
 * hand-off at demo camera distance without stalling the scene. */
const GREET_MIN_S = 10;
const GREET_MAX_S = 15;

/**
 * Minimum simulated seconds a LEG must have been under way before its arrival test is
 * trusted -- measured from the start of the leg, since `escortElapsedSeconds` is reset on
 * every phase transition. It is the "the robot has had a chance to actually start moving"
 * window, and it applies to both legs: the fetch leg (where the robot's schema `state ===
 * "idle"` IS the pickup signal) and the guide leg (where it gates the positional
 * ROBOT_DESTINATION_RADIUS_M test from being evaluated on the very tick the robot is
 * dispatched, before it has moved at all).
 *
 * Without it, the fetch leg can misfire on its very first real crowd tick: empirically (two
 * agents added at nearly the same point, one of them immediately re-targeted), the
 * newly-bound robot's realized speed on that first tick can still read below
 * IDLE_SPEED_THRESHOLD_MPS -- not because it arrived, but because Detour hasn't ramped up its
 * avoidance-adjusted velocity yet with another agent that close -- which would otherwise read
 * as instant arrival and un-bind the escort before the robot ever moved. 0.3s is many
 * multiples of a single ~16ms tick (so it fully absorbs that startup blip) but negligible
 * against real inter-room travel times of several seconds+, so it doesn't meaningfully delay
 * genuine arrivals.
 *
 * On the guide leg it is a backstop, not the load-bearing guard: what actually prevents the
 * "leading" transition from being mistaken for an arrival is that the robot must be within
 * ROBOT_DESTINATION_RADIUS_M of the point it was dispatched to, which a robot standing at the
 * PICKUP point of a real trip is not, no matter how long the grace window is.
 */
const ARRIVAL_GRACE_PERIOD_S = 0.3;

/**
 * How far (meters) SHORT of the waiting person the fetching robot is actually dispatched on
 * the "approaching" leg. The robot is sent to a point this far from the person along the
 * line from the person toward the robot -- i.e. on the robot's own side -- instead of to the
 * person's exact coordinates.
 *
 * ---- why a standoff at all (this is a real defect, reproduced) ----
 * The person's exact position is a point the robot can never occupy: the two agents are solid
 * circles of AGENT_RADIUS_M (0.2m) each, so Detour's collision resolution holds them at least
 * 0.4m apart no matter what the steering asks for. Dispatching the robot AT the person
 * therefore sets a goal it can only ever fail to reach, and the fetch leg's arrival test needs
 * the robot to settle to schema-idle (speed < IDLE_SPEED_THRESHOLD_MPS). Instrumented on the
 * long entrance -> "South Collaboration Space" fetch at the production 16.6ms tick: the robot
 * closed to exactly 0.40m and then ORBITED the person at that radius at a steady ~0.10 m/s --
 * pinned out by collision resolution, pulled in by steering that never runs out of goal --
 * so its state read "moving" forever, the "approaching" phase never ended, and the escort died
 * on the 90s ESCORT_TIMEOUT_S with the robot standing right next to the person it had fetched.
 *
 * That orbit did not show up before because `WorldRoom.ts`'s old `separationWeight: 2` stalled
 * the robot dead at ~1.37m (see SEPARATION_WEIGHT's doc comment there) before it ever got close
 * enough to orbit -- a crowd deadlock was silently acting as this leg's brake. Removing the
 * deadlock (which had to go: it also froze the GUIDE leg, the headline bug) exposed the missing
 * standoff underneath it. A goal the robot can actually stand on is the fix, not a wider
 * arrival tolerance: Detour decelerates into a reachable goal and stops there on its own.
 *
 * ---- why 1.2m ----
 * Bounded on both sides, and 1.2 is comfortably inside both:
 *  - FLOOR: must be outside the pair's combined footprint, 2 * AGENT_RADIUS_M = 0.4m, or the
 *    goal is inside the person again and the orbit returns. 1.2m is 3x that.
 *  - CEILING: must be inside PICKUP_RADIUS_M (2.5m), or the robot arrives at its goal and the
 *    handover to "greeting" still never fires. 1.2m is under half of it, leaving room for the
 *    robot to settle slightly wide (measured below) and still be well inside the pickup radius.
 * It is also exactly TRAIL_DISTANCE_M + AGENT_RADIUS_M, i.e. the gap the pair will hold once
 * they set off, so the robot stops where the person is about to be trailing anyway.
 *
 * Measured settling behaviour with this standoff (16.6ms tick, `separationWeight` 1.0): the
 * robot does not stop exactly on the point -- separation from the person pushes it back out
 * until the re-tightening steering toward the goal balances it -- and settles at ~1.4m from
 * the person, which is both stable (speed decays to 0, so schema-idle latches) and well inside
 * PICKUP_RADIUS_M. That ~1.4m is the same settled gap VISITOR_ARRIVAL_DISTANCE_M's doc comment
 * records for a stopped pair, from the same two forces.
 */
const FETCH_STANDOFF_M = 1.2;

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
 * The fix gates completion on the VISITOR having caught up to the robot too -- see `tick()`'s
 * `visitorWithinArrivalDistance`, which is DISTANCE-BASED: the visitor is within this bound of
 * the robot, sustained for the VISITOR_ARRIVAL_SETTLE_S window (see that constant, and the
 * "distance + settle window" note below).
 *
 * This is only HALF of "the escort arrived", and treating it as the whole thing was a second
 * defect in its own right. The original reasoning here was transitive: the robot's own `state
 * === "idle"` supposedly meant Detour considered IT at the destination, so "visitor near the
 * idle robot" would transitively mean "visitor near the destination", with no destination point
 * to resolve or store. That transitivity is false -- an idle robot is idle wherever it stopped,
 * including at the PICKUP point at the end of the fetch leg -- and it produced completions with
 * the person 20m from the room they asked for (see `VisitorRecord.escortLeadTarget`'s doc
 * comment). So the robot side is now measured directly against the destination point the robot
 * was dispatched to (ROBOT_DESTINATION_RADIUS_M), and this constant covers only what it can
 * actually attest to: that the PERSON is with the robot. Both halves are required.
 *
 * It does NOT require the visitor's own schema `state === "idle"`. That was tried first and is
 * exactly the bug this rule replaces: once the robot parks, the trailing visitor packs right up
 * against it and jitters against the separation force, so its realized speed never settles below
 * IDLE_SPEED_THRESHOLD_MPS and its `state` never becomes "idle". Requiring it made the arrival
 * condition permanently false, so `arrived` never fired and every escort released only via the
 * ESCORT_TIMEOUT_S safety valve instead of on genuine arrival. The VISITOR_ARRIVAL_SETTLE_S
 * settle window is the distance-domain stand-in for that lost "the follower has stopped moving"
 * signal: sustained proximity, not an instantaneous idle flag.
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
 * out in the corridor, just between moving-fast frames" (a plainly nearby visitor within 2.5m
 * of an idle robot is not a state that occurs mid-route). The 2.5m radius is a CEILING, not the
 * release point: a trailing visitor first touches it while still ~2.5m back and closing, then
 * keeps converging until it settles ~1.4m from the stopped robot. Releasing on that first graze
 * would end the escort with the visitor still ~2.5m away and mid-stride, which is not "caught
 * up" -- so completion additionally requires the within-radius condition to HOLD for
 * VISITOR_ARRIVAL_SETTLE_S (see that constant), by which point the visitor has genuinely settled
 * next to the robot. That settle window is why distance is a sound arrival signal without the
 * old visitor-idle flag: sustained proximity to a robot that is provably AT the destination
 * cannot occur mid-route (a robot still en route is outside ROBOT_DESTINATION_RADIUS_M of its
 * dispatched target, so `arrived` stays false the whole way regardless of the visitor's
 * distance), and it cannot be faked by a visitor that merely brushes the radius while passing
 * (it would have to loiter inside it for the full window).
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

/**
 * Pickup radius: how close (meters) the FETCHING robot must get to the waiting person
 * before the escort hands over from "approaching" to "greeting" (and then "leading").
 * Named separately from VISITOR_ARRIVAL_DISTANCE_M because the two answer different
 * questions -- "has the guide reached the person yet" vs. "has the person caught up at the
 * destination" -- even though they are deliberately the SAME number today, for a measured
 * reason rather than a coincidence: both are a robot-to-visitor gap between exactly the
 * same two Detour agents with exactly the same `separationWeight`/`collisionQueryRange`
 * personal-space repulsion, so the tightest gap physically reachable in either direction is
 * the same ~1.4-1.65m settled distance (see VISITOR_ARRIVAL_DISTANCE_M's doc comment for
 * the measurement). Picking a tighter pickup radius (e.g. 2.0m) buys nothing visually at
 * demo camera distance and moves the transition closer to that measured floor, i.e. toward
 * the same "condition is never satisfied, every escort runs out the clock" failure that
 * comment records for the 1.2m attempt. Change one and re-measure before changing the
 * other; they are not required to stay equal.
 */
const PICKUP_RADIUS_M = 2.5;

/**
 * How long (simulated seconds) the arrival condition (robot idle at destination + visitor
 * within VISITOR_ARRIVAL_DISTANCE_M) must hold CONTINUOUSLY before an escort is declared
 * "arrived". This is the distance-domain replacement for the removed `visitorAgent.state ===
 * "idle"` gate (see VISITOR_ARRIVAL_DISTANCE_M's doc comment for why that gate was unreachable
 * under packing): a trailing visitor first crosses the 2.5m radius while still ~2.5m back and
 * moving, then converges over roughly half a second onto its ~1.4m settled gap behind the
 * stopped robot. ~0.48s is long enough to let the visitor cross that ~1m and genuinely settle
 * (so the escort releases with the visitor actually next to the robot, not mid-stride at the
 * radius edge -- pinned by visitors.test.ts's `finalSeparation <= 1.5` assertion, which lands
 * at ~1.49m with this window), yet short against real inter-room travel times of several
 * seconds, so it barely delays a genuine arrival. It is NOT a wait window bolted onto a working
 * check: without it the escort releases on the first tick the visitor grazes the radius, which
 * is the premature-release this guards.
 */
const VISITOR_ARRIVAL_SETTLE_S = 0.48;

/**
 * How close (meters) the LEADING robot must ACTUALLY BE to the destination point it was
 * dispatched to (`escortLeadTarget`) for the robot half of "this escort has arrived" to hold.
 * This is the ONLY robot-side arrival signal: it is positional, and the schema `state ===
 * "idle"` flag is deliberately NOT accepted as an alternative to it (see below).
 *
 * ---- why not `state === "idle"` (this is the defect) ----
 * The robot-side gate used to be `state === "idle" || within-tolerance-of-destination`, i.e.
 * a bare "the robot has stopped" satisfied it on its own. But the robot has JUST stopped at
 * the moment the fetch leg ends -- it is standing next to the person it came to collect --
 * so the gate was already true on the first tick of the guide leg, before the robot had gone
 * anywhere, and the visitor half was true too (the person is 1.4m away by construction at
 * pickup). Both halves of "arrived" were therefore satisfied at the PICKUP point, and the
 * escort reported `completed` with the person still 20.7m from the room they asked for. See
 * `VisitorRecord.escortLeadTarget`'s doc comment for the full reproduction. "The robot is
 * idle" is simply not the same claim as "the robot is idle AT THE DESTINATION", and only the
 * second one means the person was delivered.
 *
 * ---- why dropping the idle path does not reintroduce the problem it was added for ----
 * The distance path was originally added ALONGSIDE the idle flag because idle alone is not
 * robust at a BUSY destination: parked fleet robots plus the trailing visitor keep shoving
 * the just-arrived robot, its realized speed flickers above IDLE_SPEED_THRESHOLD_MPS, and its
 * schema state oscillates moving/idle instead of holding "idle" for the
 * VISITOR_ARRIVAL_SETTLE_S window -- which used to keep genuinely-arrived escorts running the
 * full ESCORT_TIMEOUT_S clock. Distance-to-the-destination is strictly the more robust of the
 * two signals (it survives that shoving unchanged), so keeping only it fixes the false
 * completions WITHOUT re-opening the false timeouts. The idle flag was never adding
 * information the distance check lacked; it was only ever adding a way to be wrong early.
 *
 * ---- why 1.0m, from the geometry rather than a guess ----
 * Two independent bounds, and 1.0m is the only round number comfortably inside both:
 *  - FLOOR (must be reachable): measured on this floor plan, a robot leading a trailing
 *    visitor to `findRoomTarget(room)` settles 0.007m-0.224m from that point -- all 18 rooms
 *    of data/floor-14.json, median 0.012m, worst case 0.224m ("Male Washroom"). 1.0m is ~4.5x
 *    that worst case, so a genuine arrival clears it with room to spare even when a crowded
 *    door shoves the arriving robot a body-width (AGENT_RADIUS_M = 0.2m) off the exact point.
 *    A tighter radius would start converting real deliveries into ESCORT_TIMEOUT_S timeouts,
 *    the failure mode VISITOR_ARRIVAL_DISTANCE_M's doc comment records for its own 1.2m
 *    attempt.
 *  - CEILING (must be unambiguous): the two CLOSEST distinct room targets on this floor
 *    ("Male Washroom" and "Gender Neutral Washroom") are 2.054m apart, so a 1.0m radius is
 *    just under half the minimum inter-room spacing -- a robot inside one destination's radius
 *    can never simultaneously be inside another's, i.e. "at the destination" can never be
 *    satisfied by standing at the WRONG room.
 * It cannot false-fire mid-route either: the dispatched point is the END of the robot's
 * corridor, so the robot is only ever within 1.0m of it at the end of the trip. 1.0m also
 * happens to be the same DOOR_TOLERANCE_M the room's tests already use for door convergence,
 * so the shipped gate and the tests' notion of "at the door" agree by value.
 */
const ROBOT_DESTINATION_RADIUS_M = 1.0;

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

/** How long a roaming simulated visitor lingers at a room before heading to the next one.
 * A roaming visitor is escorted to a room, dwells here for a randomized span in this range,
 * then heads off to ANOTHER random room -- it never returns to the entrance and never
 * despawns during normal roaming. Long enough that the visitor visibly STAYS put before
 * moving on. This is the AUTHORITATIVE runtime dwell range: `endEscort` below reads it to
 * seed the dwell countdown the instant an escort ends, and simulatedVisitorSpawner.ts owns
 * ticking that countdown down on every subsequent call (then picking the next room). Kept in
 * sync with simulatedVisitorSpawner.ts's copy of the same constants. */
const DWELL_MIN_S = 8;
const DWELL_MAX_S = 20;

/**
 * How long (simulated seconds) a delivered REAL (Moses/operator-dispatched) visitor may sit
 * idle -- WITHOUT a keepalive -- before it auto-despawns and the world self-cleans. This is a
 * POST-INACTIVITY window measured from the LAST keepalive (or, if none ever arrives, from
 * delivery), NOT a fixed "linger this long then leave" timer: `keepAliveRealVisitor` re-arms
 * it to the full window on every chat turn of the visitor's still-active session (agent_service
 * publishes a keepalive per turn -- see that method and sessions.py's `keepalive_visitor`), so
 * a real chat user's avatar stays on the map for as long as they keep talking and is only
 * removed once the keepalives STOP (the session goes quiet) and this whole window then elapses.
 *
 * A real visitor's record is created lazily by `requestGuide` (kind "real") and, unlike a
 * simulated one, it has NO ambient lifecycle to walk it back out -- so without this it would
 * sit at the destination forever and real visitors would accumulate over a long-running demo.
 * The instant its escort ends (delivered or timed out), `endEscort` seeds this countdown;
 * `tickRealDespawns` counts it down and removes the visitor when it reaches zero; a keepalive
 * or a new escort binding resets/clears it first. This is distinct from the simulated
 * visitor's DWELL_MIN_S..DWELL_MAX_S "linger at a room then roam to the next one" dwell: a
 * real visitor does not roam anywhere afterward, it is simply removed.
 *
 * ---- why 90s (was 20s, which caused the despawn-mid-conversation defect) ----
 * The old 20s was a fixed post-delivery timer with no keepalive: a real chat user guided to a
 * room had her avatar removed 20s later even while her chat session was still active and she
 * was still talking. 20s is shorter than a single normal gap between chat turns (reading
 * Moses's reply, waiting on TTS playback, thinking, typing the next message easily runs
 * 30-60s), so the avatar vanished between turns. 90s is now the window AFTER the last
 * keepalive: it comfortably survives any normal inter-turn gap (so a live session never
 * despawns), while still self-cleaning ~90s after the session actually goes quiet.
 *
 * Exported so tests can assert against the same number instead of a duplicated magic
 * constant (mirrors `RESERVED_ROBOTS_FOR_REAL_USERS` / `SIMULATED_VISITOR_TARGET`).
 */
export const REAL_VISITOR_DESPAWN_S = 90;

/**
 * How many idle guide robots are held in reserve for REAL (Moses-dispatched) users, out of
 * `WorldRoom.GUIDE_ROBOT_COUNT` (= 5). A SIMULATED (ambient) visitor may only bind an idle
 * robot if doing so still leaves at least this many idle assignable robots free; a REAL
 * visitor is never subject to the reservation and may bind ANY idle robot (see
 * `requestGuide`). Exported so tests can assert against the same number instead of a
 * duplicated magic constant (mirrors `SIMULATED_VISITOR_TARGET` / `GUIDE_ROBOT_COUNT`).
 *
 * ---- why 2 against a fleet of 5 (this closes a measured, live starvation) ----
 * The ambient simulated-visitor spawner keeps ~5 concurrent visitors constantly requesting
 * guides, so without a reservation the whole 5-robot fleet is busy most of the time and a
 * REAL "take me to the Kitchen" gets `no_idle_robot` roughly two thirds of the time --
 * confirmed end to end in production: Moses published a real `assign`, the ack came back
 * `failed`/`no_idle_robot`. The ambient traffic was starving real users.
 *
 * Reserving 2 leaves 3 robots for ambient simulated traffic (still a lively scene) while
 * GUARANTEEING a real user can always claim one of the reserved 2 whenever any robot is idle.
 * A class demo has at most 1-2 concurrent real users, so 2 covers well beyond that with a
 * margin, without shrinking the simulated ambiance to nothing. It is bounded on both sides:
 * it must be >= 1 (or real users get no protection at all) and < GUIDE_ROBOT_COUNT (or the
 * simulated fleet can never move and the scene goes dead); 2 sits comfortably inside that,
 * `RESERVED (2) < 3 free for sims < GUIDE_ROBOT_COUNT (5)`.
 */
export const RESERVED_ROBOTS_FOR_REAL_USERS = 2;

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
  /** Which phase the escort was IN when it ended -- the distinct reason that tells
   * "the robot could never reach the person" (`"approaching"`, i.e. the fetch leg failed:
   * an unreachable spot, a wedged route, a person standing somewhere the crowd can't get
   * to) apart from "the robot fetched them fine but the trip to the destination didn't
   * finish" (`"leading"`). Without this, both fetch and guide failures collapse into one
   * undifferentiated `"timed_out"` and the two need completely different diagnoses.
   * Always `"leading"` for a completed escort (completion is only ever reached from the
   * leading phase); either phase for a timeout. Never `"greeting"` -- that phase is
   * deliberately untimed and has no ending path of its own. */
  readonly phase: "approaching" | "leading";
  /** `visitor.escortElapsedSeconds` at the moment the binding ended -- simulated time, so
   * this is correct-by-construction across a pause (see `tick()`'s doc comment). */
  readonly durationSeconds: number;
  /** Robot-to-visitor distance at the moment the binding ended. For a completed escort this
   * is by definition `<= VISITOR_ARRIVAL_DISTANCE_M`; for a timeout it's whatever the gap
   * genuinely was, which is the number that answers "did the visitor almost make it, or was
   * it never following at all". */
  readonly separationM: number;
  /** Whether the ROBOT half of `arrived` (`robotAtDestination`) was true at the moment the
   * binding ended -- lets a caller tell "robot arrived, visitor just didn't catch up in
   * time" apart from "robot itself never finished its own trip either". Always `true` for a
   * completed escort (both halves of `arrived` are required); may be `true` or `false` for a
   * timeout. */
  readonly robotAtDestination: boolean;
  /**
   * How far (meters) the VISITOR was from the destination THEY ASKED FOR at the moment the
   * binding ended -- i.e. "was this person actually delivered?". `null` only if the escort
   * ended with no destination on record (structurally impossible for a bound escort;
   * `requestGuide` resolves and stores one before it binds anything).
   *
   * This field exists because `separationM` alone CANNOT answer that question, and its
   * absence hid a real defect: `separationM` is robot-to-visitor, and the robot is standing
   * next to the person at the END of the fetch leg too, so an escort released at the PICKUP
   * point reports exactly the same healthy-looking ~1.4m separation as one released at the
   * destination 20m away. `scripts/escorttest.ts` reported a 98.6% "completion" rate off
   * that metric while escorts were completing at pickup with the person never delivered.
   * Distance to the requested destination is the only number that distinguishes the two.
   */
  readonly visitorDistanceToDestinationM: number | null;
  /** How far (meters) the ROBOT was from the escort's stored destination point when the
   * binding ended. The robot-side counterpart to `visitorDistanceToDestinationM`: together
   * they separate "nobody got there" from "the robot got there but the person didn't". */
  readonly robotDistanceToDestinationM: number | null;
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
  /** Per-visitor accumulator (simulated seconds) of how long the arrival condition (robot
   * within ROBOT_DESTINATION_RADIUS_M of its dispatched destination + visitor within
   * VISITOR_ARRIVAL_DISTANCE_M of the robot) has held CONTINUOUSLY. Drives the
   * VISITOR_ARRIVAL_SETTLE_S settle debounce in `tick()`; reset to 0 the moment the condition
   * lapses, cleared on the "greeting" -> "leading" transition so no credit can carry across a
   * phase change, and deleted entirely on `endEscort`. Keyed by visitor id. */
  private readonly arrivalSettleSeconds = new Map<string, number>();

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
        escortPhase: null,
        greetSecondsRemaining: 0,
        escortDestination: null,
        escortLeadTarget: null,
        escortElapsedSeconds: 0,
        escortSinceLastTrailUpdateSeconds: 0,
        robotPositionHistory: [],
        simulatedPhase: null,
        simulatedTargetRoom: null,
        simulatedCooldownSeconds: 0,
        realDespawnSeconds: null,
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
    let idleAssignableRobots = 0;
    for (const [id, agent] of this.host.agents) {
      if (agent.kind !== "robot") continue;
      if (agent.state !== "idle") continue;
      if (this.robotToVisitor.has(id)) continue; // already escorting -- not idle for OUR purposes

      idleAssignableRobots++;
      const distance = Math.hypot(agent.x - visitorAgent.x, agent.z - visitorAgent.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRobotId = id;
      }
    }

    if (!bestRobotId) return { robotId: null, reason: "no_idle_robot" };

    // Capacity reservation for REAL users (see RESERVED_ROBOTS_FOR_REAL_USERS's doc comment
    // for the measured starvation this closes). A SIMULATED (ambient) visitor may claim an
    // idle robot ONLY IF doing so still leaves at least RESERVED_ROBOTS_FOR_REAL_USERS idle
    // assignable robots free afterwards -- otherwise it is refused with the ordinary
    // "no_idle_robot" reason and just waits/retries on its normal lifecycle (it is ambiance,
    // not a person, so making it wait is fine). A REAL (Moses-dispatched) visitor is NEVER
    // subject to the reservation: it may take ANY idle robot, which is exactly what
    // guarantees a real request succeeds whenever ANY robot is idle, even while ambient
    // traffic saturates the rest of the fleet. The requesting visitor's kind comes straight
    // off its VisitorRecord (`record.kind`): a simulated visitor's record is pre-registered
    // as "simulated" by simulatedVisitorSpawner.ts before its requestGuide, and a real
    // (bridge-spawned) visitor's record was lazily created as "real" just above -- so this
    // check reads the correct kind on both paths. This is a robot-availability decision, so
    // it sits with the other "no idle robot" reasoning (before the destination is resolved),
    // keeping "no_idle_robot" ahead of "target_unresolved" exactly as the plain no-robot
    // path does.
    if (record.kind === "simulated" && idleAssignableRobots - 1 < RESERVED_ROBOTS_FOR_REAL_USERS) {
      return { robotId: null, reason: "no_idle_robot" };
    }

    // Resolve (and validate) the DESTINATION up front, even though phase 1 sends the robot
    // to the PERSON, not here: an unresolvable destination must fail the whole request with
    // nothing bound (reason "target_unresolved"), exactly as it did before this became a
    // 3-phase escort. Robot-selection happens first so "no idle robot" still takes
    // precedence over "bad target" when both are true (unchanged ordering). See
    // RequestGuideFailureReason's doc comment for why the two reasons are distinct.
    const destination: RoomTarget | null =
      typeof roomNameOrCoords === "string"
        ? this.host.nav.findRoomTarget(roomNameOrCoords)
        : roomNameOrCoords;
    if (!destination) return { robotId: null, reason: "target_unresolved" };

    // Phase 1 ("approaching"): send the ROBOT to a point FETCH_STANDOFF_M short of the PERSON
    // (see that constant -- the person's exact position is a goal the robot can never occupy,
    // and dispatching it there makes the robot orbit them forever instead of arriving). The
    // person WAITS in place -- deliberately NOT seeding the visitor's trailing target here;
    // trailing only begins when "leading" starts (see tick()). A move failure here is treated
    // the same as an unresolvable target: bind nothing.
    const bestRobot = this.host.agents.get(bestRobotId)!;
    const moved = this.host.moveAgentTo(
      bestRobotId,
      this.fetchStandoffPoint(visitorAgent, bestRobot),
    );
    if (!moved) return { robotId: null, reason: "target_unresolved" };

    this.robotToVisitor.set(bestRobotId, visitorId);
    record.robotId = bestRobotId;
    record.escortPhase = "approaching";
    record.escortDestination = destination;
    record.escortLeadTarget = null; // not dispatched to the destination yet -- the fetch leg runs first
    record.greetSecondsRemaining = 0;
    record.escortElapsedSeconds = 0;
    record.escortSinceLastTrailUpdateSeconds = 0;
    record.robotPositionHistory = [];
    // Cancel any pending auto-despawn: a real visitor delivered once and now re-dispatched
    // (Moses assigning it a new destination during its post-arrival dwell) must not be
    // removed out from under the new escort. No-op for a visitor that never had one
    // scheduled (already null on a fresh record and on every simulated record).
    record.realDespawnSeconds = null;

    return { robotId: bestRobotId };
  }

  /**
   * The point the fetching robot is actually dispatched to on the "approaching" leg:
   * FETCH_STANDOFF_M short of `person`, along the line from `person` toward `robot` (so on
   * the robot's own side of the person, the side it is already approaching from). See
   * FETCH_STANDOFF_M's doc comment for why the person's exact position is not a usable goal.
   *
   * Two cases fall back to the robot's CURRENT position rather than to the person's:
   *  - the robot is already at or inside the standoff distance (it has nothing to travel), and
   *  - the two are on top of each other, so there is no direction to offset along.
   * Standing still is the correct instruction in both, and it still lets the fetch leg complete
   * normally: the robot settles to idle where it is and the PICKUP_RADIUS_M test does the rest.
   *
   * The offset point is snapped onto the navmesh with the same `findClosestPoint` the trailing
   * retarget uses. If the snap fails, or lands more than SNAP_TOLERANCE_M from where it was
   * asked for (which means the straight person->robot segment cut through geometry, e.g. across
   * a doorway jamb, and the "closest" walkable point is somewhere structurally different), the
   * offset is abandoned and the robot is sent to the person's own position -- the pre-standoff
   * behaviour, which is degraded but never worse than what shipped before.
   */
  private fetchStandoffPoint(
    person: { x: number; z: number },
    robot: { x: number; z: number },
  ): RoomTarget {
    /** How far the navmesh snap may move the offset point before it is no longer trustworthy
     * as "a spot on the robot's side of the person". Half the standoff itself: a snap that
     * large has left the segment the point was meant to sit on. */
    const SNAP_TOLERANCE_M = FETCH_STANDOFF_M / 2;

    const dx = robot.x - person.x;
    const dz = robot.z - person.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= FETCH_STANDOFF_M) return { x: robot.x, z: robot.z };

    const wanted = {
      x: person.x + (dx / distance) * FETCH_STANDOFF_M,
      z: person.z + (dz / distance) * FETCH_STANDOFF_M,
    };
    const snap = this.host.nav.navMeshQuery.findClosestPoint({ x: wanted.x, y: 0, z: wanted.z });
    if (!snap.success) return { x: person.x, z: person.z };
    if (Math.hypot(snap.point.x - wanted.x, snap.point.z - wanted.z) > SNAP_TOLERANCE_M) {
      return { x: person.x, z: person.z };
    }
    return { x: snap.point.x, z: snap.point.z };
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
    this.arrivalSettleSeconds.delete(visitorId);
  }

  /** True while `robotId` is currently bound to a visitor (i.e. actively escorting). Reads
   * the same reverse-index `requestGuide` uses to filter "already escorting" robots, so it
   * can never disagree with assignment. WorldRoom.update() uses this to leave an escorting
   * robot alone (its move target is owned by the escort) while still sending genuinely-idle
   * robots back to park on their home charging station. */
  isRobotEscorting(robotId: string): boolean {
    return this.robotToVisitor.has(robotId);
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
   * Advances every bound escort by `dtSeconds` of simulated time through its 3-phase state
   * machine (see `EscortPhase`):
   *   - "approaching": the robot navigates to the PERSON; the person waits in place. When
   *     the robot reaches the person (robot idle + within VISITOR_ARRIVAL_DISTANCE_M of the
   *     person), transition to "greeting" with a randomized GREET_MIN_S..GREET_MAX_S pause.
   *   - "greeting": count the pause down; both agents stay put. At <= 0, dispatch the robot to
   *     the stored destination (recording the dispatched point as `escortLeadTarget`), clear
   *     the arrival-settle accumulator, seed the trailing target, and transition to "leading".
   *   - "leading": trailing-update plus the two-sided arrival/release test -- the ROBOT within
   *     ROBOT_DESTINATION_RADIUS_M of the point it was dispatched to AND the VISITOR within
   *     VISITOR_ARRIVAL_DISTANCE_M of the robot, both held for VISITOR_ARRIVAL_SETTLE_S (see
   *     those constants' doc comments).
   * `escortElapsedSeconds` is reset on each transition so the ESCORT_TIMEOUT_S safety valve
   * bounds the approach leg and the lead leg independently, and never counts the greeting
   * pause as "stuck" (the greeting phase does not check the timeout at all).
   *
   * Must be called BEFORE `SimulatedVisitorSpawner.tick()` within the same simulated
   * frame -- see `VisitorManager.tick()` in visitors.ts (the composition root) for the
   * full three-step ordering and why it's load-bearing, not just a style choice. In short:
   * this step evaluates escorts bound on a PREVIOUS frame against agent state that already
   * had a real crowd tick applied since binding (WorldRoom.update() calls `crowd.tick()` +
   * syncs schema state before calling into this subsystem at all), which is what makes
   * "robot schema state settled back to idle" a safe, race-free signal for "robot reached the
   * person" in "approaching": a robot can never go idle -> (bound this call) -> re-checked-idle
   * within the same tick(), because new bindings only happen in the spawner step, which runs
   * after this one. ("robot reached the destination" in "leading" does not use the idle flag at
   * all any more -- see ROBOT_DESTINATION_RADIUS_M's doc comment for why it must not.)
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

      if (visitor.escortPhase === "approaching") {
        // The robot has reached the person once it has settled to idle within
        // PICKUP_RADIUS_M of the person (same distance/idle signal "leading" uses for the
        // destination, applied here to the person). The person is NOT moved during this
        // phase, so this is purely "robot arrived at the waiting person".
        const robotReachedPerson =
          visitor.escortElapsedSeconds >= ARRIVAL_GRACE_PERIOD_S &&
          robotAgent.state === "idle" &&
          Math.hypot(robotAgent.x - visitorAgent.x, robotAgent.z - visitorAgent.z) <=
            PICKUP_RADIUS_M;
        if (robotReachedPerson) {
          visitor.escortPhase = "greeting";
          visitor.greetSecondsRemaining = randomBetween(GREET_MIN_S, GREET_MAX_S);
          visitor.escortElapsedSeconds = 0; // fresh timeout budget; greeting itself is untimed
          continue;
        }
        // Safety valve for a person the robot can never reach (unreachable spot, stuck).
        if (visitor.escortElapsedSeconds >= this.escortTimeoutS) {
          this.releaseWithOutcome(visitor, visitorAgent, robotAgent, "timed_out", false);
        }
        // Otherwise: the person waits, the robot keeps navigating; nothing else to do (no
        // trailing seeded until "leading").
        continue;
      }

      if (visitor.escortPhase === "greeting") {
        visitor.greetSecondsRemaining -= dtSeconds;
        if (visitor.greetSecondsRemaining > 0) continue; // both stay put; deliberately untimed

        // Greeting done -> begin "leading": dispatch the robot to the stored destination and
        // start the visitor trailing behind it (seed the first history sample + retarget now
        // rather than waiting a TRAIL_UPDATE_INTERVAL_S window, so the visitor starts
        // following the same tick the robot sets off).
        visitor.escortPhase = "leading";
        visitor.escortElapsedSeconds = 0; // fresh timeout budget for the lead leg
        visitor.escortSinceLastTrailUpdateSeconds = 0;
        visitor.robotPositionHistory = [];
        // A phase transition must never be mistakable for an arrival. Everything the
        // completion test reads is re-armed HERE, at the transition, so nothing accumulated
        // during the fetch/greeting legs can carry into the guide leg's arrival verdict:
        //  - the settle accumulator is cleared (it is only ever advanced by the "leading"
        //    branch below, so it is normally already absent -- clearing it explicitly is what
        //    makes that a stated invariant of this transition instead of an accident of where
        //    the other write happens to live);
        //  - `escortElapsedSeconds` is reset above, so ARRIVAL_GRACE_PERIOD_S below is a fresh
        //    "the robot has had a tick to start moving" window measured from the dispatch;
        //  - `escortLeadTarget` is set ONLY if the dispatch below is actually accepted, and the
        //    completion test cannot pass at all while it is null.
        this.arrivalSettleSeconds.delete(visitor.id);
        visitor.escortLeadTarget = null;
        if (visitor.escortDestination) {
          const dispatched = this.host.moveAgentTo(visitor.robotId, visitor.escortDestination);
          if (dispatched) {
            visitor.escortLeadTarget = visitor.escortDestination;
          } else {
            // The destination resolved fine at bind time, so this should not happen; if it
            // ever does, the robot was never sent anywhere and the person cannot be delivered.
            // Leaving `escortLeadTarget` null makes completion structurally unreachable, so
            // the escort ends on the ESCORT_TIMEOUT_S valve as a "timed_out" -- never as a
            // "completed" that nobody travelled for.
            console.warn(
              `EscortManager: robot "${visitor.robotId}" refused the guide-leg move to the destination for ` +
                `visitor "${visitor.id}"; the escort can now only end via the ${this.escortTimeoutS}s timeout`,
            );
          }
        }
        this.recordHistoryAndRetarget(visitor, robotAgent);
        continue;
      }

      // "leading": the robot heads to the destination and the visitor follows. Completion needs
      // BOTH halves -- the robot measurably AT the destination, and the VISITOR caught up to it
      // -- see VISITOR_ARRIVAL_DISTANCE_M's doc comment for why the visitor half is
      // distance-based + settle-debounced rather than the visitor's own `state === "idle"`.
      // "The robot has arrived at the destination" is a POSITIONAL claim and is tested as one
      // (see ROBOT_DESTINATION_RADIUS_M's doc comment): the robot must have been dispatched to
      // the destination at the start of this leg (`escortLeadTarget` non-null), have had
      // ARRIVAL_GRACE_PERIOD_S since that dispatch to start moving, and actually be within
      // ROBOT_DESTINATION_RADIUS_M of that point. The schema `state === "idle"` flag is NOT
      // accepted in place of any of that -- accepting it is what let an escort "complete" at
      // the pickup point, where the just-finished fetch leg leaves the robot stopped next to
      // the person and 20m from the room they asked for.
      const leadTarget = visitor.escortLeadTarget;
      const robotAtDestination =
        leadTarget !== null &&
        visitor.escortElapsedSeconds >= ARRIVAL_GRACE_PERIOD_S &&
        Math.hypot(robotAgent.x - leadTarget.x, robotAgent.z - leadTarget.z) <=
          ROBOT_DESTINATION_RADIUS_M;
      const visitorWithinArrivalDistance =
        Math.hypot(visitorAgent.x - robotAgent.x, visitorAgent.z - robotAgent.z) <=
        VISITOR_ARRIVAL_DISTANCE_M;
      const arrivalConditionMet = robotAtDestination && visitorWithinArrivalDistance;
      const settledSeconds = arrivalConditionMet
        ? (this.arrivalSettleSeconds.get(visitor.id) ?? 0) + dtSeconds
        : 0;
      this.arrivalSettleSeconds.set(visitor.id, settledSeconds);
      const arrived = settledSeconds >= VISITOR_ARRIVAL_SETTLE_S;
      const timedOut = !arrived && visitor.escortElapsedSeconds >= this.escortTimeoutS;

      if (arrived || timedOut) {
        this.releaseWithOutcome(
          visitor,
          visitorAgent,
          robotAgent,
          timedOut ? "timed_out" : "completed",
          robotAtDestination,
        );
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
   * Shared escort-ending path for both the "leading" arrival/timeout and the "approaching"
   * timeout: bumps the lifetime counter, fires `onEscortOutcome` with the state the escort
   * actually ended in (deliberately BEFORE `endEscort` resets the record -- see
   * EscortOutcome's doc comment), then un-binds via `endEscort`. `visitor.robotId` is
   * guaranteed non-null here (every caller is inside the `if (!visitor.robotId) continue`
   * guard in `tick()`).
   */
  private releaseWithOutcome(
    visitor: VisitorRecord,
    visitorAgent: { x: number; z: number },
    robotAgent: { x: number; z: number },
    outcome: "completed" | "timed_out",
    robotAtDestination: boolean,
  ): void {
    // Captured BEFORE endEscort() nulls `escortDestination` out -- see
    // `EscortOutcome.visitorDistanceToDestinationM`'s doc comment for why the
    // distance-to-DESTINATION pair is reported and not just robot-to-visitor separation.
    const destination = visitor.escortDestination;
    if (outcome === "timed_out") {
      console.warn(
        `EscortManager: escort timeout for visitor "${visitor.id}" / robot "${visitor.robotId}" ` +
          `after ${visitor.escortElapsedSeconds.toFixed(1)}s in phase "${visitor.escortPhase}" -- releasing binding`,
      );
      this.timedOutEscorts++;
    } else {
      this.completedEscorts++;
    }
    this.onEscortOutcome?.({
      visitorId: visitor.id,
      robotId: visitor.robotId!,
      outcome,
      // Captured BEFORE endEscort() nulls the record's phase out. "greeting" is not a
      // reachable ending phase (that leg is untimed and has no release path), so the
      // fallback below is unreachable in practice; it exists so this stays a total
      // function if a future phase gains an ending path without updating this call site.
      phase: visitor.escortPhase === "approaching" ? "approaching" : "leading",
      durationSeconds: visitor.escortElapsedSeconds,
      separationM: Math.hypot(visitorAgent.x - robotAgent.x, visitorAgent.z - robotAgent.z),
      robotAtDestination,
      visitorDistanceToDestinationM: destination
        ? Math.hypot(visitorAgent.x - destination.x, visitorAgent.z - destination.z)
        : null,
      robotDistanceToDestinationM: destination
        ? Math.hypot(robotAgent.x - destination.x, robotAgent.z - destination.z)
        : null,
    });
    this.endEscort(visitor);
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
    visitor.escortPhase = null;
    visitor.greetSecondsRemaining = 0;
    visitor.escortDestination = null;
    visitor.escortLeadTarget = null;
    visitor.escortElapsedSeconds = 0;
    visitor.escortSinceLastTrailUpdateSeconds = 0;
    visitor.robotPositionHistory = [];
    this.arrivalSettleSeconds.delete(visitor.id);

    if (visitor.kind === "simulated") {
      visitor.simulatedPhase = "dwelling";
      visitor.simulatedCooldownSeconds = randomBetween(this.dwellMinS, this.dwellMaxS);
    } else {
      // Real visitor: no walk-back lifecycle to remove it, so schedule an auto-despawn.
      // The escort just ended -- delivered at the destination or timed out -- and either
      // way the person should leave so the world self-cleans instead of accumulating idle
      // real visitors. `tickRealDespawns` counts this down and removes the visitor at zero;
      // a new escort binding (requestGuide) clears it back to null first. See
      // REAL_VISITOR_DESPAWN_S's doc comment.
      visitor.realDespawnSeconds = REAL_VISITOR_DESPAWN_S;
    }
  }

  /**
   * Counts down every scheduled real-visitor auto-despawn by `dtSeconds` and removes the
   * ones whose countdown has elapsed -- the lifecycle step that keeps delivered REAL
   * (Moses/operator-dispatched) visitors from lingering at their destination forever (a
   * real visitor has no ambient walk-back lifecycle of its own, unlike a simulated one; see
   * REAL_VISITOR_DESPAWN_S / `VisitorRecord.realDespawnSeconds`).
   *
   * Removal is BOTH halves of a despawn: `host.removeAgent` (the Crowd/schema agent) and
   * `removeVisitor` (this module's bookkeeping + any dangling robot binding). Ids are
   * collected first and removed afterward so `removeVisitor` never mutates the `visitors`
   * map while it is being iterated (deleting mid-iteration would skip entries).
   *
   * Called by `VisitorManager.tick()` AFTER the escort + spawner steps, so a real escort
   * that ended THIS frame (which seeds `realDespawnSeconds` via `endEscort`) starts its
   * countdown this frame and is not removed until REAL_VISITOR_DESPAWN_S of ticks later.
   */
  tickRealDespawns(dtSeconds: number): void {
    const toRemove: string[] = [];
    for (const visitor of this.visitors.values()) {
      if (visitor.kind !== "real") continue;
      if (visitor.realDespawnSeconds === null) continue;
      visitor.realDespawnSeconds -= dtSeconds;
      if (visitor.realDespawnSeconds <= 0) toRemove.push(visitor.id);
    }
    for (const id of toRemove) {
      this.host.removeAgent(id);
      this.removeVisitor(id);
    }
  }

  /**
   * Re-arms the post-inactivity despawn window for a delivered REAL (Moses/operator-
   * dispatched) visitor, so a real chat user's avatar is NOT removed from the world while
   * their chat session is still active. agent_service publishes a keepalive on every chat
   * turn of a guided session (see sessions.py's `keepalive_visitor`), which routes through
   * the IoT bridge to here; each call resets `realDespawnSeconds` back to the full
   * REAL_VISITOR_DESPAWN_S, so `tickRealDespawns` only ever removes the visitor once the
   * keepalives STOP (the session goes quiet) and the whole window then elapses. This is the
   * fix for the "guided to a room, then despawned 20s later while still chatting" defect --
   * see REAL_VISITOR_DESPAWN_S's doc comment.
   *
   * No-op (returns false) for an unknown id or a simulated visitor. While the visitor is
   * ACTIVELY escorting (`robotId != null`) its `realDespawnSeconds` is deliberately kept at
   * null -- an in-escort visitor is never despawned and `endEscort` arms the window fresh the
   * instant the escort ends -- so a keepalive during an escort leaves that null in place
   * (preserving the "cleared-to-null while escorting" invariant) and just confirms the
   * visitor exists. Returns true iff a matching real visitor was found.
   */
  keepAliveRealVisitor(visitorId: string): boolean {
    const visitor = this.visitors.get(visitorId);
    if (!visitor || visitor.kind !== "real") return false;
    if (visitor.robotId === null) {
      visitor.realDespawnSeconds = REAL_VISITOR_DESPAWN_S;
    }
    return true;
  }

  /** Every currently-tracked REAL visitor's id, for `WorldRoom.clearRealVisitors`'s
   * immediate manual clear (the ids are collected here so the caller can remove each from
   * both the Crowd/schema and this module's bookkeeping without mutating the `visitors` map
   * mid-iteration). Simulated visitors are excluded -- an admin "clear real visitors" must
   * leave the ambient scene running. */
  realVisitorIds(): string[] {
    const ids: string[] = [];
    for (const visitor of this.visitors.values()) {
      if (visitor.kind === "real") ids.push(visitor.id);
    }
    return ids;
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
