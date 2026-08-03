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
  assert.ok(result, "requestGuide should succeed when an idle robot is available");
  assert.equal(result!.robotId, "robot-b", "requestGuide should pick the nearest idle robot (robot-b, not one of the 50 seeded fleet robots)");
  console.log(`PASS: requestGuide("visitor-b", "Event Space") assigned robot "${result!.robotId}"`);

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
  assert.ok(firstResult, "requestGuide should succeed for the first visitor (one idle robot exists)");
  console.log(`PASS: requestGuide("visitor-c1", ...) succeeded (no throw), assigned "${firstResult!.robotId}"`);

  const secondResult = room.requestGuide("visitor-c2", "Classroom 1426");
  assert.equal(secondResult, null, "requestGuide should return null (not throw) for a second visitor once every robot is already escorting");
  console.log("PASS: requestGuide returns null (no throw) when every robot is already escorting");

  // Re-requesting for the ALREADY-escorted visitor-c1 should also fail cleanly, not
  // double-assign a second robot to it (there isn't a second robot anyway here, but this
  // also guards against ever double-binding a visitor if more robots existed).
  const reRequestResult = room.requestGuide("visitor-c1", "Classroom 1417");
  assert.equal(reRequestResult, null, "requestGuide should refuse to re-assign a visitor that already has a robot bound");
  console.log("PASS: requestGuide refuses to double-assign an already-escorted visitor");

  const stats = room.getVisitorDebugStats();
  assert.equal(stats.totalVisitors, 2, "both visitor-c1 and visitor-c2 should be tracked");
  assert.equal(stats.escortedVisitors, 1, "exactly one visitor (visitor-c1) should be escorted");
  assert.equal(stats.robotBindings, 1, "exactly one robot binding should exist");
  console.log("PASS: debug stats reflect exactly one escort binding, no double-assignment");

  room.onDispose();
}

async function main(): Promise<void> {
  await testRequestGuideConvergenceAndTrailing();
  await testRequestGuideReturnsNullWhenNoRobotIdle();
  await testSimulatedSpawnerConvergence();

  console.log("\nALL PASS: visitors.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
