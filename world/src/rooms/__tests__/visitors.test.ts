/**
 * Integration test for Task 4.1's simulated-visitor spawner + guide-assignment bookkeeping
 * (world/src/rooms/visitors.ts, wired into WorldRoom.ts's onCreate/update). Drives
 * WorldRoom directly the same way WorldRoom.test.ts does -- no live Colyseus
 * server/transport, deterministic simulated time via repeated `update(deltaMs)` calls
 * instead of a real wall-clock interval.
 *
 * Three scenarios, matching the task's acceptance criteria:
 *   (a) spawn 50 idle test robots, let the default spawner run, and confirm the concurrent
 *       simulated-visitor count converges to and stays near the ~45 target without ever
 *       exceeding it or double-assigning a robot.
 *   (b) call `requestGuide` directly with a known visitor + room, and confirm the assigned
 *       robot's position converges toward the room door AND the visitor's position trails
 *       behind it (not identical, not stationary).
 *   (c) confirm `requestGuide` returns `null` (not a throw) once every robot is already
 *       escorting, including re-requesting for an already-escorted visitor.
 *
 * Run with: npx tsx src/rooms/__tests__/visitors.test.ts
 */
import assert from "node:assert/strict";

import { WorldRoom } from "../WorldRoom.js";
import { loadFloorPlan } from "../../nav/loadFloorPlan.js";
import { SIMULATED_VISITOR_TARGET } from "../simulatedVisitorSpawner.js";

const DOOR_TOLERANCE_M = 1.0; // matches WorldRoom.test.ts's convergence tolerance
const TICK_MS = 16.6;

async function testSimulatedSpawnerConvergence(): Promise<void> {
  const room = new WorldRoom();
  // disableGuideRobots: this test wants to control the exact robot supply itself (spawns
  // its own ROBOT_COUNT test robots below and reasons about totalRobots precisely) rather
  // than also getting the real GUIDE_ROBOT_COUNT-sized fleet WorldRoom seeds by default --
  // see WorldRoom.ts's onCreate() doc comment. Without this, the fleet's 50 robots plus
  // this test's own 50 plus the ~45-visitor spawner target would exceed MAX_AGENTS (128),
  // silently starving the spawner and breaking this test's convergence assertions.
  await room.onCreate({ disableGuideRobots: true }); // spawner ENABLED, target SIMULATED_VISITOR_TARGET
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };

  // "spawn 50 test robots first" -- 50 fresh idle robots, all easily enough to cover the
  // ~45-visitor target with slack, so the spawner is never bottlenecked on robot supply.
  const ROBOT_COUNT = 50;
  for (let i = 0; i < ROBOT_COUNT; i++) {
    room.addAgent(`load-test-robot-${i}`, "robot", entrance);
  }
  // disableGuideRobots means WorldRoom seeded no robots of its own -- total robot supply
  // is exactly ROBOT_COUNT, comfortably above SIMULATED_VISITOR_TARGET.
  const totalRobots = ROBOT_COUNT;

  // Advance simulated time using dt = the crowd's own MAX_TICK_SECONDS clamp ceiling
  // (0.1s/tick) -- this is the coarsest step WorldRoom.update() is willing to treat as a
  // single physics step (see WorldRoom.ts's MAX_TICK_SECONDS doc comment), so a long
  // simulated run stays cheap in wall-clock ticks without exploiting/exceeding the clamp.
  const DT_MS = 100;
  const WARMUP_TICKS = 400; // 40s simulated -- past the ~22.5s initial ramp-up to fill 45 slots
  const SAMPLE_TICKS = 800; // 80s simulated of steady-state observation

  let maxSeenDuringWarmup = 0;
  for (let i = 0; i < WARMUP_TICKS; i++) {
    room.update(DT_MS);
    const stats = room.getVisitorDebugStats();
    if (stats.simulatedActive > maxSeenDuringWarmup) maxSeenDuringWarmup = stats.simulatedActive;
    assert.ok(
      stats.simulatedActive <= SIMULATED_VISITOR_TARGET,
      `simulated visitor count (${stats.simulatedActive}) exceeded the target (${SIMULATED_VISITOR_TARGET}) during warmup at tick ${i}`,
    );
    assert.equal(
      stats.escortedVisitors,
      stats.robotBindings,
      `escortedVisitors (${stats.escortedVisitors}) and robotBindings (${stats.robotBindings}) diverged at warmup tick ${i} -- a robot/visitor binding is one-sided`,
    );
    assert.ok(
      stats.robotBindings <= totalRobots,
      `robotBindings (${stats.robotBindings}) exceeded total available robots (${totalRobots}) at warmup tick ${i}`,
    );
  }
  console.log(`[warmup] reached simulatedActive=${maxSeenDuringWarmup} within ${WARMUP_TICKS * (DT_MS / 1000)}s simulated`);

  let sumActive = 0;
  let minActive = Infinity;
  let maxActive = -Infinity;
  for (let i = 0; i < SAMPLE_TICKS; i++) {
    room.update(DT_MS);
    const stats = room.getVisitorDebugStats();

    assert.ok(
      stats.simulatedActive <= SIMULATED_VISITOR_TARGET,
      `simulated visitor count (${stats.simulatedActive}) exceeded the target (${SIMULATED_VISITOR_TARGET}) at sample tick ${i}`,
    );
    assert.equal(
      stats.escortedVisitors,
      stats.robotBindings,
      `escortedVisitors (${stats.escortedVisitors}) and robotBindings (${stats.robotBindings}) diverged at sample tick ${i} -- a robot/visitor binding is one-sided (double-assignment or an orphaned binding)`,
    );
    assert.ok(
      stats.robotBindings <= totalRobots,
      `robotBindings (${stats.robotBindings}) exceeded total available robots (${totalRobots}) at sample tick ${i}`,
    );

    sumActive += stats.simulatedActive;
    if (stats.simulatedActive < minActive) minActive = stats.simulatedActive;
    if (stats.simulatedActive > maxActive) maxActive = stats.simulatedActive;
  }
  const avgActive = sumActive / SAMPLE_TICKS;

  console.log(
    `[steady-state, ${SAMPLE_TICKS * (DT_MS / 1000)}s simulated] simulatedActive: ` +
      `min=${minActive} avg=${avgActive.toFixed(2)} max=${maxActive} (target=${SIMULATED_VISITOR_TARGET}, robots=${totalRobots})`,
  );

  assert.ok(
    maxActive <= SIMULATED_VISITOR_TARGET,
    `steady-state simulatedActive max (${maxActive}) should never exceed the target (${SIMULATED_VISITOR_TARGET})`,
  );
  // With 51 idle robots against a 45-visitor target (6 robots of slack), the count should
  // spend the steady-state window hovering close to target, not drifting low.
  assert.ok(
    avgActive >= SIMULATED_VISITOR_TARGET - 5,
    `steady-state average simulatedActive (${avgActive.toFixed(2)}) should stay close to the ` +
      `${SIMULATED_VISITOR_TARGET} target given ${totalRobots} available robots`,
  );
  console.log("PASS: simulated-visitor count converges to and holds near the ~45 target, no double-assignment observed");

  room.onDispose();
}

