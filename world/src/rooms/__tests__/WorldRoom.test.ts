/**
 * Integration test for Task 1.2's Detour Crowd loop wired into WorldRoom: creates a
 * WorldRoom directly (no live Colyseus server/transport needed -- onCreate() only
 * touches the room's own state/crowd, not the network layer), immediately cancels the
 * real setSimulationInterval timer onCreate() started so the test can drive simulated
 * time deterministically by calling `update(deltaMs)` directly instead of waiting on a
 * real wall-clock interval, then proves:
 *   1. the ms->seconds conversion + 0.1s clamp in update() is real: one huge deltaMs
 *      tick doesn't move the agent as if it were that many seconds of simulated time.
 *   2. moveAgentTo("Classroom 1425") makes the seeded test agent's synced schema
 *      position converge to within tolerance of that room's door.
 *   3. moveAgentTo reports failure (not a throw or silent no-op) for an unresolvable
 *      target.
 *   4. (Task 3.3) moveAgentTo populates the agent's synced `route` (flattened x,z pairs)
 *      with a real computePath polyline, and arrival (state settling to "idle") clears it.
 *
 * Run with: npx tsx src/rooms/__tests__/WorldRoom.test.ts
 */
import assert from "node:assert/strict";

import { WorldRoom } from "../WorldRoom.js";
import { loadFloorPlan } from "../../nav/loadFloorPlan.js";

const TEST_AGENT_ID = "test-robot-1";
const DOOR_TOLERANCE_M = 1.0;
const TICK_MS = 16.6;
const MAX_TICKS = 2000; // clamped to 0.1s/tick max -> up to 200s of simulated time

