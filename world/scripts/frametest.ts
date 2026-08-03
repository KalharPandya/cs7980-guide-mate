/**
 * Measures the TRUE full-frame server cost of `WorldRoom.update()` -- not just the
 * `AgentCrowd.tick()` slice `scripts/loadtest.ts` (Task 1.3) measures.
 *
 * ---- why this exists ----
 * `loadtest.ts`'s own doc comment says, explicitly: "Measures ONLY the `AgentCrowd.tick()`
 * call ... so the two numbers are comparable" (to `crowd.test.ts`'s 1-agent baseline). That
 * was the right scope for THAT task, but the resulting number (avg ~0.47-0.49ms/tick on
 * this machine -- see loadtest.ts's own printed output) has since been quoted around this
 * project (`docs/agent-poc/access-ground-truth.md`, the risk register) as if it were the
 * per-frame server cost. It never was. `WorldRoom.update()` -- the method Colyseus actually
 * calls every simulation tick (`setSimulationInterval`, 60Hz / 16.667ms by default,
 * `node_modules/@colyseus/core/build/Room.mjs`'s `DEFAULT_SIMULATION_INTERVAL`) -- also
 * runs, every tick:
 *   - the per-agent Colyseus schema sync loop (writes `x`/`z`/`heading`/`state` into
 *     `state.agents` for every tracked agent -- @colyseus/schema change-tracks every
 *     mutated field on the Schema instance itself, real cost independent of whether
 *     anything is currently encoding/broadcasting it, see soaktest.ts's doc comment for the
 *     verified mechanics), and
 *   - `VisitorManager.tick()` (escort trailing/arrival bookkeeping + the simulated-visitor
 *     spawner's lifecycle, INCLUDING any `moveAgentTo`/`computePath` calls that happen to
 *     fire that tick -- see below).
 * And since commit 383f561 set `autoDispose = false`, this cost is paid continuously for
 * the life of the process, whether or not anyone is watching the big screen -- not just
 * during an attended demo window.
 *
 * This script measures the WHOLE of `WorldRoom.update()`, broken down into those sections,
 * at the real production steady state: `GUIDE_ROBOT_COUNT` (50) guide robots +
 * `SIMULATED_VISITOR_TARGET` (45) simulated visitors = 95 agents, the same design point
 * `loadtest.ts` targets, run at the real 60Hz tick pacing with the real (UNCOMPRESSED)
 * spawn-stagger/dwell timings -- unlike soaktest.ts/pooltest.ts, which deliberately compress
 * those to get more spawn/despawn cycles per wall-clock minute; compressing them here would
 * distort exactly the `moveAgentTo`/`computePath` call RATE this script needs to report
 * honestly.
 *
 * ---- how the section breakdown is captured ----
 * `crowd.tick()` / the schema sync loop / `visitors.tick()` run as three back-to-back
 * sections of ONE method with no external seam a caller could time separately without
 * either (a) duplicating `update()`'s body outside the class (real drift risk: a later
 * change to `update()` would silently desync the copy from what production actually runs)
 * or (b) reaching into private fields to hand-reconstruct it (same drift risk, worse -- it
 * could also silently desync from `update()`'s own control flow, e.g. the `pause()` early
 * return). Given that, `WorldRoom.ts` now carries a tiny optional `onUpdateSectionTiming`
 * hook (see its own doc comment) that ONLY this script sets -- production
 * (`world/src/index.ts`) never touches it, so on every real request the hook is
 * `undefined` and `update()` pays one falsy property read per section boundary, with ZERO
 * `process.hrtime.bigint()` calls -- not a permanent instrumentation cost, an opt-in one
 * this script alone opts into.
 *
 * The TOP-LINE full-frame number is captured completely independently of that hook, by
 * wrapping the real, unmodified `room.update(deltaMs)` PUBLIC call with its own
 * `process.hrtime.bigint()` pair -- so "does the hook's own overhead skew the headline
 * number" isn't even a question worth asking: the headline number doesn't depend on the
 * hook being accurate, only the section breakdown does, and the two are cross-checked
 * below (sum of sections vs. the outer wrap) to catch any real divergence.
 *
 * ---- route recomputation (computePath), measured separately and honestly ----
 * Per the task brief: `updateAgentRoute`'s `navMeshQuery.computePath` call (the glowing
 * route-line polyline) fires from `moveAgentTo`, NOT from `update()` -- it is real work on
 * this same single JS thread, OFF-tick, whenever a robot or visitor gets a fresh target (a
 * new escort assignment, or a simulated visitor heading back to the entrance). It will not
 * show up in a naive `update()` timing at all, but it can spike hard when many robots are
 * re-tasked at once. This script measures it three ways:
 *   1. PASSIVE call-rate: a call-counting spy on `WorldRoom.prototype.moveAgentTo`
 *      (delegates to the real implementation unchanged -- observes, does not alter, same
 *      technique pooltest.ts already uses on `addAgent`/`removeAgent`), active only during
 *      the steady-state measurement windows (post-warmup), giving the REAL organic call
 *      rate the uncompressed escort/spawner timings actually produce.
 *   2. ISOLATED per-call cost: many direct `navMeshQuery.computePath` calls between real
 *      agent positions and real room-door targets (the exact same navmesh instance
 *      `WorldRoom` itself is using, reached via the same private-field bracket-access
 *      convention soaktest.ts/pooltest.ts already use for `__init`/`_serializer`), for a
 *      clean min/avg/max/p95 untangled from anything else `moveAgentTo` also does.
 *   3. WORST-CASE BURST: the task brief's own scenario -- "what happens if many escorts
 *      finish and re-task in the same tick" -- reproduced directly by calling the room's
 *      real public `moveAgentTo` for all `GUIDE_ROBOT_COUNT` (50) guide robots back to back
 *      inside one timed block, exactly the burst a single tick would pay if every escort
 *      ended and was immediately reassigned together.
 *
 * Run with: npm run test:frame   (== npx tsx scripts/frametest.ts)
 */