async function testRequestGuideConvergenceAndTrailing(): Promise<void> {
  const room = new WorldRoom();
  await room.onCreate({ disableSimulatedVisitors: true });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  // Origin/destination picked to be a genuinely LONG trip, not a short hop. floor-14.json
  // was re-traced from the recovered original floor-plan image (commits 50bb024, 7e4fe67)
  // and came out architecturally accurate -- Classroom 1425's and 1426's doors, which this
  // test used to escort between, turned out to be only ~3.5m apart in the real geometry
  // (vs. the old eyeballed map's much bigger gap). A ~3.5m trip is mostly spent untangling
  // the robot and visitor from their shared spawn point (Detour local avoidance takes
  // ~1.3s to separate two agents spawned on top of each other) before the robot even
  // arrives, which starved the net-displacement assertion below of any real trip to
  // measure -- not a trailing-logic bug (verified: over THIS long trip the visitor trails
  // properly, stays behind, and never collapses onto the robot; see the escort-manager
  // investigation notes in docs/superpowers/plans/2026-07-26-virtual-world-progress.md).
  // Wellness Room and Event Space sit on opposite sides of the building core, ~17m apart
  // door-to-door (measured below), giving the escort a real trip to trail over.
  const originRoom = plan.rooms.find((r) => r.name === "Wellness Room");
  const destRoom = plan.rooms.find((r) => r.name === "Event Space");
  assert.ok(originRoom, "floor-14.json should contain 'Wellness Room'");
  assert.ok(destRoom, "floor-14.json should contain 'Event Space'");
  const [doorX, doorZ] = destRoom!.door;
  const doorToDoorDistance = Math.hypot(doorX - originRoom!.door[0], doorZ - originRoom!.door[1]);
  assert.ok(
    doorToDoorDistance > 10,
    `test setup: Wellness Room -> Event Space should be a genuinely long trip (>10m); ` +
      `got ${doorToDoorDistance.toFixed(2)}m door-to-door -- pick a farther-apart pair if floor-14.json changed`,
  );

  // Spawn robot-b/visitor-b together near a DIFFERENT room's door (not the entrance, where
  // WorldRoom's own seeded TEST_AGENT_ID robot sits) so robot-b is unambiguously the
  // nearest idle robot to visitor-b -- proving the "nearest idle robot" selection, not just
  // "the only robot that exists".
  const spawnPoint = { x: originRoom!.door[0], z: originRoom!.door[1] };
  room.addAgent("robot-b", "robot", spawnPoint);
  room.addAgent("visitor-b", "visitor", spawnPoint);

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };

  const result = room.requestGuide("visitor-b", "Event Space");
  assert.ok(result.robotId, "requestGuide should succeed when an idle robot is available");
  assert.equal(result.robotId, "robot-b", "requestGuide should pick the nearest idle robot (robot-b, not one of the 50 seeded fleet robots)");
  console.log(`PASS: requestGuide("visitor-b", "Event Space") assigned robot "${result.robotId}"`);

  let statsAfterBind = room.getVisitorDebugStats();
  assert.equal(statsAfterBind.escortedVisitors, 1, "exactly one visitor should be escorted right after a successful requestGuide");
  assert.equal(statsAfterBind.robotBindings, 1, "exactly one robot binding should exist right after a successful requestGuide");

  const visitorStart = { ...state.agents.get("visitor-b")! };

  // 3000 ticks * 16.6ms = ~49.8s simulated. The full 50-robot guide fleet (seeded by this
  // scenario's onCreate, not disabled) is scattered across the floor per guideFleetSpawns.ts
  // and adds real local-avoidance congestion along the way -- measured at ~25.9s to converge
  // over this Wellness-Room-to-Event-Space trip with that fleet present, so this budget
  // keeps ~90% headroom rather than the ~7s WorldRoom.test.ts's shorter-trip 2000-tick
  // budget would leave.
  const MAX_TICKS = 3000;
  let robotDoorDist = Infinity;
  let visitorMovedTotal = 0;
  let sawNonTrivialSeparation = false;
  let lastVisitorPos = { x: visitorStart.x, z: visitorStart.z };

  for (let i = 0; i < MAX_TICKS; i++) {
    room.update(TICK_MS);
    const robot = state.agents.get("robot-b")!;
    const visitor = state.agents.get("visitor-b")!;

    robotDoorDist = Math.hypot(robot.x - doorX, robot.z - doorZ);

    const step = Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
    visitorMovedTotal += step;
    lastVisitorPos = { x: visitor.x, z: visitor.z };

    const separation = Math.hypot(visitor.x - robot.x, visitor.z - robot.z);
    // "trails behind, not identical" -- some real (not necessarily exactly TRAIL_DISTANCE_M,
    // since the visitor is always catching up to a moving target) gap between the two.
    if (separation > 0.15) sawNonTrivialSeparation = true;

    if (robotDoorDist <= DOOR_TOLERANCE_M) break;
  }

  assert.ok(
    robotDoorDist <= DOOR_TOLERANCE_M,
    `assigned robot did not converge within ${DOOR_TOLERANCE_M}m of Event Space's door; last distance ${robotDoorDist.toFixed(2)}m`,
  );
  console.log(`PASS: assigned robot "robot-b" converged to within ${robotDoorDist.toFixed(2)}m of Event Space's door`);

  // Keep ticking a bounded extra amount for the robot to settle to idle at its door and for
  // the escort to un-bind (mirrors WorldRoom.test.ts's settle-tick pattern) -- and keep
  // accumulating the visitor's trailing distance over this whole window too. The robot
  // (which the loop above breaks on) reaches the door before the visitor, who is still
  // trailing a real distance behind it (that's the whole point of "trailing"); measuring
  // visitorMovedTotal only up to the ROBOT's arrival (as a prior version of this test did)
  // cuts the visitor's trip short by however long its own remaining approach takes, which
  // is exactly the gap floor-14.json's 2026-08-02 re-extraction (a more direct, less
  // congested Wellness-Room<->Event-Space route than the earlier hand-traced map) exposed:
  // the robot converged at tick ~1041/3000, leaving the still-trailing visitor short of the
  // door-to-door distance at that instant even though it goes on to clear it comfortably
  // once actually given the rest of its own trip. The distance tally therefore keeps
  // running for the FULL settle window below (not just until escortedVisitors first hits
  // 0 -- that fires as soon as the visitor is "close enough" to its own stop point, which
  // in one observed run was ~2.5% short of the full door-to-door distance, i.e. the visitor
  // is still finishing its final approach at that instant), while `settled` is still
  // recorded (and asserted) as soon as it's first observed within the budget.
  const MAX_SETTLE_TICKS = 2000;
  let settled = false;
  for (let i = 0; i < MAX_SETTLE_TICKS; i++) {
    room.update(TICK_MS);
    const visitor = state.agents.get("visitor-b")!;
    const robot = state.agents.get("robot-b")!;
    const step = Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
    visitorMovedTotal += step;
    lastVisitorPos = { x: visitor.x, z: visitor.z };
    if (Math.hypot(visitor.x - robot.x, visitor.z - robot.z) > 0.15) sawNonTrivialSeparation = true;
    if (room.getVisitorDebugStats().escortedVisitors === 0) settled = true;
  }
  assert.ok(settled, "escort binding should be released once the robot arrives and settles to idle");

  const visitorNetDisplacement = Math.hypot(
    lastVisitorPos.x - visitorStart.x,
    lastVisitorPos.z - visitorStart.z,
  );
  // Thresholds are stated as fractions of the ACTUAL door-to-door distance (not a flat
  // meter figure) so this stays meaningful regardless of which room pair is used above --
  // a flat "> 0.5m" is exactly what silently passed on a short trip while proving nothing.
  // Observed on this Wellness-Room-to-Event-Space trip (~18.45m door-to-door, 50-robot
  // fleet present, measured over the visitor's full escorted trip incl. settle-wait):
  // visitor moved ~20.5m total, net displacement ~19.1m -- both comfortably clear these
  // fractional bars, which is the point: a visitor genuinely trailing a robot across real
  // distance blows past "meaningfully away from spawn", it doesn't barely clear it.
  assert.ok(
    visitorMovedTotal > doorToDoorDistance,
    `visitor-b should have covered at least the door-to-door distance (${doorToDoorDistance.toFixed(2)}m) while ` +
      `trailing the robot (moved ${visitorMovedTotal.toFixed(2)}m total) -- not stationary`,
  );
  assert.ok(
    visitorNetDisplacement > doorToDoorDistance * 0.5,
    `visitor-b's net displacement (${visitorNetDisplacement.toFixed(2)}m) should be a meaningful fraction of the ` +
      `${doorToDoorDistance.toFixed(2)}m trip (> ${(doorToDoorDistance * 0.5).toFixed(2)}m), not stuck near its spawn point`,
  );
  assert.ok(sawNonTrivialSeparation, "visitor-b should stay a real trailing distance behind robot-b, not overlap it");
  console.log(
    `PASS: visitor-b trailed behind robot-b (moved ${visitorMovedTotal.toFixed(2)}m total, ` +
      `net displacement ${visitorNetDisplacement.toFixed(2)}m from spawn, never collapsed onto the robot)`,
  );

  const statsAfterArrival = room.getVisitorDebugStats();
  assert.equal(statsAfterArrival.robotBindings, 0, "robot binding should be released on arrival");
  console.log("PASS: escort binding released on arrival (robot returned to idle, un-bound)");

  room.onDispose();
}

