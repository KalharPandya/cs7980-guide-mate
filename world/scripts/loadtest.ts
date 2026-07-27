/**
 * Task 1.3: ~95-agent crowd-simulation load test.
 *
 * Spins up a single AgentCrowd (world/src/nav/crowd.ts -- the same Detour Crowd wrapper
 * WorldRoom.ts uses for Task 1.2's real simulation loop) with 95 tracked agents added
 * directly via the AgentCrowd API -- NOT via 95 real WebSocket/Colyseus clients, since
 * this measures the simulation/nav cost alone, not the socket layer. 95 matches the
 * Phase 4 target headcount (50 robots + 45 visitors).
 *
 * Each agent spawns at a random point drawn from the navmesh itself
 * (`NavMeshQuery.findRandomPoint()`, so it's provably ON the mesh -- an agent seeded off
 * the navmesh wouldn't move and would silently skew the result) and is given a target
 * room door to walk to via `requestMoveTarget`, cycling through all 18 rooms + the
 * entrance (the same 19 points WorldRoom.moveAgentTo can resolve a client-requested move
 * to via `findRoomTarget`).
 *
 * Measures ONLY the `AgentCrowd.tick()` call (crowd.update() + snapshot collection --
 * the same thing crowd.test.ts's 1-agent baseline measured, so the two numbers are
 * comparable) with `process.hrtime.bigint()`, across multiple independent runs (fresh
 * crowd + fresh 95 agents each run, sharing one built navmesh), and reports min/avg/max
 * per-tick wall-clock time plus how many ticks exceeded the 16.6ms 60Hz frame budget.
 * Also reports how many agents actually reached/were moving vs stuck after the measured
 * ticks, as a sanity check that this is measuring real crowd steering/avoidance work and
 * not 95 no-op agents.
 *
 * Run with: npx tsx scripts/loadtest.ts
 */
import assert from "node:assert/strict";
import type { NavMesh, NavMeshQuery } from "recast-navigation";

import { buildNavMesh } from "../src/nav/buildNavMesh.js";
import type { RoomTarget } from "../src/nav/buildNavMesh.js";
import { loadFloorPlan } from "../src/nav/loadFloorPlan.js";
import { AgentCrowd } from "../src/nav/crowd.js";
import type { AgentParams, AgentSnapshot } from "../src/nav/crowd.js";
import { AGENT_HEIGHT_M, AGENT_RADIUS_M } from "../src/nav/agentProfile.js";

const AGENT_COUNT = 95; // 50 robots + 45 visitors, the Phase 4 target fleet size
const MAX_AGENTS = 128; // matches WorldRoom.ts's Crowd capacity
const MAX_AGENT_RADIUS_M = 0.5; // matches WorldRoom.ts

/** Same movement tuning as WorldRoom.ts's DEFAULT_AGENT_PARAMS -- a load test that used
 * looser/tighter steering than production would measure the wrong workload. */
const AGENT_PARAMS: AgentParams = {
  radius: AGENT_RADIUS_M,
  height: AGENT_HEIGHT_M,
  maxAcceleration: 8,
  maxSpeed: 1.4,
  collisionQueryRange: 2.5,
  pathOptimizationRange: 0,
  separationWeight: 2,
};

const WARMUP_TICKS = 60;
const SAMPLE_TICKS = 1500;
const DT_SECONDS = 1 / 60;
const FRAME_BUDGET_MS = 16.6; // 60fps server-tick budget this task is checking against
const RUNS = 5; // "prove it on ~5 samples" -- report the spread, not one lucky run

/** Sanity-check thresholds for classifying each agent after the measured ticks. */
const REACHED_TOLERANCE_M = 1.0; // matches WorldRoom.test.ts's DOOR_TOLERANCE_M
const MOVED_TOLERANCE_M = 0.3; // "did real crowd/steering work happen" bar

interface SeededAgent {
  id: string;
  spawn: { x: number; z: number };
  target: RoomTarget;
  moveRequested: boolean;
}

interface RunResult {
  runLabel: string;
  minMs: number;
  avgMs: number;
  maxMs: number;
  overBudgetTicks: number;
  moveFailures: number;
  spawnFallbacks: number;
  movedCount: number;
  reachedCount: number;
  stuckCount: number;
}