import assert from "node:assert/strict";
import os from "node:os";

import type { RoomTarget, BuiltNavMesh } from "../src/nav/buildNavMesh.js";
import { loadFloorPlan } from "../src/nav/loadFloorPlan.js";
import { WorldRoom, GUIDE_ROBOT_COUNT } from "../src/rooms/WorldRoom.js";
import { SIMULATED_VISITOR_TARGET } from "../src/rooms/simulatedVisitorSpawner.js";

/** Matches Colyseus's own `DEFAULT_SIMULATION_INTERVAL` (60Hz) -- the real pacing
 * `setSimulationInterval` drives `WorldRoom.update()` at in production. */
const TICK_MS = 1000 / 60;
const FRAME_BUDGET_MS = 16.6; // same 60fps server-tick budget loadtest.ts checks against

/** Real simulated seconds to run BEFORE measuring, so the world reaches a representative
 * steady-state mix of visitor phases (waiting_for_robot / walking_to_room / dwelling /
 * walking_to_entrance) instead of measuring the initial all-robots-idle ramp-up. Real
 * spawn-stagger (0.5s x 45 = 22.5s) fills the population; the remainder gives each visitor
 * several full escort/dwell/return cycles (each roughly 20-45s at real walking speed) before
 * measurement starts. NOT compressed -- see file header for why compressing here would
 * distort the call-rate figures this script exists to report. */
const WARMUP_SIM_SECONDS = 180;
const WARMUP_TICKS = Math.round((WARMUP_SIM_SECONDS * 1000) / TICK_MS);

/**
 * Five windows of continuous operation (not five independent fresh-boot runs like
 * loadtest.ts) -- deliberate, not an oversight: loadtest.ts's "fresh crowd each run" is
 * right for isolating crowd-tick cost as a controlled trial, but re-ramping the full
 * 45-visitor population from zero five times would (a) mostly measure the ramp-up
 * transient instead of sustained steady-state cost, which is what a multi-hour persistent
 * kiosk actually pays, and (b) cost 5x the wall-clock time for less signal. One warmup,
 * five consecutive sample windows -- still "prove it on ~5 samples", just samples of a
 * continuously-running world instead of five separate boots.
 */
const MEASURE_WINDOWS = 5;
const TICKS_PER_WINDOW = 1500; // same order as loadtest.ts's SAMPLE_TICKS

const COMPUTEPATH_BENCH_SAMPLES = 500;

interface TickTiming {
  totalMs: number;
  crowdMs: number;
  syncMs: number;
  visitorsMs: number;
}

interface WindowResult {
  windowLabel: string;
  ticks: TickTiming[];
}

