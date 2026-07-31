/**
 * Unit tests for AgentCrowd (world/src/nav/crowd.ts), the thin wrapper around
 * recast-navigation's Detour Crowd used by WorldRoom for Task 1.2's agent simulation
 * loop. Builds a real navmesh from floor-14.json (same as buildNavMesh.test.ts) so the
 * crowd is stepping through actual corridor geometry, not a synthetic stub.
 *
 * Also measures (not just asserts a loose ceiling on) `crowd.update`'s wall-clock cost
 * per tick with a single agent -- Task 1.2's acceptance bar requires reporting the real
 * measured number, not an assumption, for comparison against Task 1.3's ~95-agent load
 * test.
 *
 * Run with: npx tsx src/nav/__tests__/crowd.test.ts
 */
import assert from "node:assert/strict";

import { buildNavMesh } from "../buildNavMesh.js";
import { loadFloorPlan } from "../loadFloorPlan.js";
import { AgentCrowd } from "../crowd.js";
import type { AgentParams } from "../crowd.js";

const AGENT_PARAMS: AgentParams = {
  radius: 0.2,
  height: 1.8,
  maxAcceleration: 8,
  maxSpeed: 1.4,
  collisionQueryRange: 2.5,
  pathOptimizationRange: 0,
  separationWeight: 2,
};

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const { navMesh, findRoomTarget } = await buildNavMesh(plan);
  const start = { x: plan.entrance.point[0], y: 0, z: plan.entrance.point[1] };
  const door = findRoomTarget("Classroom 1425");
  assert.ok(door, "floor-14.json should contain a reachable 'Classroom 1425' door");

  // --- addAgent / requestMoveTarget / tick basic wiring ---
  {
    const crowd = new AgentCrowd(navMesh, { maxAgents: 8, maxAgentRadius: 0.5 });

    crowd.addAgent("a1", start, AGENT_PARAMS);
    assert.ok(crowd.has("a1"), "addAgent should register the agent under its string id");

    assert.throws(
      () => crowd.addAgent("a1", start, AGENT_PARAMS),
      /already exists/,
      "addAgent should refuse to silently reuse a string id already in the crowd",
    );

    const requested = crowd.requestMoveTarget("a1", { x: door.x, y: 0, z: door.z });
    assert.ok(requested, "requestMoveTarget should succeed for a reachable room door");

    assert.equal(
      crowd.requestMoveTarget("no-such-agent", { x: 0, y: 0, z: 0 }),
      false,
      "requestMoveTarget should return false for an unknown agent id",
    );

    const [snap] = crowd.tick(1 / 60);
    assert.equal(snap.id, "a1", "tick() should report a snapshot keyed by the caller's string id");
    assert.equal(typeof snap.x, "number");
    assert.equal(typeof snap.z, "number");
    assert.equal(typeof snap.heading, "number");
    assert.equal(typeof snap.speed, "number");

    crowd.removeAgent("a1");
    assert.equal(crowd.has("a1"), false, "removeAgent should untrack the agent");
    assert.equal(crowd.tick(1 / 60).length, 0, "tick() should report nothing once the only agent is removed");

    console.log("PASS: addAgent/requestMoveTarget/tick/removeAgent basic wiring");
    crowd.destroy();
  }

  // --- movement: requesting a reachable target should actually move the agent over ticks ---
  {
    const crowd = new AgentCrowd(navMesh, { maxAgents: 8, maxAgentRadius: 0.5 });
    crowd.addAgent("a1", start, AGENT_PARAMS);
    crowd.requestMoveTarget("a1", { x: door.x, y: 0, z: door.z });

    for (let i = 0; i < 120; i++) crowd.tick(1 / 60);
    const [after] = crowd.tick(1 / 60);

    const moved = Math.hypot(after.x - start.x, after.z - start.z);
    assert.ok(moved > 0.5, `agent should have made real progress toward the door after ~2s (moved ${moved.toFixed(2)}m)`);
    console.log(`PASS: agent moved ${moved.toFixed(2)}m toward "Classroom 1425" over ~2s of ticks`);
    crowd.destroy();
  }

  // --- capacity guard: recast-navigation's Crowd.addAgent does NOT throw at capacity --
  // verified empirically that it silently hands back a CrowdAgent wrapping an invalid
  // agentIndex (-1) instead. AgentCrowd.addAgent must detect that and refuse to track
  // the ghost agent (returning false), rather than trusting it and corrupting byId. ---
  {
    const MAX = 3;
    const crowd = new AgentCrowd(navMesh, { maxAgents: MAX, maxAgentRadius: 0.5 });

    for (let i = 0; i < MAX; i++) {
      const ok = crowd.addAgent(`fill-${i}`, { x: start.x + i * 0.1, y: 0, z: start.z }, AGENT_PARAMS);
      assert.ok(ok, `addAgent should succeed for agent ${i} of ${MAX} (under maxAgents)`);
    }

    let threw = false;
    let overflowOk = true;
    try {
      overflowOk = crowd.addAgent("overflow", { x: start.x + 99, y: 0, z: start.z }, AGENT_PARAMS);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "addAgent at maxAgents must not throw");
    assert.equal(overflowOk, false, "addAgent should return false once the crowd is at maxAgents");
    assert.equal(crowd.has("overflow"), false, "the refused agent must not be tracked");

    // Existing agents must be completely unaffected -- a tick should behave exactly as it
    // would have without the overflow attempt (no throw, all MAX agents still reported).
    const snapshots = crowd.tick(1 / 60);
    assert.equal(snapshots.length, MAX, "tick() should still report exactly the MAX tracked agents, no ghost entry");
    for (let i = 0; i < MAX; i++) {
      assert.ok(crowd.has(`fill-${i}`), `agent fill-${i} should still be tracked after the refused overflow add`);
    }

    console.log(
      `PASS: AgentCrowd.addAgent refuses cleanly (no throw, returns false, no ghost tracked) once at maxAgents (${MAX})`,
    );
    crowd.destroy();
  }

  // --- measured crowd.update wall-clock time per tick, 1 agent ---
  {
    const crowd = new AgentCrowd(navMesh, { maxAgents: 8, maxAgentRadius: 0.5 });
    crowd.addAgent("a1", start, AGENT_PARAMS);
    crowd.requestMoveTarget("a1", { x: door.x, y: 0, z: door.z });

    const WARMUP = 60;
    const SAMPLE = 2000;
    for (let i = 0; i < WARMUP; i++) crowd.tick(1 / 60);

    const startNs = process.hrtime.bigint();
    for (let i = 0; i < SAMPLE; i++) crowd.tick(1 / 60);
    const endNs = process.hrtime.bigint();

    const totalMs = Number(endNs - startNs) / 1e6;
    const perTickMs = totalMs / SAMPLE;
    console.log(
      `MEASURED: crowd.update per-tick wall-clock time with 1 agent: ${perTickMs.toFixed(4)}ms ` +
        `(${SAMPLE} ticks, ${totalMs.toFixed(2)}ms total)`,
    );
    // Generous sanity ceiling, not a perf budget -- just to catch a gross regression
    // (e.g. accidentally rebuilding the crowd or re-querying the navmesh every tick).
    assert.ok(perTickMs < 5, `crowd.update per tick (${perTickMs.toFixed(4)}ms) unexpectedly slow`);
    crowd.destroy();
  }

  console.log("\nALL PASS: crowd.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