/**
 * Seeds AGENT_COUNT agents into a fresh AgentCrowd built on `navMesh`, runs the warmup +
 * measured ticks, and reports the timing + sanity-check counts. The crowd is created and
 * destroyed entirely within this call so each run starts from a clean 0-agent crowd.
 */
function runOnce(
  navMesh: NavMesh,
  navMeshQuery: NavMeshQuery,
  targets: RoomTarget[],
  runLabel: string,
): RunResult {
  const crowd = new AgentCrowd(navMesh, { maxAgents: MAX_AGENTS, maxAgentRadius: MAX_AGENT_RADIUS_M });

  const agents: SeededAgent[] = [];
  let spawnFallbacks = 0;

  for (let i = 0; i < AGENT_COUNT; i++) {
    const id = `agent-${i}`;

    // Spawn at a random point drawn directly from the navmesh -- provably walkable, not
    // an arbitrary/guessed coordinate that might land off-mesh.
    const randomPoint = navMeshQuery.findRandomPoint();
    let spawn: { x: number; z: number };
    if (randomPoint.success) {
      spawn = { x: randomPoint.randomPoint.x, z: randomPoint.randomPoint.z };
    } else {
      // Vanishingly unlikely on this floor plan, but fall back to a known-good room
      // door rather than skipping the agent, and count it so it's visible in the report.
      spawnFallbacks++;
      const fallback = targets[i % targets.length];
      spawn = { x: fallback.x, z: fallback.z };
    }

    crowd.addAgent(id, { x: spawn.x, y: 0, z: spawn.z }, AGENT_PARAMS);

    // Offset by 1 so an agent essentially never gets assigned the room door it just
    // spawned next to (which would end the "move" instantly instead of exercising
    // pathing/steering across the floor for the whole measured window).
    const target = targets[(i + 1) % targets.length];
    const moveRequested = crowd.requestMoveTarget(id, { x: target.x, y: 0, z: target.z });

    agents.push({ id, spawn, target, moveRequested });
  }

  assert.equal(agents.length, AGENT_COUNT, `should have seeded exactly ${AGENT_COUNT} agents`);
  const moveFailures = agents.filter((a) => !a.moveRequested).length;

  for (let i = 0; i < WARMUP_TICKS; i++) crowd.tick(DT_SECONDS);

  const tickTimesMs: number[] = new Array(SAMPLE_TICKS);
  let lastSnapshots: AgentSnapshot[] = [];
  for (let i = 0; i < SAMPLE_TICKS; i++) {
    const startNs = process.hrtime.bigint();
    lastSnapshots = crowd.tick(DT_SECONDS);
    const endNs = process.hrtime.bigint();
    tickTimesMs[i] = Number(endNs - startNs) / 1e6;
  }

  assert.equal(lastSnapshots.length, AGENT_COUNT, "tick() should report a snapshot for every seeded agent");

  const snapshotById = new Map(lastSnapshots.map((s) => [s.id, s]));
  let movedCount = 0;
  let reachedCount = 0;
  let stuckCount = 0;
  for (const a of agents) {
    const snap = snapshotById.get(a.id);
    if (!snap) continue;
    const moved = Math.hypot(snap.x - a.spawn.x, snap.z - a.spawn.z);
    const distToTarget = Math.hypot(snap.x - a.target.x, snap.z - a.target.z);
    if (distToTarget <= REACHED_TOLERANCE_M) reachedCount++;
    else if (moved >= MOVED_TOLERANCE_M) movedCount++;
    else stuckCount++;
  }

  let minMs = Infinity;
  let maxMs = -Infinity;
  let sumMs = 0;
  let overBudgetTicks = 0;
  for (const t of tickTimesMs) {
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
    sumMs += t;
    if (t > FRAME_BUDGET_MS) overBudgetTicks++;
  }
  const avgMs = sumMs / tickTimesMs.length;

  crowd.destroy();

  return {
    runLabel,
    minMs,
    avgMs,
    maxMs,
    overBudgetTicks,
    moveFailures,
    spawnFallbacks,
    movedCount,
    reachedCount,
    stuckCount,
  };
}