async function testRequestGuideReturnsNullWhenNoRobotIdle(): Promise<void> {
  const room = new WorldRoom();
  // disableGuideRobots: this test's whole premise is "exactly one robot exists" -- the
  // real GUIDE_ROBOT_COUNT-sized fleet WorldRoom seeds by default would give visitor-c2
  // plenty of idle robots to bind to and this test's core "requestGuide returns null once
  // every robot is escorting" assertion would never fire. See WorldRoom.ts's onCreate()
  // doc comment. The single robot is added by hand right after, in the fleet's place.
  await room.onCreate({ disableSimulatedVisitors: true, disableGuideRobots: true });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };

  // Exactly one robot exists (added by hand, replacing WorldRoom's old single seeded
  // TEST_AGENT_ID) and no others were added, so after binding it once, zero idle robots
  // remain.
  room.addAgent("only-robot", "robot", entrance);
  room.addAgent("visitor-c1", "visitor", entrance);
  room.addAgent("visitor-c2", "visitor", entrance);

  const firstResult = room.requestGuide("visitor-c1", "Classroom 1425");
  assert.ok(firstResult.robotId, "requestGuide should succeed for the first visitor (one idle robot exists)");
  console.log(`PASS: requestGuide("visitor-c1", ...) succeeded (no throw), assigned "${firstResult.robotId}"`);

  const secondResult = room.requestGuide("visitor-c2", "Classroom 1426");
  assert.equal(secondResult.robotId, null, "requestGuide should return robotId: null (not throw) for a second visitor once every robot is already escorting");
  assert.equal(
    (secondResult as { reason?: string }).reason,
    "no_idle_robot",
    'the failure reason should be "no_idle_robot" -- an idle robot genuinely wasn\'t available, not an unresolvable target',
  );
  console.log("PASS: requestGuide returns robotId: null / reason: no_idle_robot (no throw) when every robot is already escorting");

  // Re-requesting for the ALREADY-escorted visitor-c1 should also fail cleanly, not
  // double-assign a second robot to it (there isn't a second robot anyway here, but this
  // also guards against ever double-binding a visitor if more robots existed).
  const reRequestResult = room.requestGuide("visitor-c1", "Classroom 1417");
  assert.equal(reRequestResult.robotId, null, "requestGuide should refuse to re-assign a visitor that already has a robot bound");
  console.log("PASS: requestGuide refuses to double-assign an already-escorted visitor");

  const stats = room.getVisitorDebugStats();
  assert.equal(stats.totalVisitors, 2, "both visitor-c1 and visitor-c2 should be tracked");
  assert.equal(stats.escortedVisitors, 1, "exactly one visitor (visitor-c1) should be escorted");
  assert.equal(stats.robotBindings, 1, "exactly one robot binding should exist");
  console.log("PASS: debug stats reflect exactly one escort binding, no double-assignment");

  room.onDispose();
}