interface SyncedAgent {
  x: number;
  z: number;
  heading: number;
  state: string;
  route: { length: number; [index: number]: number };
}

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const room1425 = plan.rooms.find((r) => r.name === "Classroom 1425");
  assert.ok(room1425, "floor-14.json should contain 'Classroom 1425'");
  const [doorX, doorZ] = room1425.door;

  const room = new WorldRoom();
  // Task 4.1 wired a simulated-visitor spawner into onCreate()/update() that (by default)
  // competes for any idle robot -- this test has exactly one robot and cares about ITS
  // idle/route state precisely (e.g. "route clears once idle"), so the background
  // spawner grabbing that same robot for a different escort the instant it goes idle would
  // give it a fresh non-empty route out from under this test. Disabled here since this
  // test's scope (the Task 1.2/3.3 crowd loop + route line) is orthogonal to Task 4.1's
  // spawner; visitors.test.ts covers the spawner itself.
  await room.onCreate({ disableSimulatedVisitors: true });
  // Cancel the real setSimulationInterval timer onCreate() started -- this test advances
  // simulated time itself via update(), not a real wall-clock interval (see file header).
  room.setSimulationInterval();

  const state = room.state as unknown as { agents: Map<string, SyncedAgent> };

  const initialAgent = state.agents.get(TEST_AGENT_ID);
  assert.ok(initialAgent, "WorldRoom should seed one test agent on creation");
  assert.equal(initialAgent!.state, "idle", "freshly seeded agent should start idle");
  console.log("PASS: WorldRoom seeds one test agent on creation");

  // --- ms->seconds + 0.1s clamp: one giant deltaMs must NOT move the agent as if it
  // were that many seconds of simulated time. ---
  const beforeClampX = initialAgent!.x;
  const beforeClampZ = initialAgent!.z;
  const moveOk = room.moveAgentTo(TEST_AGENT_ID, "Classroom 1425");
  assert.ok(moveOk, 'moveAgentTo("Classroom 1425") should succeed (it is reachable per Task 1.1)');

  // --- Task 3.3: moveAgentTo should populate the synced `route` (flattened x,z pairs)
  // with a real computePath polyline for the client's route-line renderer. ---
  const routedAgent = state.agents.get(TEST_AGENT_ID)!;
  assert.ok(
    routedAgent.route.length >= 4 && routedAgent.route.length % 2 === 0,
    `moveAgentTo should populate route with >=2 flattened (x,z) points (even length); ` +
      `got length ${routedAgent.route.length}`,
  );
  const routeEndX = routedAgent.route[routedAgent.route.length - 2];
  const routeEndZ = routedAgent.route[routedAgent.route.length - 1];
  const routeEndDist = Math.hypot(routeEndX - doorX, routeEndZ - doorZ);
  assert.ok(
    routeEndDist <= DOOR_TOLERANCE_M,
    `route's last point (${routeEndX.toFixed(2)}, ${routeEndZ.toFixed(2)}) should land near ` +
      `Classroom 1425's door (${doorX}, ${doorZ}); distance was ${routeEndDist.toFixed(2)}m`,
  );
  console.log(
    `PASS: moveAgentTo("Classroom 1425") populated route with ${routedAgent.route.length / 2} points, ` +
      `ending ${routeEndDist.toFixed(2)}m from the door`,
  );

  room.update(5000); // 5000ms -- if ms->seconds were skipped this would be read as 5000s
  const afterClampAgent = state.agents.get(TEST_AGENT_ID)!;
  const clampDist = Math.hypot(afterClampAgent.x - beforeClampX, afterClampAgent.z - beforeClampZ);
  // Even at the agent's max speed (1.4 m/s) and the 0.1s clamp, one tick can cover at most
  // ~0.14m -- an unclamped 5s tick (or a raw-ms-as-seconds bug, ~7000m) would blow past this.
  assert.ok(
    clampDist < 0.5,
    `one update(5000) call moved the agent ${clampDist.toFixed(2)}m -- expected the 0.1s clamp ` +
      "to bound this to a small fraction of a meter (ms->seconds conversion or clamp is broken)",
  );
  console.log(
    `PASS: update(5000ms) moved the agent only ${clampDist.toFixed(4)}m, proving both the ` +
      "ms->seconds conversion and the 0.1s clamp are applied",
  );

  // --- convergence: repeated small ticks should walk the agent to the room's door ---
  let converged = false;
  let lastDist = Infinity;
  for (let i = 0; i < MAX_TICKS; i++) {
    room.update(TICK_MS);
    const agent = state.agents.get(TEST_AGENT_ID)!;
    lastDist = Math.hypot(agent.x - doorX, agent.z - doorZ);
    if (lastDist <= DOOR_TOLERANCE_M) {
      converged = true;
      break;
    }
  }

  assert.ok(
    converged,
    `agent did not converge within ${DOOR_TOLERANCE_M}m of Classroom 1425's door ` +
      `(${doorX}, ${doorZ}) after ${MAX_TICKS} ticks; last distance ${lastDist.toFixed(2)}m`,
  );
  console.log(
    `PASS: moveAgentTo("Classroom 1425") converged to within ${lastDist.toFixed(2)}m of the door`,
  );

  // Crossing DOOR_TOLERANCE_M doesn't mean the crowd agent has itself finished slowing to
  // a stop at its (tighter) internal arrival radius -- keep ticking a bounded extra
  // amount until the schema settles to "idle", proving update() doesn't leave it stuck
  // reporting "moving" forever once actually arrived.
  const MAX_SETTLE_TICKS = 300;
  let settledState = state.agents.get(TEST_AGENT_ID)!.state;
  for (let i = 0; i < MAX_SETTLE_TICKS && settledState !== "idle"; i++) {
    room.update(TICK_MS);
    settledState = state.agents.get(TEST_AGENT_ID)!.state;
  }
  assert.equal(settledState, "idle", 'agent schema state should settle to "idle" once arrived and stopped');
  console.log('PASS: agent schema state settles to "idle" once converged (not stuck on "moving")');

  // --- Task 3.3: arrival (state settling to "idle") should clear the synced `route`. ---
  const settledAgent = state.agents.get(TEST_AGENT_ID)!;
  assert.equal(settledAgent.route.length, 0, "route should be cleared once the agent settles to idle");
  console.log('PASS: route is cleared once the agent settles to "idle"');

  // --- unknown target: moveAgentTo should report failure, not throw or silently no-op ---
  const badResult = room.moveAgentTo(TEST_AGENT_ID, "this room does not exist");
  assert.equal(badResult, false, "moveAgentTo should return false for an unresolvable target");
  console.log("PASS: moveAgentTo returns false for an unknown room name");

  // --- Task 5.2: fleet-wide pause/resume -- a paused room's agent positions must stop
  // advancing across ticks (update() becomes a no-op), and resume() must restore
  // normal ticking. ---
  {
    assert.equal(room.isPaused, false, "room should start unpaused");

    // Send the agent back toward the entrance -- a point distinctly far from where it
    // settled (the Classroom 1425 door above), so pausing/resuming has real distance to
    // prove movement stopped/resumed against (re-targeting the same spot it already
    // converged to would barely move it either way, a weak test).
    const entranceTarget = { x: plan.entrance.point[0], z: plan.entrance.point[1] };
    const moveOk = room.moveAgentTo(TEST_AGENT_ID, entranceTarget);
    assert.ok(moveOk, "moveAgentTo(entrance) before the pause test should succeed");

    room.pause();
    assert.equal(room.isPaused, true, "pause() should set isPaused true");

    const pausedAgentBefore = state.agents.get(TEST_AGENT_ID)!;
    const frozenX = pausedAgentBefore.x;
    const frozenZ = pausedAgentBefore.z;
    const frozenState = pausedAgentBefore.state;
    const frozenRouteLen = pausedAgentBefore.route.length;

    // Many ticks -- if update() were not actually skipping the crowd/visitor tick while
    // paused, a real agent with a live move request would visibly walk during this.
    for (let i = 0; i < 60; i++) {
      room.update(TICK_MS);
    }

    const pausedAgentAfter = state.agents.get(TEST_AGENT_ID)!;
    assert.equal(pausedAgentAfter.x, frozenX, "agent x must not change while paused");
    assert.equal(pausedAgentAfter.z, frozenZ, "agent z must not change while paused");
    assert.equal(pausedAgentAfter.state, frozenState, "agent state must not change while paused");
    assert.equal(
      pausedAgentAfter.route.length,
      frozenRouteLen,
      "agent route must not change while paused",
    );
    console.log("PASS: pause() halts agent position/state/route advancement across many ticks");

    room.resume();
    assert.equal(room.isPaused, false, "resume() should set isPaused false");

    // After resume, ticking should be able to move the agent again -- walk it a bounded
    // number of ticks and confirm SOME movement happens (proves update() is no longer
    // a no-op, without re-testing full convergence, which the earlier block already did).
    let moved = false;
    for (let i = 0; i < 60; i++) {
      room.update(TICK_MS);
      const agent = state.agents.get(TEST_AGENT_ID)!;
      if (agent.x !== frozenX || agent.z !== frozenZ) {
        moved = true;
        break;
      }
    }
    assert.ok(moved, "resume() should restore normal ticking (agent should move again)");
    console.log("PASS: resume() restores normal tick advancement after a pause");
  }

  // --- onDispose: must free the WASM-backed crowd/navmesh/query without throwing, and be
  // safe to call more than once (Colyseus disposing a room twice would otherwise be a
  // native double-free, not a soft failure). ---
  assert.doesNotThrow(() => room.onDispose(), "onDispose() should not throw");
  assert.doesNotThrow(() => room.onDispose(), "onDispose() should be idempotent (safe to call twice)");
  console.log("PASS: onDispose() frees native resources without throwing and is idempotent");

  console.log("\nALL PASS: WorldRoom.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
