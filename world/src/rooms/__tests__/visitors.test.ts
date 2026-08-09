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
  // Wellness Room and Event Space sit on opposite sides of the building core, ~18m apart
  // door-to-door (measured below), giving the LEADING phase a real trip to trail over.
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

  // Spawn robot-b/visitor-b TOGETHER at Wellness Room's door so robot-b is unambiguously the
  // nearest idle robot to visitor-b (distance 0) even with the GUIDE_ROBOT_COUNT fleet
  // present -- proving the "nearest idle robot" selection, not just "the only robot that
  // exists". Co-spawning also makes the "approaching" phase trivial (the robot is already at
  // the person), so this test focuses on the GREETING pause and the LEADING trail/release;
  // testEscortWaitsForVisitorNotJustRobotArrival covers a real, long approaching trip.
  const spawnPoint = { x: originRoom!.door[0], z: originRoom!.door[1] };
  room.addAgent("robot-b", "robot", spawnPoint);
  room.addAgent("visitor-b", "visitor", spawnPoint);

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };

  const result = room.requestGuide("visitor-b", "Event Space");
  assert.ok(result.robotId, "requestGuide should succeed when an idle robot is available");
  assert.equal(result.robotId, "robot-b", "requestGuide should pick the nearest idle robot (robot-b, co-spawned with the visitor)");
  console.log(`PASS: requestGuide("visitor-b", "Event Space") assigned robot "${result.robotId}"`);

  const statsAfterBind = room.getVisitorDebugStats();
  assert.equal(statsAfterBind.escortedVisitors, 1, "exactly one visitor should be escorted right after a successful requestGuide");
  assert.equal(statsAfterBind.robotBindings, 1, "exactly one robot binding should exist right after a successful requestGuide");

  const visitorStart = { ...state.agents.get("visitor-b")! };

  // We cannot read escortPhase from outside WorldRoom, so infer the 3 phases from observable
  // robot/visitor position + state:
  //   greeting: after the robot reaches the person, both stay idle and close for a randomized
  //             ~10-15s pause, BEFORE the visitor starts moving toward Event Space.
  //   leading:  the visitor starts moving, trails the robot, the robot converges on the door,
  //             and the escort releases once the visitor catches up.
  const MAX_TICKS = 4200; // ~69.7s simulated -- generous over the ~33s observed full flow
  let elapsed = 0;
  let visitorMovedTotal = 0;
  let lastVisitorPos = { x: visitorStart.x, z: visitorStart.z };
  let sawNonTrivialSeparation = false;

  // greeting detection
  let greetStartS = -1;
  let cumAtGreetStart = 0;
  let maxGreetSeparation = 0;
  let leadStartS = -1;

  // leading detection
  let robotConvergedDoorDist = Infinity;
  let released = false;
  let finalSeparation = 0;

  for (let i = 0; i < MAX_TICKS; i++) {
    room.update(TICK_MS);
    elapsed += TICK_MS / 1000;
    const robot = state.agents.get("robot-b")!;
    const visitor = state.agents.get("visitor-b")!;

    const step = Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
    visitorMovedTotal += step;
    lastVisitorPos = { x: visitor.x, z: visitor.z };

    const separation = Math.hypot(visitor.x - robot.x, visitor.z - robot.z);
    finalSeparation = separation;
    if (separation > 0.15) sawNonTrivialSeparation = true;

    const robotDoorDist = Math.hypot(robot.x - doorX, robot.z - doorZ);
    if (robotDoorDist <= DOOR_TOLERANCE_M) robotConvergedDoorDist = robotDoorDist;

    if (greetStartS < 0) {
      // robot reached the person (greeting begins)
      if (robot.state === "idle" && separation <= 2.5 && elapsed > 0.5) {
        greetStartS = elapsed;
        cumAtGreetStart = visitorMovedTotal;
        maxGreetSeparation = separation;
      }
    } else if (leadStartS < 0) {
      // still greeting: both should stay together and near-stationary
      maxGreetSeparation = Math.max(maxGreetSeparation, separation);
      if (visitorMovedTotal - cumAtGreetStart > 0.5) leadStartS = elapsed; // visitor set off => leading
    }

    if (leadStartS > 0 && room.getVisitorDebugStats().robotBindings === 0) {
      released = true;
      break;
    }
  }

  // ---- greeting: a real ~10-15s pause where both stay together, before leading ----
  assert.ok(greetStartS > 0, "the robot should reach the person and begin the greeting pause");
  // The visitor should barely have moved by the time the greeting starts (co-spawned here, so
  // it never had to walk anywhere during approaching).
  assert.ok(
    cumAtGreetStart < 1.0,
    `visitor-b should stay put before leading begins (moved ${cumAtGreetStart.toFixed(2)}m before the greeting)`,
  );
  assert.ok(leadStartS > 0, "leading should begin after the greeting pause");
  const greetDuration = leadStartS - greetStartS;
  assert.ok(
    greetDuration >= 9 && greetDuration <= 16.5,
    `greeting pause should last ~10-15s of simulated time before leading (got ${greetDuration.toFixed(2)}s)`,
  );
  assert.ok(
    maxGreetSeparation <= 2.6,
    `robot-b and visitor-b should stay together (both roughly idle) throughout the greeting pause ` +
      `(max separation ${maxGreetSeparation.toFixed(2)}m)`,
  );
  console.log(
    `PASS: greeting pause observed for ${greetDuration.toFixed(2)}s (both idle/near, max sep ${maxGreetSeparation.toFixed(2)}m) before leading`,
  );

  // ---- leading: the robot converges on the door, the visitor trails and catches up ----
  assert.ok(
    robotConvergedDoorDist <= DOOR_TOLERANCE_M,
    `assigned robot did not converge within ${DOOR_TOLERANCE_M}m of Event Space's door during leading; last convergence ${robotConvergedDoorDist.toFixed(2)}m`,
  );
  assert.ok(released, "escort binding should be released once the robot arrives and the visitor catches up");

  const visitorNetDisplacement = Math.hypot(
    lastVisitorPos.x - visitorStart.x,
    lastVisitorPos.z - visitorStart.z,
  );
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
  assert.ok(sawNonTrivialSeparation, "visitor-b should stay a real trailing distance behind robot-b during leading, not overlap it");
  // The escort releases once the visitor is within the arrival radius (VISITOR_ARRIVAL_DISTANCE_M
  // = 2.5m) of the robot-at-destination, per the documented completion contract.
  assert.ok(
    finalSeparation <= 2.5,
    `visitor-b should have caught up to within the arrival radius of robot-b before the escort released (final separation ${finalSeparation.toFixed(2)}m)`,
  );
  console.log(
    `PASS: visitor-b trailed behind robot-b during leading (moved ${visitorMovedTotal.toFixed(2)}m total, ` +
      `net displacement ${visitorNetDisplacement.toFixed(2)}m, caught up to ${finalSeparation.toFixed(2)}m at release)`,
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
 * 3-phase escort regression test with a REAL, long "approaching" leg. A single robot is
 * spawned FAR from the waiting visitor (at the destination door), so the "approaching" phase
 * is a genuine multi-meter trip the robot must make TO the person while the person waits in
 * place. Verifies all three phases:
 *   - approaching: the robot travels to the person; the person's net displacement stays ~0
 *     and the escort stays bound the whole time.
 *   - greeting:    once the robot reaches the person, both stay together for a randomized
 *     ~10-15s pause before leading.
 *   - leading:     the robot leads to the destination and the visitor follows; the escort
 *     releases only once the visitor has actually caught up (the existing visitor-arrival
 *     gating, now exercised at the end of the leading phase), with the SPECIFIC robot's
 *     binding cleared at release (single robot here, so robotBindings===0 is that robot).
 */
async function testEscortWaitsForVisitorNotJustRobotArrival(): Promise<void> {
  const room = new WorldRoom();
  await room.onCreate({ disableSimulatedVisitors: true, disableGuideRobots: true });
  room.setSimulationInterval();

  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
  // "South Collaboration Space" is the room farthest from the entrance in floor-14.json
  // (~20.4m) -- so a robot spawned at its door has a genuinely long trip TO the waiting
  // visitor at the entrance during approaching.
  const destRoom = plan.rooms.find((r) => r.name === "South Collaboration Space");
  assert.ok(destRoom, "floor-14.json should contain 'South Collaboration Space'");
  const [doorX, doorZ] = destRoom!.door;
  const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
  assert.ok(
    entranceToDoorDistance > 15,
    "test setup: entrance -> South Collaboration Space's door should be a genuinely long distance (>15m) for this " +
      `test to be meaningful; got ${entranceToDoorDistance.toFixed(2)}m -- pick a farther room if floor-14.json changed`,
  );

  // Robot spawns AT the destination door, far from the visitor; the visitor waits at the
  // entrance. The robot must FETCH the person first (approaching), then greet, then lead them
  // back to the destination.
  const robotStart = { x: doorX, z: doorZ };
  room.addAgent("fetch-robot", "robot", robotStart);
  room.addAgent("wait-visitor", "visitor", entrance);

  const result = room.requestGuide("wait-visitor", "South Collaboration Space");
  assert.ok(result.robotId, "requestGuide should succeed (one idle robot exists)");
  assert.equal(result.robotId, "fetch-robot");

  const state = room.state as unknown as {
    agents: Map<string, { x: number; z: number; state: string }>;
  };
  const visitorStart = { ...state.agents.get("wait-visitor")! };
  assert.equal(room.getVisitorDebugStats().robotBindings, 1, "escort should be bound immediately after requestGuide");

  let phase: "approach" | "greet" | "lead" | "done" = "approach";
  let elapsed = 0;
  let visitorCum = 0;
  let lastVisitorPos = { x: visitorStart.x, z: visitorStart.z };

  let approachDisp = 0;
  let robotTravelDuringApproach = 0;
  let approachEndS = -1;
  let cumAtGreetStart = 0;
  let maxGreetSeparation = 0;
  let leadStartS = -1;
  let robotReachedDoor = false;
  let finalSeparation = 0;

  const MAX_TICKS = 6000; // ~99.6s simulated -- generous over the ~53s observed full flow
  for (let i = 0; i < MAX_TICKS && phase !== "done"; i++) {
    room.update(TICK_MS);
    elapsed += TICK_MS / 1000;
    const robot = state.agents.get("fetch-robot")!;
    const visitor = state.agents.get("wait-visitor")!;

    visitorCum += Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
    lastVisitorPos = { x: visitor.x, z: visitor.z };
    const separation = Math.hypot(visitor.x - robot.x, visitor.z - robot.z);
    finalSeparation = separation;
    if (Math.hypot(robot.x - doorX, robot.z - doorZ) <= DOOR_TOLERANCE_M) robotReachedDoor = true;

    if (phase === "approach") {
      // The escort must stay bound while the robot is still fetching the person.
      assert.equal(
        room.getVisitorDebugStats().robotBindings,
        1,
        "the escort must stay bound throughout approaching (the robot is still fetching the person)",
      );
      if (robot.state === "idle" && separation <= 2.5 && elapsed > 0.5) {
        approachEndS = elapsed;
        approachDisp = Math.hypot(visitor.x - visitorStart.x, visitor.z - visitorStart.z);
        robotTravelDuringApproach = Math.hypot(robot.x - robotStart.x, robot.z - robotStart.z);
        cumAtGreetStart = visitorCum;
        maxGreetSeparation = separation;
        phase = "greet";
      }
    } else if (phase === "greet") {
      maxGreetSeparation = Math.max(maxGreetSeparation, separation);
      if (visitorCum - cumAtGreetStart > 0.5) {
        leadStartS = elapsed;
        phase = "lead";
      }
    } else if (phase === "lead") {
      // Single robot => robotBindings===0 is specifically THIS robot's binding clearing.
      if (room.getVisitorDebugStats().robotBindings === 0) phase = "done";
    }
  }

  // ---- approaching: the robot did a real trip to the person; the person stayed put ----
  assert.ok(approachEndS > 0, "the robot should reach the waiting person during approaching");
  assert.ok(
    robotTravelDuringApproach > 10,
    `the robot should travel a real distance to fetch the person (got ${robotTravelDuringApproach.toFixed(2)}m)`,
  );
  assert.ok(
    approachDisp < 1.0,
    `the person should wait in place while being approached (net displacement ${approachDisp.toFixed(2)}m during approaching)`,
  );
  console.log(
    `PASS: robot traveled ${robotTravelDuringApproach.toFixed(2)}m to fetch the person, who stayed put ` +
      `(${approachDisp.toFixed(2)}m net) with the escort bound throughout approaching`,
  );

  // ---- greeting: a real ~10-15s pause where both stayed together, before leading ----
  assert.ok(leadStartS > 0, "leading should begin after the greeting pause");
  const greetDuration = leadStartS - approachEndS;
  assert.ok(
    greetDuration >= 9 && greetDuration <= 16.5,
    `greeting pause should last ~10-15s of simulated time (got ${greetDuration.toFixed(2)}s)`,
  );
  assert.ok(
    maxGreetSeparation <= 2.6,
    `robot and person should stay together during the greeting pause (max separation ${maxGreetSeparation.toFixed(2)}m)`,
  );
  console.log(`PASS: greeting pause observed for ${greetDuration.toFixed(2)}s (max sep ${maxGreetSeparation.toFixed(2)}m) before leading`);

  // ---- leading: the visitor followed and the escort released only once it caught up ----
  assert.equal(phase, "done", "the assigned robot's escort should release once its visitor catches up during leading");
  assert.ok(robotReachedDoor, "the robot should have led the visitor back to the destination door");
  // Release fires once the visitor is within the arrival radius (VISITOR_ARRIVAL_DISTANCE_M =
  // 2.5m) of the robot-at-destination -- the documented completion contract.
  assert.ok(
    finalSeparation <= 2.5,
    `visitor "wait-visitor" should have closed to within the arrival radius of the robot before the escort released -- got ${finalSeparation.toFixed(2)}m apart`,
  );
  const robotFinal = state.agents.get("fetch-robot")!;
  // The robot may still read "moving" at release (a trailing visitor packing against it keeps
  // its realized speed flickering above the idle threshold); the meaningful checks are that it
  // has genuinely reached the destination and its binding is cleared.
  assert.ok(
    Math.hypot(robotFinal.x - doorX, robotFinal.z - doorZ) <= DOOR_TOLERANCE_M * 2,
    `the robot should be at the destination door when the escort releases (got ${Math.hypot(robotFinal.x - doorX, robotFinal.z - doorZ).toFixed(2)}m)`,
  );
  assert.equal(room.getVisitorDebugStats().robotBindings, 0, "the specific robot's binding should be cleared at release");
  console.log(
    `PASS: escort released only once the visitor genuinely caught up (final separation ${finalSeparation.toFixed(2)}m), ` +
      "proving completion is gated on the VISITOR's arrival during leading",
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

  // The timeout fired during the "approaching" leg, so the robot was still walking TO the
  // person (state "moving") the instant the binding released -- unlike the old flow, where the
  // robot sat idle at its destination. It is no longer bound (no deadlock) and settles back to
  // idle on its own shortly after (it finishes its move, then parks). Advance until it settles,
  // then prove reassignability.
  let robotSettledIdle = false;
  for (let i = 0; i < 5000 && !robotSettledIdle; i++) {
    room.update(TICK_MS);
    robotSettledIdle =
      state.agents.get("timeout-robot")!.state === "idle" && room.getVisitorDebugStats().robotBindings === 0;
  }
  assert.ok(robotSettledIdle, "the timed-out robot should settle back to idle on its own (no deadlock)");

  // Concretely prove "reassignable": the freed robot must be selectable again.
  const robotSettled = state.agents.get("timeout-robot")!;
  room.addAgent("timeout-reuse-probe", "visitor", { x: robotSettled.x, z: robotSettled.z });
  const reuse = room.requestGuide("timeout-reuse-probe", { x: robotSettled.x, z: robotSettled.z });
  assert.equal(reuse.robotId, "timeout-robot", "the timed-out robot should be reassignable to a new escort once it settles");

  console.log(
    `PASS: escort timeout (2s override) released the binding even though the robot never reached the visitor ` +
      `(separation ${finalSeparation.toFixed(2)}m at timeout) -- no deadlock, robot reassignable once settled`,
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
  // The timeout fired during the "approaching" leg (robot walking to the person), so the
  // robot is mid-trip (state "moving") the instant it releases -- the meaningful post-resume
  // claim here is that the binding is genuinely gone, not that the robot is parked.
  assert.equal(room.getVisitorDebugStats().robotBindings, 0, "the escort binding should be released (unbound) after the post-resume timeout");

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

/**
 * REGRESSION (a real false-completion defect, reproduced against the real WorldRoom before it
 * was fixed): an escort must not report `completed` until the PERSON is actually at the room
 * they asked for. This pins the scenario that broke, exactly as it broke.
 *
 * ---- the scenario, and why these specific fixtures ----
 * A visitor is spawned in "Classroom 1425" (i.e. NOT at the entrance -- the `from_room` path
 * the IoT bridge uses when the user says where they already are) and asks for the "Kitchen",
 * 20.3m away. The REAL guide fleet is left enabled and un-mocked, because the trigger is a
 * property of the real deterministic fleet spawn grid: `guideFleetSpawns.ts` puts "virtual/5"
 * at (4.00, 12.06), which is 2.96m from that classroom, so `requestGuide` (which picks the
 * idle robot nearest the PERSON) picks a robot that is already essentially on top of them. All
 * three of those facts are asserted as setup below rather than assumed, so if floor-14.json or
 * the spawn grid changes this test says so instead of quietly testing nothing.
 *
 * ---- what used to happen ----
 * The fetch leg worked: the robot walked 2.96m to the person and stopped. Stopping made its
 * schema `state` read "idle", and the robot half of the completion test accepted a bare
 * "robot is idle" as "robot has arrived at the destination". The visitor half was satisfied
 * too -- the person it had just walked over to was 1.37m away, well inside
 * VISITOR_ARRIVAL_DISTANCE_M. So both halves of "arrived" were true at the PICKUP point, and
 * 4.0s into the guide leg the escort reported
 * `{"outcome":"completed","phase":"leading","separationM":1.37,"robotIdleAtDestination":true}`
 * with both of them still ~20.7m from the Kitchen. The robot then un-bound and went home; the
 * person was never taken anywhere. `separationM` (robot-to-visitor) looked perfectly healthy
 * throughout, which is exactly why the escort harness's 98.6% "completion" rate never showed it.
 *
 * ---- what is asserted ----
 * The completion CONTRACT, deliberately not a timeline or a specific outcome: an escort may
 * only be reported `completed` if the person actually ended up within
 * ROBOT_DESTINATION_RADIUS_M + VISITOR_ARRIVAL_DISTANCE_M (1.0 + 2.5 = 3.5m) of the destination
 * they asked for, and the ROBOT within ROBOT_DESTINATION_RADIUS_M of it. Against the pre-fix
 * code this run reports `completed` with the person 20.78m away and fails; against the fixed
 * code the escort ends honestly.
 *
 * It deliberately does NOT assert `outcome === "completed"`. On the current crowd tuning this
 * particular geometry ALSO trips a separate, pre-existing navigation defect (the fetch leg
 * leaves the robot parked just inside a doorway with the person it collected 1.36m away on the
 * far side, and Detour's separation force then pins it on its own first corridor corner for the
 * rest of the leg -- robot idle at (5.38, 13.02) with `corners()` pointing at (5.40, 13.06),
 * neither agent moving again), so the escort correctly runs out the ESCORT_TIMEOUT_S clock and
 * is reported `timed_out`. That is the RIGHT behaviour for an escort that never delivered, and
 * it is what the old code was papering over by declaring victory at pickup. Pinning the outcome
 * string here would either bake that navigation defect in as expected, or make this regression
 * test fail for a reason it is not about; pinning the contract catches the false completion
 * either way and keeps passing once the navigation jam is fixed.
 *
 * It also checks the two-phase fetch-then-lead behaviour survives the fix -- the robot comes to
 * the person first and the person waits in place while it does.
 */
async function testEscortDoesNotCompleteAtThePickupPoint(): Promise<void> {
  const outcomes: {
    outcome: string;
    phase: string;
    durationSeconds: number;
    separationM: number;
    visitorDistanceToDestinationM: number | null;
    robotDistanceToDestinationM: number | null;
  }[] = [];

  const room = new WorldRoom();
  // Real fleet ON (the near-spawning robot is the whole point); only the background simulated
  // visitors are disabled, so the one escort under test is the only thing moving.
  await room.onCreate({
    disableSimulatedVisitors: true,
    visitorManagerOptions: { onEscortOutcome: (o) => outcomes.push(o) },
  });
  room.setSimulationInterval();

  const fromPoint = room.resolveRoomPoint("Classroom 1425");
  const destPoint = room.resolveRoomPoint("Kitchen");
  assert.ok(fromPoint, "test setup: floor-14.json must contain 'Classroom 1425'");
  assert.ok(destPoint, "test setup: floor-14.json must contain 'Kitchen'");

  const personToDestination = Math.hypot(fromPoint!.x - destPoint!.x, fromPoint!.z - destPoint!.z);
  assert.ok(
    personToDestination > 15,
    "test setup: the person's own trip must be genuinely long, or 'completed at the pickup point' and " +
      `'completed at the destination' would be the same place; got ${personToDestination.toFixed(2)}m`,
  );

  room.addAgent("pickup-defect-visitor", "visitor", { x: fromPoint!.x, z: fromPoint!.z });
  const result = room.requestGuide("pickup-defect-visitor", "Kitchen");
  assert.ok(result.robotId, "requestGuide should bind an idle fleet robot");
  const robotId = result.robotId!;

  const state = room.state as unknown as { agents: Map<string, { x: number; z: number; state: string }> };
  const personStart = { ...state.agents.get("pickup-defect-visitor")! };
  const robotStart = { ...state.agents.get(robotId)! };
  const robotToPersonAtBind = Math.hypot(robotStart.x - personStart.x, robotStart.z - personStart.z);
  assert.ok(
    robotToPersonAtBind < 3.5,
    `test setup: the assigned robot must spawn CLOSE to the person (that is what makes its post-fetch idle ` +
      `state look like "arrived"); got ${robotToPersonAtBind.toFixed(2)}m from robot "${robotId}"`,
  );
  console.log(
    `[setup] robot "${robotId}" starts ${robotToPersonAtBind.toFixed(2)}m from the person, who is ` +
      `${personToDestination.toFixed(2)}m from the "Kitchen" they asked for`,
  );

  // The completion contract: robot within ROBOT_DESTINATION_RADIUS_M (1.0m) of the destination
  // AND person within VISITOR_ARRIVAL_DISTANCE_M (2.5m) of the robot => person within 3.5m of
  // the destination. Same bound assignChain.test.ts asserts against.
  const DELIVERED_RADIUS_M = DOOR_TOLERANCE_M + 2.5;

  let robotReachedPerson = false;
  let personDriftWhileFetching = 0;
  const MAX_TICKS = 18000; // ~299s simulated: far more than the ~38s the fixed flow takes, and
  // more than the 90s ESCORT_TIMEOUT_S too, so a stalled escort ends here rather than the loop
  for (let i = 0; i < MAX_TICKS && outcomes.length === 0; i++) {
    room.update(TICK_MS);
    const person = state.agents.get("pickup-defect-visitor")!;
    const robot = state.agents.get(robotId)!;
    if (!robotReachedPerson) {
      personDriftWhileFetching = Math.hypot(person.x - personStart.x, person.z - personStart.z);
      if (Math.hypot(robot.x - person.x, robot.z - person.z) <= 2.5 && robot.state === "idle" && i > 30) {
        robotReachedPerson = true;
      }
    }
  }

  assert.equal(outcomes.length, 1, "exactly one escort outcome should have been emitted");
  const outcome = outcomes[0];
  const person = state.agents.get("pickup-defect-visitor")!;
  const personToDestAtEnd = Math.hypot(person.x - destPoint!.x, person.z - destPoint!.z);
  console.log(`[evidence] escort outcome: ${JSON.stringify(outcome)}`);
  console.log(
    `[evidence] at release the person was ${personToDestAtEnd.toFixed(2)}m from the "Kitchen" they asked for ` +
      `(they started ${personToDestination.toFixed(2)}m away)`,
  );

  // THE regression assertion. Against the pre-fix code this reads 20.78m and fails; the escort
  // had reported "completed" while the person stood where they were picked up.
  if (outcome.outcome === "completed") {
    assert.ok(
      outcome.visitorDistanceToDestinationM !== null &&
        outcome.visitorDistanceToDestinationM <= DELIVERED_RADIUS_M,
      `an escort reported "completed" with the person still ${outcome.visitorDistanceToDestinationM?.toFixed(2)}m from ` +
        `the "Kitchen" they asked for (contract: <= ${DELIVERED_RADIUS_M.toFixed(1)}m) -- completion is being declared ` +
        "at the PICKUP point, not on delivery",
    );
    assert.ok(
      outcome.robotDistanceToDestinationM !== null &&
        outcome.robotDistanceToDestinationM <= DOOR_TOLERANCE_M,
      `an escort reported "completed" with the ROBOT still ${outcome.robotDistanceToDestinationM?.toFixed(2)}m from the ` +
        `destination (contract: <= ${DOOR_TOLERANCE_M.toFixed(1)}m) -- "robot is idle" is not "robot is at the destination"`,
    );
  }

  // The same claim restated against the LIVE agent, not just the reported record, so a future
  // change that reports honest numbers while releasing the person somewhere else is still caught.
  if (outcome.outcome === "completed") {
    assert.ok(
      personToDestAtEnd <= DELIVERED_RADIUS_M,
      `the person's live position at release should be at the destination (${personToDestAtEnd.toFixed(2)}m, ` +
        `contract <= ${DELIVERED_RADIUS_M.toFixed(1)}m)`,
    );
  } else {
    // Not delivered => the escort must say so. See this function's header for why the outcome
    // string itself is not pinned: on the current crowd tuning this geometry hits a separate,
    // pre-existing navigation jam in the doorway, and an honest "timed_out" is the correct
    // report for it.
    assert.equal(
      outcome.outcome,
      "timed_out",
      `an escort that did not deliver the person (${personToDestAtEnd.toFixed(2)}m from the destination) must be ` +
        `reported as a timeout, not as "${outcome.outcome}"`,
    );
    console.log(
      `[note] this escort did not deliver, and correctly reported "timed_out" after ` +
        `${outcome.durationSeconds.toFixed(1)}s in phase "${outcome.phase}" -- the pre-existing doorway jam ` +
        "described in this test's header, no longer masked by a false completion",
    );
  }

  // The two-phase fetch-then-lead behaviour must survive the fix, not be traded away for it.
  assert.ok(robotReachedPerson, "the robot should have gone to FETCH the person before leading them anywhere");
  assert.ok(
    personDriftWhileFetching < 1.5,
    `the person should wait in place while the robot fetches them (drifted ${personDriftWhileFetching.toFixed(2)}m)`,
  );

  console.log(
    `PASS: no completion was declared at the pickup point -- the escort ended "${outcome.outcome}" with the person ` +
      `${personToDestAtEnd.toFixed(2)}m from the "Kitchen" they asked for (fetch leg intact: the robot came to them, ` +
      `they waited ${personDriftWhileFetching.toFixed(2)}m in place)`,
  );

  room.onDispose();
}

async function main(): Promise<void> {
  await testEscortDoesNotCompleteAtThePickupPoint();
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