/**
 * Defect-A regression test (the bug assignChain.test.ts's
 * `testEscortEndsOnRobotArrivalNotVisitorArrival` found and this fix closes): a robot that
 * happens to already be sitting right at the requested room's door has a near-zero trip of
 * its own and settles to idle almost immediately -- but the escort must NOT release just
 * because of that. It should stay bound until the VISITOR (which may have started far away)
 * has actually caught up, then release once it does.
 */
async function testEscortWaitsForVisitorNotJustRobotArrival(): Promise<void> {
  const room = new WorldRoom();
  await room.onCreate({ disableSimulatedVisitors: true, disableGuideRobots: true });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
  // "South Collaboration Space" is the room farthest from the entrance in floor-14.json
  // (~20.4m, same pick assignChain.test.ts's fix-verification scenario uses) -- needed so
  // the robot's own near-zero trip (spawned AT the door) is unambiguously much shorter than
  // the visitor's real trip from the entrance.
  const destRoom = plan.rooms.find((r) => r.name === "South Collaboration Space");
  assert.ok(destRoom, "floor-14.json should contain 'South Collaboration Space'");
  const [doorX, doorZ] = destRoom!.door;
  const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
  assert.ok(
    entranceToDoorDistance > 15,
    "test setup: entrance -> South Collaboration Space's door should be a genuinely long distance (>15m) for this " +
      `test to be meaningful; got ${entranceToDoorDistance.toFixed(2)}m -- pick a farther room if floor-14.json changed`,
  );

  // Robot spawns AT the door -- its own "trip" is ~0m, so it settles idle almost instantly.
  // The visitor spawns at the entrance, genuinely far away -- exactly the shape of the
  // defect assignChain.test.ts found (a robot that happens to already be near the room).
  room.addAgent("near-door-robot", "robot", { x: doorX, z: doorZ });
  room.addAgent("far-visitor", "visitor", entrance);

  const result = room.requestGuide("far-visitor", "South Collaboration Space");
  assert.ok(result.robotId, "requestGuide should succeed (one idle robot exists)");
  assert.equal(result.robotId, "near-door-robot");

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };

  // Advance a SHORT, bounded window -- comfortably enough for the robot's own near-zero
  // trip to settle to idle, nowhere near enough for the visitor to cross the real
  // entrance-to-door distance on foot (max agent speed 1.4 m/s).
  const SHORT_TICKS = 60; // ~1s simulated
  for (let i = 0; i < SHORT_TICKS; i++) room.update(TICK_MS);

  const robotAfterShort = state.agents.get("near-door-robot")!;
  assert.equal(
    robotAfterShort.state,
    "idle",
    "test setup: the robot's own near-zero trip should have settled to idle well within 1s",
  );

  const statsAfterRobotIdle = room.getVisitorDebugStats();
  assert.equal(
    statsAfterRobotIdle.robotBindings,
    1,
    "defect fix: the escort must NOT release just because the ROBOT went idle -- the visitor is still most of the " +
      "entrance-to-door distance away and has not caught up yet (the old robot-only arrival check would have " +
      "released it here)",
  );
  console.log(
    "PASS: robot settled idle after its own near-zero trip, but the escort stayed bound because the visitor " +
      "hasn't caught up yet",
  );

  // Now give the visitor enough simulated time to actually walk the real distance and
  // catch up to the (now-stationary) robot.
  const MAX_TICKS = 3000; // ~49.8s simulated
  let released = false;
  for (let i = 0; i < MAX_TICKS && !released; i++) {
    room.update(TICK_MS);
    released = room.getVisitorDebugStats().robotBindings === 0;
  }
  assert.ok(released, `escort should release once the visitor genuinely catches up to the robot (within ${MAX_TICKS} ticks)`);

  const visitorFinal = state.agents.get("far-visitor")!;
  const robotFinal = state.agents.get("near-door-robot")!;
  const finalSeparation = Math.hypot(visitorFinal.x - robotFinal.x, visitorFinal.z - robotFinal.z);
  assert.ok(
    finalSeparation <= 1.5,
    `visitor "far-visitor" should have actually closed the gap to the robot before the escort released -- got ` +
      `${finalSeparation.toFixed(2)}m apart`,
  );
  assert.equal(robotFinal.state, "idle", "the robot should still be idle (never re-tasked) once the escort finally releases");
  console.log(
    `PASS: escort released only once the visitor genuinely caught up (final separation ${finalSeparation.toFixed(2)}m), ` +
      "proving completion is gated on the VISITOR's arrival, not just the robot's",
  );

  room.onDispose();
}