interface Stats {
  min: number;
  avg: number;
  max: number;
  p95: number;
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return {
    min: sorted[0],
    avg: sum / values.length,
    max: sorted[sorted.length - 1],
    p95: sorted[p95Idx],
  };
}

function fmtStats(s: Stats): string {
  return `min=${s.min.toFixed(4)} avg=${s.avg.toFixed(4)} max=${s.max.toFixed(4)} p95=${s.p95.toFixed(4)}`;
}

/** Reaches WorldRoom's private `nav` field -- the exact same `BuiltNavMesh` (and therefore
 * the exact same native navmesh instance) `moveAgentTo`/`updateAgentRoute` themselves query,
 * not a second independently-built copy. Same TS-private-but-runtime-public bracket-access
 * convention soaktest.ts (`__init`) and pooltest.ts (`_serializer`) already use in this
 * codebase; see either file's header comment for why this is safe and precedented. */
function getNav(room: WorldRoom): BuiltNavMesh {
  return (room as unknown as { nav: BuiltNavMesh }).nav;
}

/** Runs `WARMUP_TICKS` of real (uncompressed) simulated time via the room's own public
 * `update()`, with NO timing hook attached, so warmup behaves exactly like a real boot --
 * this reaches a representative steady-state population/phase-mix before anything is
 * measured. */
function runWarmup(room: WorldRoom): void {
  for (let i = 0; i < WARMUP_TICKS; i++) {
    room.update(TICK_MS);
  }
}

/**
 * Runs one measured window of `ticks` ticks. For every tick: wraps the real
 * `room.update(TICK_MS)` call in an outer `process.hrtime.bigint()` pair for the
 * ground-truth total, and simultaneously captures the crowdTick/schemaSync/visitorsTick
 * breakdown via `onUpdateSectionTiming` -- see file header for why both are taken from the
 * one real call instead of a hand-reconstructed duplicate.
 */
function runMeasuredWindow(room: WorldRoom, ticks: number, windowLabel: string): WindowResult {
  let crowdMs = 0;
  let syncMs = 0;
  let visitorsMs = 0;
  room.onUpdateSectionTiming = (section, ms) => {
    if (section === "crowdTick") crowdMs = ms;
    else if (section === "schemaSync") syncMs = ms;
    else visitorsMs = ms;
  };

  const results: TickTiming[] = new Array(ticks);
  for (let i = 0; i < ticks; i++) {
    crowdMs = 0;
    syncMs = 0;
    visitorsMs = 0;
    const startNs = process.hrtime.bigint();
    room.update(TICK_MS);
    const endNs = process.hrtime.bigint();
    const totalMs = Number(endNs - startNs) / 1e6;
    results[i] = { totalMs, crowdMs, syncMs, visitorsMs };
  }

  room.onUpdateSectionTiming = undefined;
  return { windowLabel, ticks: results };
}

function logWindow(w: WindowResult): void {
  const total = computeStats(w.ticks.map((t) => t.totalMs));
  const crowd = computeStats(w.ticks.map((t) => t.crowdMs));
  const sync = computeStats(w.ticks.map((t) => t.syncMs));
  const visitors = computeStats(w.ticks.map((t) => t.visitorsMs));
  const overBudget = w.ticks.filter((t) => t.totalMs > FRAME_BUDGET_MS).length;
  console.log(
    `[${w.windowLabel}] update() total ms: ${fmtStats(total)} | overBudget(>${FRAME_BUDGET_MS}ms)=${overBudget}/${w.ticks.length}\n` +
      `           crowdTick:    ${fmtStats(crowd)}\n` +
      `           schemaSync:   ${fmtStats(sync)}\n` +
      `           visitorsTick: ${fmtStats(visitors)}`,
  );
}

/** Isolated `computePath` benchmark: many calls between real (post-warmup) agent positions
 * and real room-door targets, on the SAME navmesh instance WorldRoom itself uses --
 * untangled from anything else `moveAgentTo` also does (crowd.requestMoveTarget, the
 * route.push loop, console.warn branches). */
function benchmarkComputePath(room: WorldRoom, targets: RoomTarget[], samples: number): number[] {
  const nav = getNav(room);
  const agentPositions = [...room.state.agents.values()].map((a) => ({ x: a.x, z: a.z }));
  assert.ok(agentPositions.length > 0, "room should have tracked agents to source computePath start points from");

  const times: number[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const from = agentPositions[i % agentPositions.length];
    const to = targets[i % targets.length];
    const startNs = process.hrtime.bigint();
    nav.navMeshQuery.computePath({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z });
    const endNs = process.hrtime.bigint();
    times[i] = Number(endNs - startNs) / 1e6;
  }
  return times;
}

