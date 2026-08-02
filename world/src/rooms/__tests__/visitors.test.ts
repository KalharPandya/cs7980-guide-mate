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
  const room1425 = plan.rooms.find((r) => r.name === "Classroom 1425");
  const room1426 = plan.rooms.find((r) => r.name === "Classroom 1426");
  assert.ok(room1425, "floor-14.json should contain 'Classroom 1425'");
  assert.ok(room1426, "floor-14.json should contain 'Classroom 1426'");
  const [doorX, doorZ] = room1425!.door;

  // Spawn robot-b/visitor-b together near a DIFFERENT room's door (not the entrance, where
  // WorldRoom's own seeded TEST_AGENT_ID robot sits) so robot-b is unambiguously the
  // nearest idle robot to visitor-b -- proving the "nearest idle robot" selection, not just
  // "the only robot that exists".
  const spawnPoint = { x: room1426!.door[0], z: room1426!.door[1] };
  room.addAgent("robot-b", "robot", spawnPoint);
  room.addAgent("visitor-b", "visitor", spawnPoint);

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };

  const result = room.requestGuide("visitor-b", "Classroom 1425");
  assert.ok(result, "requestGuide should succeed when an idle robot is available");
  assert.equal(result!.robotId, "robot-b", "requestGuide should pick the nearest idle robot (robot-b, not the distant seeded test robot)");
  console.log(`PASS: requestGuide("visitor-b", "Classroom 1425") assigned robot "${result!.robotId}"`);

  let statsAfterBind = room.getVisitorDebugStats();
  assert.equal(statsAfterBind.escortedVisitors, 1, "exactly one visitor should be escorted right after a successful requestGuide");
  assert.equal(statsAfterBind.robotBindings, 1, "exactly one robot binding should exist right after a successful requestGuide");

  const visitorStart = { ...state.agents.get("visitor-b")! };

  const MAX_TICKS = 2000; // matches WorldRoom.test.ts's convergence budget
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
    `assigned robot did not converge within ${DOOR_TOLERANCE_M}m of Classroom 1425's door; last distance ${robotDoorDist.toFixed(2)}m`,
  );
  console.log(`PASS: assigned robot "robot-b" converged to within ${robotDoorDist.toFixed(2)}m of Classroom 1425's door`);

  const visitorNetDisplacement = Math.hypot(
    lastVisitorPos.x - visitorStart.x,
    lastVisitorPos.z - visitorStart.z,
  );
  assert.ok(
    visitorMovedTotal > 1.0,
    `visitor-b should have covered real distance while trailing the robot (moved ${visitorMovedTotal.toFixed(2)}m total) -- not stationary`,
  );
  assert.ok(
    visitorNetDisplacement > 0.5,
    `visitor-b's net displacement (${visitorNetDisplacement.toFixed(2)}m) should be meaningfully away from its spawn point`,
  );
  assert.ok(sawNonTrivialSeparation, "visitor-b should stay a real trailing distance behind robot-b, not overlap it");
  console.log(
    `PASS: visitor-b trailed behind robot-b (moved ${visitorMovedTotal.toFixed(2)}m total, ` +
      `net displacement ${visitorNetDisplacement.toFixed(2)}m from spawn, never collapsed onto the robot)`,
  );

  // Keep ticking a bounded extra amount for the robot to settle to idle at its door and for
  // the escort to un-bind (mirrors WorldRoom.test.ts's settle-tick pattern).
  const MAX_SETTLE_TICKS = 300;
  let settled = false;
  for (let i = 0; i < MAX_SETTLE_TICKS; i++) {
    room.update(TICK_MS);
    const stats = room.getVisitorDebugStats();
    if (stats.escortedVisitors === 0) {
      settled = true;
      break;
    }
  }
  assert.ok(settled, "escort binding should be released once the robot arrives and settles to idle");
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