/**
 * Safety-valve regression test: the fix above must not be able to deadlock an escort
 * forever if the visitor genuinely never catches up. Uses a short `escortTimeoutSeconds`
 * override (2s of simulated time) rather than an artificially unreachable target, so the
 * test stays fast/deterministic -- any real multi-meter trip takes far longer than 2s at
 * the agent's ~1.4 m/s max speed, so the visitor cannot possibly catch up before the
 * timeout fires. Covers the "escort-timeout path must stay covered" requirement.
 */
async function testEscortTimeoutStillFiresWhenVisitorNeverCatchesUp(): Promise<void> {
  const room = new WorldRoom();
  await room.onCreate({
    disableSimulatedVisitors: true,
    disableGuideRobots: true,
    visitorManagerOptions: { escortTimeoutSeconds: 2 },
  });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
  const destRoom = plan.rooms.find((r) => r.name === "South Collaboration Space")!;
  const [doorX, doorZ] = destRoom.door;
  const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
  assert.ok(
    entranceToDoorDistance > 2,
    `test setup: entrance -> South Collaboration Space's door (${entranceToDoorDistance.toFixed(2)}m) should take ` +
      "genuinely longer than the 2s escort timeout to walk at ~1.4 m/s max speed",
  );

  room.addAgent("timeout-robot", "robot", { x: doorX, z: doorZ });
  room.addAgent("timeout-visitor", "visitor", entrance);

  const result = room.requestGuide("timeout-visitor", "South Collaboration Space");
  assert.ok(result.robotId, "requestGuide should succeed (one idle robot exists)");

  const MAX_TICKS = 600; // ~10s simulated, generous headroom over the 2s timeout
  let released = false;
  for (let i = 0; i < MAX_TICKS && !released; i++) {
    room.update(TICK_MS);
    released = room.getVisitorDebugStats().robotBindings === 0;
  }
  assert.ok(released, "the ESCORT_TIMEOUT_S safety valve should release the binding even though the visitor never caught up");

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };
  const visitorFinal = state.agents.get("timeout-visitor")!;
  const robotFinal = state.agents.get("timeout-robot")!;
  const finalSeparation = Math.hypot(visitorFinal.x - robotFinal.x, visitorFinal.z - robotFinal.z);
  assert.ok(
    finalSeparation > 1.5,
    `test setup: the visitor should still be genuinely far from the robot when the timeout fires (got ` +
      `${finalSeparation.toFixed(2)}m) -- proves the release was via the TIMEOUT, not a coincidental real arrival`,
  );

  const stats = room.getVisitorDebugStats();
  assert.equal(stats.escortedVisitors, 0, "the visitor should no longer be recorded as escorted after the timeout");
  assert.equal(stats.robotBindings, 0, "the robot binding should be released after the timeout");
  assert.equal(robotFinal.state, "idle", "the released robot should be idle, immediately reassignable");

  // Concretely prove "reassignable": the freed robot must be selectable again.
  room.addAgent("timeout-reuse-probe", "visitor", { x: robotFinal.x, z: robotFinal.z });
  const reuse = room.requestGuide("timeout-reuse-probe", { x: robotFinal.x, z: robotFinal.z });
  assert.equal(reuse.robotId, "timeout-robot", "the timed-out robot should be immediately reassignable to a new escort");

  console.log(
    `PASS: escort timeout (2s override) released the binding even though the visitor never caught up ` +
      `(final separation ${finalSeparation.toFixed(2)}m) -- no deadlock, robot reassignable`,
  );

  room.onDispose();
}