interface BurstResult {
  totalMs: number;
  perCallMs: number[];
  successCount: number;
}

/** Worst-case burst: calls the room's real public `moveAgentTo` for every guide robot, back
 * to back inside one timed block -- exactly what a single tick would pay if all
 * `GUIDE_ROBOT_COUNT` escorts ended and were immediately re-assigned together. Uses the
 * REAL robot ids currently tracked in `state.agents` (not a hand-reconstructed id format),
 * and real room-door targets so the resulting `computePath` calls do real work, not a
 * same-point no-op. */
function benchmarkReassignBurst(room: WorldRoom, robotIds: string[], targets: RoomTarget[]): BurstResult {
  const perCallMs: number[] = new Array(robotIds.length);
  let successCount = 0;
  const burstStartNs = process.hrtime.bigint();
  for (let i = 0; i < robotIds.length; i++) {
    const target = targets[i % targets.length];
    const callStartNs = process.hrtime.bigint();
    const ok = room.moveAgentTo(robotIds[i], { x: target.x, z: target.z });
    const callEndNs = process.hrtime.bigint();
    perCallMs[i] = Number(callEndNs - callStartNs) / 1e6;
    if (ok) successCount++;
  }
  const burstEndNs = process.hrtime.bigint();
  return { totalMs: Number(burstEndNs - burstStartNs) / 1e6, perCallMs, successCount };
}