function logResult(r: RunResult): void {
  console.log(
    `[${r.runLabel}] tick ms: min=${r.minMs.toFixed(4)} avg=${r.avgMs.toFixed(4)} max=${r.maxMs.toFixed(4)} | ` +
      `overBudget(>${FRAME_BUDGET_MS}ms)=${r.overBudgetTicks}/${SAMPLE_TICKS} | ` +
      `moveRequestFailures=${r.moveFailures}/${AGENT_COUNT} spawnFallbacks=${r.spawnFallbacks} | ` +
      `reached=${r.reachedCount} moving=${r.movedCount} stuck=${r.stuckCount} (of ${AGENT_COUNT})`,
  );
}

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const nav = await buildNavMesh(plan);

  // All 18 room doors + the entrance, snapped onto the navmesh -- the full set of points
  // WorldRoom.moveAgentTo can resolve a move request to.
  const targets: RoomTarget[] = [];
  for (const room of plan.rooms) {
    const t = nav.findRoomTarget(room.name);
    assert.ok(t, `floor-14.json room "${room.name}" should resolve to a navmesh target`);
    targets.push(t as RoomTarget);
  }
  const entranceSnap = nav.navMeshQuery.findClosestPoint({
    x: plan.entrance.point[0],
    y: 0,
    z: plan.entrance.point[1],
  });
  assert.ok(entranceSnap.success, "entrance point should snap onto the navmesh");
  targets.push({ x: entranceSnap.point.x, z: entranceSnap.point.z });

  assert.equal(
    targets.length,
    plan.rooms.length + 1,
    "targets should cover every room plus the entrance",
  );
  console.log(
    `Loaded navmesh with ${targets.length} candidate targets (${plan.rooms.length} rooms + entrance)`,
  );
  console.log(
    `Plan: ${AGENT_COUNT} agents, ${WARMUP_TICKS} warmup ticks (unmeasured), ` +
      `${SAMPLE_TICKS} measured ticks/run, ${RUNS} runs, dt=${DT_SECONDS.toFixed(5)}s, ` +
      `frame budget=${FRAME_BUDGET_MS}ms\n`,
  );

  const results: RunResult[] = [];
  for (let r = 0; r < RUNS; r++) {
    const result = runOnce(nav.navMesh, nav.navMeshQuery, targets, `run-${r + 1}/${RUNS}`);
    logResult(result);
    results.push(result);
  }

  const overallMin = Math.min(...results.map((r) => r.minMs));
  const overallMax = Math.max(...results.map((r) => r.maxMs));
  const overallAvgOfAvgs = results.reduce((s, r) => s + r.avgMs, 0) / results.length;
  const totalOverBudget = results.reduce((s, r) => s + r.overBudgetTicks, 0);
  const totalTicks = RUNS * SAMPLE_TICKS;
  const totalMoveFailures = results.reduce((s, r) => s + r.moveFailures, 0);
  const totalReached = results.reduce((s, r) => s + r.reachedCount, 0);
  const totalMoving = results.reduce((s, r) => s + r.movedCount, 0);
  const totalStuck = results.reduce((s, r) => s + r.stuckCount, 0);

  console.log(
    `\n=== SUMMARY: ${AGENT_COUNT} agents, ${RUNS} runs x ${SAMPLE_TICKS} measured ticks ` +
      `(${totalTicks} ticks total) ===`,
  );
  console.log(
    `tick ms across all runs: min=${overallMin.toFixed(4)} avg(of per-run avgs)=${overallAvgOfAvgs.toFixed(4)} ` +
      `max=${overallMax.toFixed(4)}`,
  );
  console.log(
    `over the ${FRAME_BUDGET_MS}ms 60fps budget: ${totalOverBudget}/${totalTicks} ticks ` +
      `(${((totalOverBudget / totalTicks) * 100).toFixed(2)}%)`,
  );
  console.log(
    `moveRequest failures: ${totalMoveFailures}/${RUNS * AGENT_COUNT} | ` +
      `agent outcomes across all runs -- reached=${totalReached} moving=${totalMoving} stuck=${totalStuck} ` +
      `(of ${RUNS * AGENT_COUNT})`,
  );

  nav.navMeshQuery.destroy();
  nav.navMesh.destroy();

  console.log("\nDONE: loadtest.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