/**
 * Pause-correctness regression test (2026-08-03 audit of every timer/accumulator in
 * world/src for Task 5.2's fleet-wide pause): `ESCORT_TIMEOUT_S` (escortManager.ts)
 * accumulates purely in SIMULATED time -- `visitor.escortElapsedSeconds += dtSeconds`
 * lives inside `EscortManager.tick()`, which `WorldRoom.update()` only ever reaches AFTER
 * its `if (this.paused) return;` guard (see WorldRoom.ts's `update()`). That makes the
 * escort timeout correct-by-construction against pause: a pause of any real-world length
 * must not advance the escort clock at all, and the clock must resume from exactly where
 * it left off once resumed -- not reset to fresh, not already-expired. This was
 * previously unverified by any test (the escort timeout is the safety valve that stops a
 * stranded visitor deadlocking an escort forever, load-bearing for the defect fix landed
 * in 7a9b171); this closes that gap. Same class of fix/test as `iot/bridge.ts`'s
 * `navTimeoutMs` pause-correctness (fixed in 40f19c7/cd9aef0, tested in
 * `iot/__tests__/bridge.test.ts`), applied here to the escort timeout, which turned out to
 * already be correct rather than needing a code fix.
 *
 * Uses a short `escortTimeoutSeconds` override (2s), same technique as
 * `testEscortTimeoutStillFiresWhenVisitorNeverCatchesUp` above, so both halves of the
 * proof stay fast and deterministic:
 *   (a) bind an escort that can never catch up in time (near-door robot, far visitor, same
 *       shape as the sibling timeout test), pause IMMEDIATELY (escortElapsedSeconds still
 *       ~0), then tick for far longer than 2s of simulated-time-equivalent WOULD take if
 *       unpaused -- the binding must stay live throughout, and agent positions must not
 *       move at all.
 *   (b) resume, and confirm the escort times out roughly `escortTimeoutSeconds` later --
 *       not instantly (would mean the clock got reset to already-expired) and not never
 *       (would mean the clock got stuck permanently frozen even after resume).
 */