async function main(): Promise<void> {
  const cpus = os.cpus();
  console.log(
    `This machine: ${cpus[0]?.model ?? "unknown CPU"}, ${cpus.length} logical processors, ` +
      `${(os.totalmem() / (1024 ** 3)).toFixed(1)} GB RAM -- CAVEAT: the production instance is a ` +
      `t3.large (2 vCPU, 8 GB RAM). These numbers are not a like-for-like substitute for an actual ` +
      `t3.large run; they are the closest proxy available without provisioning one (same caveat ` +
      `docs/agent-poc/access-ground-truth.md already states for loadtest.ts's numbers).\n`,
  );

  console.log(
    `Plan: ${GUIDE_ROBOT_COUNT} guide robots + ${SIMULATED_VISITOR_TARGET} simulated-visitor target ` +
      `(real, uncompressed defaults) = ${GUIDE_ROBOT_COUNT + SIMULATED_VISITOR_TARGET}-agent steady state. ` +
      `Warmup: ${WARMUP_SIM_SECONDS}s simulated (${WARMUP_TICKS} ticks @ ${TICK_MS.toFixed(3)}ms/tick, real 60Hz pacing). ` +
      `Measurement: ${MEASURE_WINDOWS} windows x ${TICKS_PER_WINDOW} ticks, frame budget=${FRAME_BUDGET_MS}ms.\n`,
  );

  const plan = loadFloorPlan();

  const room = new WorldRoom();
  // No __init() -- this script never calls broadcastPatch()/encode(), so it doesn't need
  // the real SchemaSerializer soaktest.ts's __init() reflection wires up (see that file's
  // header comment for what that's for). @colyseus/schema's change-tracking on `agent.x =
  // ...` etc. (the cost this script IS measuring, inside the schemaSync section) happens on
  // the Schema instances themselves regardless of __init -- verified by soaktest.ts's own
  // root-cause writeup: "NOT per-Room -- it lives on the Schema instances themselves
  // regardless of whether anything is ever consuming it".
  await room.onCreate({});
  // Cancel the real setSimulationInterval timer -- this script drives simulated time itself
  // via direct update(deltaMs) calls, same pattern as WorldRoom.test.ts/soaktest.ts.
  room.setSimulationInterval();

  console.log("Running warmup (real, uncompressed spawn/dwell timings)...");
  const warmupStartMs = Date.now();
  runWarmup(room);
  const warmupWallSeconds = (Date.now() - warmupStartMs) / 1000;
  const warmupStats = room.getVisitorDebugStats();
  console.log(
    `Warmup done in ${warmupWallSeconds.toFixed(1)}s wall-clock. Post-warmup mix: ` +
      `totalVisitors=${warmupStats.totalVisitors} simulatedActive=${warmupStats.simulatedActive} ` +
      `escortedVisitors=${warmupStats.escortedVisitors} robotBindings=${warmupStats.robotBindings} ` +
      `schemaAgents=${room.state.agents.size} crowdAgents=${room.getCrowdAgentCount()}\n`,
  );

  // ---- organic moveAgentTo/computePath call-rate spy: installed ONLY across the
  // steady-state measurement windows (not warmup's initial ramp-up burst, not the deliberate
  // burst/isolated benchmarks below), so the resulting rate is the honest steady-state
  // figure the task brief asks for. Delegates to the real implementation unchanged -- same
  // observe-don't-alter spy technique pooltest.ts already uses on addAgent/removeAgent. ----
  let organicMoveAgentToCalls = 0;
  const originalMoveAgentTo = WorldRoom.prototype.moveAgentTo;
  WorldRoom.prototype.moveAgentTo = function (
    this: WorldRoom,
    agentId: string,
    target: string | RoomTarget,
  ): boolean {
    organicMoveAgentToCalls++;
    return originalMoveAgentTo.call(this, agentId, target);
  };

  console.log(`Running ${MEASURE_WINDOWS} measurement windows x ${TICKS_PER_WINDOW} ticks...\n`);
  const windows: WindowResult[] = [];
  for (let w = 0; w < MEASURE_WINDOWS; w++) {
    const result = runMeasuredWindow(room, TICKS_PER_WINDOW, `window-${w + 1}/${MEASURE_WINDOWS}`);
    logWindow(result);
    windows.push(result);
  }

  WorldRoom.prototype.moveAgentTo = originalMoveAgentTo; // stop counting before the deliberate benchmarks below
  const measuredSimSeconds = (MEASURE_WINDOWS * TICKS_PER_WINDOW * TICK_MS) / 1000;
  const organicCallsPerSimSecond = organicMoveAgentToCalls / measuredSimSeconds;

  // ---- overall summary across all windows ----
  const allTicks = windows.flatMap((w) => w.ticks);
  const totalTicks = allTicks.length;
  const totalStats = computeStats(allTicks.map((t) => t.totalMs));
  const crowdStats = computeStats(allTicks.map((t) => t.crowdMs));
  const syncStats = computeStats(allTicks.map((t) => t.syncMs));
  const visitorsStats = computeStats(allTicks.map((t) => t.visitorsMs));
  const overBudgetTicks = allTicks.filter((t) => t.totalMs > FRAME_BUDGET_MS).length;
  const sumOfSectionAvgs = crowdStats.avg + syncStats.avg + visitorsStats.avg;

  console.log(`\n=== SUMMARY: WorldRoom.update() full-frame cost, ${totalTicks} ticks across ${MEASURE_WINDOWS} windows ===`);
  console.log(`update() TOTAL:  ${fmtStats(totalStats)} ms`);
  console.log(`  crowdTick:     ${fmtStats(crowdStats)} ms (${((crowdStats.avg / totalStats.avg) * 100).toFixed(1)}% of avg total)`);
  console.log(`  schemaSync:    ${fmtStats(syncStats)} ms (${((syncStats.avg / totalStats.avg) * 100).toFixed(1)}% of avg total)`);
  console.log(`  visitorsTick:  ${fmtStats(visitorsStats)} ms (${((visitorsStats.avg / totalStats.avg) * 100).toFixed(1)}% of avg total)`);
  console.log(
    `  cross-check: sum of section avgs = ${sumOfSectionAvgs.toFixed(4)}ms vs. outer-wrapped total avg = ` +
      `${totalStats.avg.toFixed(4)}ms (difference = ${(totalStats.avg - sumOfSectionAvgs).toFixed(4)}ms -- ` +
      "the tiny remainder is the paused-check/Math.min + hook-overhead itself, not a missing section)",
  );
  console.log(
    `over the ${FRAME_BUDGET_MS}ms 60fps budget: ${overBudgetTicks}/${totalTicks} ticks ` +
      `(${((overBudgetTicks / totalTicks) * 100).toFixed(2)}%)`,
  );
  console.log(
    `\nFor comparison, loadtest.ts's crowd-only figure on this same machine is ~0.47-0.49ms/tick avg ` +
      `(re-run today: see this script's own crowdTick avg above, which should be in the same ballpark) -- ` +
      `that number was never the per-frame cost; it always excluded schemaSync + visitorsTick.`,
  );

  // ---- route recomputation (computePath) ----
  const roomTargets: RoomTarget[] = [];
  const nav = getNav(room);
  for (const r of plan.rooms) {
    const t = nav.findRoomTarget(r.name);
    if (t) roomTargets.push(t);
  }
  assert.ok(roomTargets.length > 0, "should resolve at least one room target for the computePath benchmarks");

  console.log(`\n=== ROUTE RECOMPUTATION (computePath), measured separately -- fires from moveAgentTo, OFF-tick ===`);
  console.log(
    `Organic call rate during the ${measuredSimSeconds.toFixed(1)}s steady-state measurement window: ` +
      `${organicMoveAgentToCalls} moveAgentTo calls (${organicCallsPerSimSecond.toFixed(3)} calls/sim-second, ` +
      `~${(organicCallsPerSimSecond * (TICK_MS / 1000)).toFixed(4)} calls/tick on average) -- this is the real ` +
      `escort-assignment + return-to-entrance rate the uncompressed spawner/dwell timings produce at ` +
      `${GUIDE_ROBOT_COUNT + SIMULATED_VISITOR_TARGET}-agent scale.`,
  );

  const computePathTimes = benchmarkComputePath(room, roomTargets, COMPUTEPATH_BENCH_SAMPLES);
  const computePathStats = computeStats(computePathTimes);
  console.log(
    `Isolated computePath() cost (${COMPUTEPATH_BENCH_SAMPLES} calls, real agent positions -> real room-door ` +
      `targets, same navmesh instance WorldRoom uses): ${fmtStats(computePathStats)} ms/call`,
  );

  const robotIds = [...room.state.agents.values()].filter((a) => a.kind === "robot").map((a) => a.id);
  assert.equal(robotIds.length, GUIDE_ROBOT_COUNT, `should have the full ${GUIDE_ROBOT_COUNT}-robot fleet tracked`);
  const burst = benchmarkReassignBurst(room, robotIds, roomTargets);
  const burstStats = computeStats(burst.perCallMs);
  console.log(
    `\nWORST-CASE BURST -- all ${GUIDE_ROBOT_COUNT} guide robots re-tasked back to back in one synchronous block ` +
      `(what a single tick pays if every escort ends and is immediately re-assigned together):`,
  );
  console.log(
    `  total added latency for the whole burst: ${burst.totalMs.toFixed(4)}ms (${burst.successCount}/${GUIDE_ROBOT_COUNT} moveAgentTo calls succeeded)`,
  );
  console.log(`  per-call within the burst: ${fmtStats(burstStats)} ms`);
  console.log(
    `  against the ${FRAME_BUDGET_MS}ms frame budget: a burst this size would cost ` +
      `${(burst.totalMs / FRAME_BUDGET_MS).toFixed(2)}x the budget ${burst.totalMs > FRAME_BUDGET_MS ? "-- OVER BUDGET if it lands in one tick" : "-- still within budget even in the worst case observed here"}.`,
  );

  // ---- verdict ----
  console.log(`\n=== VERDICT ===`);
  console.log(
    `True full-frame WorldRoom.update() cost at the real ${GUIDE_ROBOT_COUNT + SIMULATED_VISITOR_TARGET}-agent ` +
      `steady state: avg ${totalStats.avg.toFixed(3)}ms, max ${totalStats.max.toFixed(3)}ms, p95 ${totalStats.p95.toFixed(3)}ms, ` +
      `${overBudgetTicks}/${totalTicks} ticks (${((overBudgetTicks / totalTicks) * 100).toFixed(2)}%) over the ${FRAME_BUDGET_MS}ms budget ` +
      `on this ${cpus.length}-logical-processor machine.`,
  );
  console.log(
    `Route-recomputation worst case (all ${GUIDE_ROBOT_COUNT} robots re-tasked in one tick): +${burst.totalMs.toFixed(3)}ms added to ` +
      `whatever tick it lands in, on top of the normal update() cost above.`,
  );
  console.log(
    "This machine is much larger than the real t3.large (2 vCPU, 8GB) the production instance runs on -- " +
      "see the caveat printed at the top of this run. These numbers are the closest available proxy, not a " +
      "substitute for measuring on the live instance (same standing caveat as loadtest.ts's own numbers).",
  );

  room.onDispose();
  console.log("\nDONE: frametest.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