async function testEscortTimeoutPauseCorrectness(): Promise<void> {
  const ESCORT_TIMEOUT_S = 2;
  const room = new WorldRoom();
  await room.onCreate({
    disableSimulatedVisitors: true,
    disableGuideRobots: true,
    visitorManagerOptions: { escortTimeoutSeconds: ESCORT_TIMEOUT_S },
  });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
  const destRoom = plan.rooms.find((r) => r.name === "South Collaboration Space")!;
  const [doorX, doorZ] = destRoom.door;
  const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
  assert.ok(
    entranceToDoorDistance > ESCORT_TIMEOUT_S * 1.4,
    `test setup: entrance -> South Collaboration Space's door (${entranceToDoorDistance.toFixed(2)}m) should be ` +
      `unreachable within the ${ESCORT_TIMEOUT_S}s timeout at the agent's 1.4 m/s max speed`,
  );

  room.addAgent("pause-timeout-robot", "robot", { x: doorX, z: doorZ });
  room.addAgent("pause-timeout-visitor", "visitor", entrance);

  const result = room.requestGuide("pause-timeout-visitor", "South Collaboration Space");
  assert.ok(result.robotId, "requestGuide should succeed (one idle robot exists)");

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };

  // Pause IMMEDIATELY -- escortElapsedSeconds is still ~0 here (requestGuide binds
  // synchronously; no update() tick has run yet since the bind).
  room.pause();
  assert.equal(room.isPaused, true, "pause() should set isPaused true");

  const frozenRobot = { ...state.agents.get("pause-timeout-robot")! };
  const frozenVisitor = { ...state.agents.get("pause-timeout-visitor")! };

  // Tick for far longer (simulated-time-equivalent) than ESCORT_TIMEOUT_S would need to
  // fire if unpaused -- 10s worth of ticks against a 2s timeout. If the timeout clock were
  // (bugged) wall-clock-based instead of gated on update()'s paused early-return, this
  // would already have fired well before this loop ends.
  const PAUSE_TICKS = Math.ceil((ESCORT_TIMEOUT_S * 5 * 1000) / TICK_MS);
  for (let i = 0; i < PAUSE_TICKS; i++) {
    room.update(TICK_MS);
    assert.equal(
      room.getVisitorDebugStats().robotBindings,
      1,
      `escort must NOT time out while paused (tick ${i} of ${PAUSE_TICKS}, ${ESCORT_TIMEOUT_S}s timeout, ` +
        `${((i * TICK_MS) / 1000).toFixed(1)}s of would-be simulated time elapsed)`,
    );
  }

  const robotAfterPause = state.agents.get("pause-timeout-robot")!;
  const visitorAfterPause = state.agents.get("pause-timeout-visitor")!;
  assert.equal(robotAfterPause.x, frozenRobot.x, "robot x must not change while paused");
  assert.equal(robotAfterPause.z, frozenRobot.z, "robot z must not change while paused");
  assert.equal(visitorAfterPause.x, frozenVisitor.x, "visitor x must not change while paused");
  assert.equal(visitorAfterPause.z, frozenVisitor.z, "visitor z must not change while paused");
  console.log(
    `PASS: escort survived ${((PAUSE_TICKS * TICK_MS) / 1000).toFixed(1)}s of would-be simulated time ` +
      `(${ESCORT_TIMEOUT_S}s timeout) fully paused -- binding stayed live, positions frozen`,
  );

  room.resume();
  assert.equal(room.isPaused, false, "resume() should set isPaused false");

  // The escort must still eventually time out post-resume (the visitor genuinely never
  // catches up within the timeout) -- and it should take roughly ESCORT_TIMEOUT_S more of
  // simulated time from HERE, not instantly (clock reset-to-expired bug) and not never
  // (clock permanently stuck bug).
  const MAX_POST_RESUME_TICKS = Math.ceil((ESCORT_TIMEOUT_S * 5 * 1000) / TICK_MS);
  let ticksToTimeout = 0;
  let released = false;
  for (let i = 0; i < MAX_POST_RESUME_TICKS && !released; i++) {
    room.update(TICK_MS);
    ticksToTimeout++;
    released = room.getVisitorDebugStats().robotBindings === 0;
  }
  assert.ok(
    released,
    `escort should still time out after resume (within ${MAX_POST_RESUME_TICKS} post-resume ticks) since the ` +
      "visitor genuinely never caught up",
  );

  const secondsToTimeout = (ticksToTimeout * TICK_MS) / 1000;
  assert.ok(
    secondsToTimeout >= ESCORT_TIMEOUT_S * 0.5 && secondsToTimeout <= ESCORT_TIMEOUT_S * 2,
    `post-resume, the timeout should fire roughly ${ESCORT_TIMEOUT_S}s later (proving the clock resumed from ` +
      `where it left off, not reset) -- took ${secondsToTimeout.toFixed(2)}s`,
  );
  console.log(
    `PASS: post-resume, escort timed out after ${secondsToTimeout.toFixed(2)}s (~matches the ${ESCORT_TIMEOUT_S}s ` +
      "timeout, proving the escort clock resumed from where it left off, not reset or permanently stuck)",
  );

  const visitorFinal = state.agents.get("pause-timeout-visitor")!;
  const robotFinal = state.agents.get("pause-timeout-robot")!;
  const finalSeparation = Math.hypot(visitorFinal.x - robotFinal.x, visitorFinal.z - robotFinal.z);
  assert.ok(
    finalSeparation > 1.5,
    `test setup: the visitor should still be genuinely far from the robot when the timeout fires (got ` +
      `${finalSeparation.toFixed(2)}m) -- proves release was via the TIMEOUT, not a coincidental arrival`,
  );
  assert.equal(robotFinal.state, "idle", "the released robot should be idle, immediately reassignable");

  room.onDispose();
}

/**
 * Pause-correctness regression test for the simulated-visitor lifecycle as a whole (spawn
 * stagger, the "waiting_for_robot" retry cooldown, the dwell countdown, and the
 * despawn-on-idle check for "walking_to_entrance") -- not just the escort timeout above.
 * Every one of these is a `-= dtSeconds`-style accumulator inside
 * `SimulatedVisitorSpawner.tick()`/`tickLifecycle()` (simulatedVisitorSpawner.ts), driven
 * only from `VisitorManager.tick()` (visitors.ts), itself only ever reached from
 * `WorldRoom.update()` AFTER the SAME `if (this.paused) return;` guard that gates the
 * escort tick and the crowd tick -- see WorldRoom.ts's `update()`. So by construction the
 * whole simulated-visitor lifecycle should freeze exactly like the escort timeout above,
 * and resume cleanly with no stampede and no lost/corrupted progress. This pins that at
 * the aggregate level (`getVisitorDebugStats()`) an operator narrating a demo actually
 * cares about: pausing for a while and resuming should look like nothing happened, not
 * cause a burst of despawns/spawns or a spike past the target headcount.
 */
async function testSimulatedSpawnerPauseFreezesLifecycle(): Promise<void> {
  const room = new WorldRoom();
  // Small target + tight timings so this test stays fast while still exercising every
  // simulated-visitor phase (spawn stagger, wait-for-robot retry, dwell, walk-to-entrance)
  // within a bounded tick budget.
  const SIM_TARGET = 8;
  await room.onCreate({
    disableGuideRobots: true,
    visitorManagerOptions: {
      simulatedTarget: SIM_TARGET,
      spawnStaggerSeconds: 0.2,
      dwellMinSeconds: 0.5,
      dwellMaxSeconds: 1,
    },
  });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
  const ROBOT_COUNT = 12; // comfortably above SIM_TARGET
  for (let i = 0; i < ROBOT_COUNT; i++) {
    room.addAgent(`pause-lifecycle-robot-${i}`, "robot", entrance);
  }

  // Warm up to a steady state where visitors are actively cycling through every phase
  // (spawn -> waiting_for_robot -> walking_to_room -> dwelling -> walking_to_entrance ->
  // despawn) -- 30s simulated is many multiples of the ~0.5-1s dwell + short trips at this
  // scale.
  for (let i = 0; i < 1800; i++) room.update(TICK_MS);

  const beforePause = room.getVisitorDebugStats();
  assert.ok(beforePause.simulatedActive > 0, "test setup: some simulated visitors should be active before pausing");

  room.pause();
  assert.equal(room.isPaused, true);

  // Tick for a duration that, if unpaused, would comfortably cycle every visitor through
  // several full spawn/dwell/despawn loops (dwell alone is 0.5-1s; this is 20s).
  const PAUSE_TICKS = 1200;
  for (let i = 0; i < PAUSE_TICKS; i++) {
    room.update(TICK_MS);
    const stats = room.getVisitorDebugStats();
    assert.deepEqual(
      stats,
      beforePause,
      `simulated-visitor debug stats must not change at all while paused (tick ${i} of ${PAUSE_TICKS})`,
    );
  }
  console.log(
    `PASS: simulated-visitor lifecycle (spawn/dwell/escort counts) fully frozen across ${(
      (PAUSE_TICKS * TICK_MS) /
      1000
    ).toFixed(1)}s of would-be simulated time while paused`,
  );

  room.resume();
  assert.equal(room.isPaused, false);

  // After resume, the lifecycle should carry on sanely: never exceed the target, never let
  // escortedVisitors/robotBindings desync, and never exceed the available robot supply --
  // i.e. no stampede and no corruption from having been paused.
  for (let i = 0; i < 1800; i++) {
    room.update(TICK_MS);
    const stats = room.getVisitorDebugStats();
    assert.ok(
      stats.simulatedActive <= SIM_TARGET,
      `simulated visitor count (${stats.simulatedActive}) must not exceed the target (${SIM_TARGET}) after resume`,
    );
    assert.equal(
      stats.escortedVisitors,
      stats.robotBindings,
      "escortedVisitors/robotBindings must not diverge after resume",
    );
    assert.ok(
      stats.robotBindings <= ROBOT_COUNT,
      `robotBindings (${stats.robotBindings}) must not exceed available robots (${ROBOT_COUNT}) after resume`,
    );
  }
  console.log(
    "PASS: simulated-visitor lifecycle resumes and runs sanely after a pause -- no stampede, no double-assignment",
  );

  room.onDispose();
}

async function main(): Promise<void> {
  await testRequestGuideConvergenceAndTrailing();
  await testRequestGuideReturnsNullWhenNoRobotIdle();
  await testEscortWaitsForVisitorNotJustRobotArrival();
  await testEscortTimeoutStillFiresWhenVisitorNeverCatchesUp();
  await testEscortTimeoutPauseCorrectness();
  await testSimulatedSpawnerPauseFreezesLifecycle();
  await testSimulatedSpawnerConvergence();

  console.log("\nALL PASS: visitors.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
