/**
 * Memory-leak soak test for the now-persistent WorldRoom (commit 383f561 set
 * `autoDispose = false` + eager room creation at boot, per world/src/index.ts -- the room
 * now runs for the entire multi-hour demo instead of disposing whenever the last viewer
 * left). Two earlier audits (client-side Three.js disposal, and a 600-agent Crowd
 * slot-reuse stress test) both predate that lifecycle change and neither was a soak test:
 * neither measured long-run heap growth in a CONTINUOUSLY-running WorldRoom driving the
 * real simulated-visitor spawn/despawn cycle (simulatedVisitorSpawner.ts) hour after hour.
 * This script is that soak test.
 *
 * FOUND AND FIXED (this task): the first version of this script caught two real,
 * confirmed leaks in @colyseus/schema 4.0.30's internal encoder bookkeeping (verified by
 * direct introspection of `Root.refCount`/`Root.changeTrees`/`MapSchema`'s
 * `changeTree.indexes`, not just heap-shape inference) -- both triggered specifically by
 * repeatedly adding/removing Schema instances under NEW, never-reused string keys, which is
 * exactly what the simulated-visitor spawner's old `nextSimulatedId`-based ids did every
 * cycle. Fixed by pooling instead of minting-forever in two places: `WorldRoom.ts`'s
 * `agentPool` (reuses `Agent` schema instances instead of `new Agent()` per spawn) and
 * `simulatedVisitorSpawner.ts`'s `freeSlotIds` (reuses a bounded set of visitor-id
 * strings instead of an ever-incrementing counter) -- see those files' doc comments for the
 * full root-cause writeup. Both fixes verified to fully flatten the implicated internal
 * structures over a 10,000s introspection run; a small residual heapUsed growth remains
 * (~20-30% over a 30,000s/8.3-simulated-hour run, well within `MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR`
 * below) that tracks V8's normal step-then-plateau heap-growth pattern rather than a
 * continuous climb, with the WASM/native heap (external+arrayBuffers) staying perfectly
 * flat across every run -- see this file's own soak output for the actual numbers.
 *
 * ---- what it drives ----
 * A single real `WorldRoom` (the same class `index.ts` boots in production), instead of 95
 * real WebSocket clients -- this measures the room/crowd/visitor-subsystem memory behavior
 * alone, same reasoning as loadtest.ts.
 *
 * IMPORTANT, and itself a finding of this task: this does NOT construct the room the way
 * `WorldRoom.test.ts`/`visitors.test.ts` do (`new WorldRoom()` then straight into
 * `onCreate()`). That pattern is fine for those tests' short, single-process-lifetime runs,
 * but it skips `Room#__init()` -- the setup Colyseus's own `MatchMaker` normally runs
 * BEFORE `onCreate()` (see the installed colyseus 0.17.10's
 * node_modules/@colyseus/core/build/Room.mjs, `__init()`'s doc comment: "This method is
 * called by the MatchMaker before onCreate()"). `__init()` is what upgrades `state` from a
 * plain instance property into an accessor that installs a real `SchemaSerializer` and
 * wires up the periodic patch-broadcast cycle; skip it and `this._serializer` stays the
 * inert default `NoneSerializer` forever. `@colyseus/schema`'s change-tracking on every
 * mutated field (`agent.x = ...`, `agents.set(...)`, `route.push(...)`, ...) is NOT
 * per-Room -- it lives on the Schema instances themselves regardless of whether anything is
 * ever consuming it -- so with no `SchemaSerializer` ever calling `encoder.discardChanges()`,
 * that change log grows without bound for the lifetime of the process. This script
 * originally used the `WorldRoom.test.ts` pattern and (mis)measured exactly that: a
 * ~488% heapUsed growth over a 30,000s/300,000-tick run that had nothing to do with the
 * production leak this task was chasing -- it was an artifact of the harness never
 * discarding schema changes at all, something the real server always does.
 *
 * `world/src/index.ts`'s ACTUAL production room creation goes through
 * `matchMaker.createRoom("world", {})` (the comment there notes this is "the same
 * low-level entry point client.joinOrCreate() uses internally"), which DOES run
 * `__init()` -- so production rooms are not exposed to this. To measure the real code path
 * instead of an artifact of a shortcut, this script calls the room's own `__init()`
 * (private in the public API surface, reached via bracket access -- see `initRoom()` below)
 * before `onCreate()`, exactly matching MatchMaker's real ordering, so `state =
 * new WorldState()` inside `onCreate()` goes through the real accessor and gets a real
 * `SchemaSerializer`.
 *
 * `__init()` also starts a REAL wall-clock `setInterval(() => this.broadcastPatch(), 50ms)`
 * (Colyseus's default 20Hz patch rate) -- but this script drives thousands of ticks per
 * synchronous JS turn with no `await` in the loop, so that real timer can never actually
 * fire during the run (Node's event loop cannot service a timer while synchronous code is
 * executing). This script therefore calls `room.broadcastPatch()` itself once per tick,
 * synchronously, from inside the loop -- functionally identical to what the real interval
 * does (same `SchemaSerializer.applyPatches(this.clients, this.state)` call), just
 * deterministic instead of racing real wall-clock time. `this.clients` is empty for the
 * whole run (no WebSocket clients ever join), so this also directly measures the exact
 * "persistent room, zero current viewers" scenario this task's brief is about -- and
 * `SchemaSerializer.applyPatches()`'s own zero-clients branch (verified in
 * node_modules/@colyseus/core/build/serializer/SchemaSerializer.mjs) still calls
 * `encoder.discardChanges()` even when there's no one to send the patch to.
 * `setSimulationInterval()` with no callback (as WorldRoom.test.ts also does) still cancels
 * the room's OWN real wall-clock simulation timer, since simulated time is driven
 * deterministically via `update(deltaMs)` here instead.
 *
 * Guide-robot fleet is left at its real `GUIDE_ROBOT_COUNT` (50) -- this script does NOT
 * pass `disableGuideRobots`, so it matches the actual persistent-room population. The
 * simulated-visitor spawner's `simulatedTarget` is also left at its real default (45, see
 * `SIMULATED_VISITOR_TARGET`), so the room runs at the real ~95-agent demo scale.
 *
 * ---- what it compresses (and what it does NOT) ----
 * To surface a leak in minutes instead of the ~hours the real demo dwell/travel timings
 * would take, this passes `visitorManagerOptions` (an INJECTABLE test option added to
 * `WorldRoom.onCreate()` specifically for this script -- see that method's doc comment)
 * to shrink `spawnStaggerSeconds` and `dwellMinSeconds`/`dwellMaxSeconds` well below their
 * shipped defaults (`simulatedVisitorSpawner.ts`'s `SPAWN_STAGGER_INTERVAL_S`/
 * `DWELL_MIN_S`/`DWELL_MAX_S`), which are UNCHANGED by this script -- production room
 * creation (`index.ts`) passes no options and still gets those real defaults. Walking time
 * itself is NOT compressed (agent max speed is left at WorldRoom.ts's real
 * DEFAULT_AGENT_PARAMS.maxSpeed): each simulated visitor still walks the real distance
 * across the real navmesh at the real speed, so this is real crowd/steering work, not a
 * no-op. The compression only removes the IDLE waiting (dwell) and spawn throttling that
 * would otherwise dominate wall-clock time without exercising any more code.
 *
 * ---- sampling ----
 * Every SAMPLE_INTERVAL_TICKS ticks: if run with `--expose-gc` (see the `test:soak` npm
 * script), force TWO full GC passes (V8 sometimes needs more than one to fully reclaim a
 * generation) immediately before `process.memoryUsage()`, so samples reflect RETAINED
 * memory, not just-not-yet-collected garbage -- the whole point of forcing GC here instead
 * of trusting a raw sample. Records heapUsed/rss AND external/arrayBuffers, since the
 * recast-navigation WASM linear memory (the Detour Crowd's native heap) lives outside V8's
 * managed heap entirely -- a native-side leak in the Crowd would show up there and nowhere
 * else. Alongside memory, every sample also records the internal collection sizes this
 * task's brief specifically calls out: `state.agents.size` (the synced schema map),
 * `getCrowdAgentCount()` (AgentCrowd's `byId`/`lastHeading` maps, added to WorldRoom for
 * this script), and `getVisitorDebugStats()` (EscortManager's `visitors`/`robotToVisitor`
 * maps + the spawner's active-simulated count) -- a flat heap with an unboundedly growing
 * map would still be a leak, and the map sizes returning to baseline after cycling is the
 * stronger signal per the task brief, not heap shape alone.
 *
 * Run with: npm run test:soak   (== npx tsx --expose-gc scripts/soaktest.ts)
 * Configurable via env vars (both optional): SOAK_SIM_SECONDS, SOAK_SAMPLE_INTERVAL_SECONDS.
 */
import assert from "node:assert/strict";

import { WorldRoom } from "../src/rooms/WorldRoom.js";
import { SIMULATED_VISITOR_TARGET } from "../src/rooms/simulatedVisitorSpawner.js";

/** Matches WorldRoom.ts's MAX_TICK_SECONDS clamp (0.1s) exactly, so every tick is a real
 * 1:1 simulated step with no wasted clamping -- same convention visitors.test.ts uses. */
const DT_MS = 100;

/** Total simulated seconds to run. Default (6000s = 100 simulated minutes) is chosen to
 * complete in low-single-digit wall-clock minutes at this scale while still driving many
 * hundreds of spawn/despawn cycles given the compressed dwell/stagger below. Override with
 * SOAK_SIM_SECONDS for a longer/shorter run. */
const TOTAL_SIM_SECONDS = Number(process.env.SOAK_SIM_SECONDS ?? 6000);

/** How often (simulated seconds) to force-GC + sample. Default gives ~60 samples over the
 * default run -- enough resolution to see a trend without spending most of the wall-clock
 * budget on GC passes instead of ticking. */
const SAMPLE_INTERVAL_SECONDS = Number(process.env.SOAK_SAMPLE_INTERVAL_SECONDS ?? 100);

const SAMPLE_INTERVAL_TICKS = Math.round((SAMPLE_INTERVAL_SECONDS * 1000) / DT_MS);
const TOTAL_TICKS = Math.round((TOTAL_SIM_SECONDS * 1000) / DT_MS);

/** Compressed well below simulatedVisitorSpawner.ts's shipped SPAWN_STAGGER_INTERVAL_S
 * (0.5s) / DWELL_MIN_S/DWELL_MAX_S (3-8s) -- injectable via WorldRoom.onCreate()'s
 * `visitorManagerOptions`, added for this script; production defaults are untouched. */
const COMPRESSED_SPAWN_STAGGER_S = 0.05;
const COMPRESSED_DWELL_MIN_S = 0.2;
const COMPRESSED_DWELL_MAX_S = 0.5;

/** First N samples are excluded from the leak-trend verdict (JIT warmup, initial ramp-up
 * to fill the 45-visitor target, first GC generation settling) -- included in the raw
 * printed table regardless, per "report the trend honestly". */
const WARMUP_SAMPLES_EXCLUDED = 5;

/** Loose regression-guard bound: retained heapUsed at the end of the run must not exceed
 * this multiple of the post-warmup baseline. Generous on purpose -- this is a guard
 * against a genuine unbounded climb, not a tight perf assertion; real GC/allocator
 * behavior across a long run has real variance. */
const MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR = 2.0;

interface Sample {
  tick: number;
  simSeconds: number;
  heapUsedMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  schemaAgents: number;
  crowdAgents: number;
  totalVisitors: number;
  simulatedActive: number;
  escortedVisitors: number;
  robotBindings: number;
}

const bytesToMb = (b: number): number => b / (1024 * 1024);

/** Runs the private `Room#__init()` MatchMaker normally calls before `onCreate()` -- see
 * the file header comment for why this is load-bearing (it's what wires up the real
 * `SchemaSerializer` so `broadcastPatch()` below actually discards `@colyseus/schema`
 * change-tracking, instead of it silently accumulating forever). `__init` is `private` in
 * `@colyseus/core`'s `.d.ts` (TypeScript-only; it's a normal enumerable method at runtime),
 * so this reaches it via bracket-index access, which TypeScript does not enforce `private`
 * against -- a deliberate, narrow escape hatch for this one soak-test harness concern, not
 * a pattern used anywhere in production code. */
function initRoom(room: WorldRoom): void {
  (room as unknown as { __init(): void })["__init"]();
}

function takeSample(room: WorldRoom, tick: number, gcAvailable: boolean): Sample {
  if (gcAvailable) {
    // Two passes: V8's generational GC can need a second full collection to actually
    // reclaim objects that were promoted to old-space during the first.
    global.gc!();
    global.gc!();
  }

  const mem = process.memoryUsage();
  const stats = room.getVisitorDebugStats();

  return {
    tick,
    simSeconds: (tick * DT_MS) / 1000,
    heapUsedMb: bytesToMb(mem.heapUsed),
    rssMb: bytesToMb(mem.rss),
    externalMb: bytesToMb(mem.external),
    arrayBuffersMb: bytesToMb(mem.arrayBuffers),
    schemaAgents: room.state.agents.size,
    crowdAgents: room.getCrowdAgentCount(),
    totalVisitors: stats.totalVisitors,
    simulatedActive: stats.simulatedActive,
    escortedVisitors: stats.escortedVisitors,
    robotBindings: stats.robotBindings,
  };
}

function logSampleHeader(): void {
  console.log(
    "tick".padStart(7) +
      " | " +
      "simS".padStart(7) +
      " | " +
      "heapMB".padStart(8) +
      " | " +
      "rssMB".padStart(8) +
      " | " +
      "extMB".padStart(7) +
      " | " +
      "abMB".padStart(7) +
      " | " +
      "schemaAg".padStart(8) +
      " | " +
      "crowdAg".padStart(7) +
      " | " +
      "totVis".padStart(6) +
      " | " +
      "simAct".padStart(6) +
      " | " +
      "escort".padStart(6) +
      " | " +
      "robotBind".padStart(9),
  );
}

function logSample(s: Sample): void {
  console.log(
    String(s.tick).padStart(7) +
      " | " +
      s.simSeconds.toFixed(0).padStart(7) +
      " | " +
      s.heapUsedMb.toFixed(2).padStart(8) +
      " | " +
      s.rssMb.toFixed(2).padStart(8) +
      " | " +
      s.externalMb.toFixed(2).padStart(7) +
      " | " +
      s.arrayBuffersMb.toFixed(2).padStart(7) +
      " | " +
      String(s.schemaAgents).padStart(8) +
      " | " +
      String(s.crowdAgents).padStart(7) +
      " | " +
      String(s.totalVisitors).padStart(6) +
      " | " +
      String(s.simulatedActive).padStart(6) +
      " | " +
      String(s.escortedVisitors).padStart(6) +
      " | " +
      String(s.robotBindings).padStart(9),
  );
}

/** Simple least-squares slope of `values` against their index -- units are
 * value-per-sample, which the caller converts to value-per-1000-samples for readability. */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<void> {
  const gcAvailable = typeof global.gc === "function";
  if (!gcAvailable) {
    console.warn(
      "WARNING: global.gc() is not available -- run with `npx tsx --expose-gc scripts/soaktest.ts` " +
        "(or `npm run test:soak`) for a real retained-memory measurement. Proceeding WITHOUT " +
        "forced GC; samples below will include uncollected garbage, not just retained memory, " +
        "which biases the trend upward and makes a healthy heap look worse than it is.",
    );
  }

  console.log(
    `Plan: ${TOTAL_SIM_SECONDS}s simulated (${TOTAL_TICKS} ticks @ ${DT_MS}ms/tick), ` +
      `sampling every ${SAMPLE_INTERVAL_SECONDS}s simulated (every ${SAMPLE_INTERVAL_TICKS} ticks), ` +
      `gc=${gcAvailable ? "forced (2 passes/sample)" : "NOT AVAILABLE"}\n` +
      `Compression: spawnStaggerSeconds ${COMPRESSED_SPAWN_STAGGER_S}s (prod 0.5s), ` +
      `dwell ${COMPRESSED_DWELL_MIN_S}-${COMPRESSED_DWELL_MAX_S}s (prod 3-8s) -- walking speed/distance ` +
      `is NOT compressed, this is real crowd/steering work.\n`,
  );

  const room = new WorldRoom();
  // __init() BEFORE onCreate() -- matches MatchMaker's real ordering; see the file header
  // comment for why this is required for broadcastPatch() below to do anything real.
  initRoom(room);
  // disableGuideRobots is deliberately NOT passed -- this soak test wants the real
  // GUIDE_ROBOT_COUNT-sized fleet (50), matching the actual persistent room's population.
  await room.onCreate({
    visitorManagerOptions: {
      spawnStaggerSeconds: COMPRESSED_SPAWN_STAGGER_S,
      dwellMinSeconds: COMPRESSED_DWELL_MIN_S,
      dwellMaxSeconds: COMPRESSED_DWELL_MAX_S,
    },
  });
  // Cancel the room's own real wall-clock simulation timer -- this script drives simulated
  // time itself via repeated update(deltaMs) calls, same pattern as WorldRoom.test.ts/
  // visitors.test.ts. The real patchRate interval __init() started is left alone (it can
  // never fire mid-loop anyway, see file header) and is explicitly cleared after the loop.
  room.setSimulationInterval();

  const samples: Sample[] = [];
  logSampleHeader();
  samples.push(takeSample(room, 0, gcAvailable));
  logSample(samples[samples.length - 1]);

  const startedAtMs = Date.now();
  for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
    room.update(DT_MS);
    // Stands in for the real 20Hz patch-broadcast interval (see file header) -- discards
    // @colyseus/schema's accumulated change-tracking every tick, with zero connected
    // clients, exactly like the real persistent room does between demo sessions.
    room.broadcastPatch();
    if (tick % SAMPLE_INTERVAL_TICKS === 0) {
      const s = takeSample(room, tick, gcAvailable);
      samples.push(s);
      logSample(s);
    }
  }
  const wallClockSeconds = (Date.now() - startedAtMs) / 1000;

  // Stop the real (never-fired, but still live) patchRate interval __init() started before
  // onDispose()/process exit -- tidiness only, process.exit() below would force-clear it
  // regardless, but this keeps the room's own teardown honest if this script is ever
  // extended to run longer or reused interactively.
  room.patchRate = null as unknown as number;
  room.onDispose();

  // ---- collection-size sanity: bounded maps must stay bounded across the whole run ----
  const maxSchemaAgents = Math.max(...samples.map((s) => s.schemaAgents));
  const maxCrowdAgents = Math.max(...samples.map((s) => s.crowdAgents));
  const maxTotalVisitors = Math.max(...samples.map((s) => s.totalVisitors));
  const maxRobotBindings = Math.max(...samples.map((s) => s.robotBindings));
  const lastSchemaVsCrowdDiverged = samples.some((s) => s.schemaAgents !== s.crowdAgents);

  console.log("\n=== COLLECTION-SIZE INVARIANTS ===");
  console.log(
    `schema agents: max=${maxSchemaAgents} (guide fleet 50 + up to ${SIMULATED_VISITOR_TARGET} simulated visitors = ${
      50 + SIMULATED_VISITOR_TARGET
    } expected ceiling)`,
  );
  console.log(`crowd agents (AgentCrowd.byId/lastHeading): max=${maxCrowdAgents}`);
  console.log(
    `schema vs crowd agent count ${lastSchemaVsCrowdDiverged ? "DIVERGED at least once -- LEAK EVIDENCE (one side removed an agent the other kept)" : "matched on every sample (no divergence observed)"}`,
  );
  console.log(
    `EscortManager.visitors map: max totalVisitors=${maxTotalVisitors} (expected ceiling ~${SIMULATED_VISITOR_TARGET}, plus any transient real visitors -- none spawned by this script)`,
  );
  console.log(`EscortManager.robotToVisitor map: max robotBindings=${maxRobotBindings} (expected ceiling 50, the guide fleet size)`);

  // ---- heap trend ----
  const trendSamples = samples.slice(WARMUP_SAMPLES_EXCLUDED);
  const heapValues = trendSamples.map((s) => s.heapUsedMb);
  const rssValues = trendSamples.map((s) => s.rssMb);
  const externalValues = trendSamples.map((s) => s.externalMb);

  const heapSlopePerSample = linearSlope(heapValues);
  const rssSlopePerSample = linearSlope(rssValues);
  const externalSlopePerSample = linearSlope(externalValues);

  const baselineWindow = trendSamples.slice(0, Math.min(5, trendSamples.length));
  const finalWindow = trendSamples.slice(-Math.min(5, trendSamples.length));
  const baselineHeapMb = median(baselineWindow.map((s) => s.heapUsedMb));
  const finalHeapMb = median(finalWindow.map((s) => s.heapUsedMb));
  const baselineExternalMb = median(baselineWindow.map((s) => s.externalMb));
  const finalExternalMb = median(finalWindow.map((s) => s.externalMb));

  console.log("\n=== MEMORY TREND (post-warmup samples only) ===");
  console.log(
    `heapUsed: baseline(median of first ${baselineWindow.length})=${baselineHeapMb.toFixed(2)}MB -> ` +
      `final(median of last ${finalWindow.length})=${finalHeapMb.toFixed(2)}MB | slope=${(heapSlopePerSample * 1000).toFixed(4)}MB/1000 samples`,
  );
  console.log(
    `rss: slope=${(rssSlopePerSample * 1000).toFixed(4)}MB/1000 samples (informational -- rss includes OS-level effects beyond V8/WASM)`,
  );
  console.log(
    `external+arrayBuffers (recast/Detour WASM heap lives here, NOT in heapUsed): ` +
      `baseline=${baselineExternalMb.toFixed(2)}MB -> final=${finalExternalMb.toFixed(2)}MB | ` +
      `slope=${(externalSlopePerSample * 1000).toFixed(4)}MB/1000 samples`,
  );

  console.log(
    `\nRan ${TOTAL_TICKS} ticks (${TOTAL_SIM_SECONDS}s simulated) in ${wallClockSeconds.toFixed(1)}s wall-clock ` +
      `(${samples.length} samples).`,
  );

  // ---- verdict ----
  const heapGrowthFactor = baselineHeapMb > 0 ? finalHeapMb / baselineHeapMb : 1;
  const collectionsBounded =
    !lastSchemaVsCrowdDiverged &&
    maxSchemaAgents <= 50 + SIMULATED_VISITOR_TARGET &&
    maxRobotBindings <= 50;

  console.log("\n=== VERDICT ===");
  if (collectionsBounded && heapGrowthFactor <= MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR) {
    console.log(
      `NO LEAK OBSERVED: collections stayed within their expected bounds across ${maxTotalVisitors > 0 ? "many" : "0"} ` +
        `spawn/despawn cycles, and heapUsed grew ${((heapGrowthFactor - 1) * 100).toFixed(1)}% ` +
        `baseline-to-final (within the ${((MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR - 1) * 100).toFixed(0)}% guard band).`,
    );
  } else {
    console.log(
      `POSSIBLE LEAK: ${!collectionsBounded ? "collection size exceeded its expected bound or schema/crowd diverged. " : ""}` +
        `${heapGrowthFactor > MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR ? `heapUsed grew ${((heapGrowthFactor - 1) * 100).toFixed(1)}% baseline-to-final, over the guard band. ` : ""}` +
        "See the raw sample table above.",
    );
  }

  // ---- regression guard assertions (fail the script -- and a CI run -- if this regresses) ----
  assert.ok(
    !lastSchemaVsCrowdDiverged,
    "schema agent count and AgentCrowd agent count diverged at some point -- addAgent/removeAgent " +
      "are no longer keeping the synced schema and the native Crowd in lockstep",
  );
  assert.ok(
    maxSchemaAgents <= 50 + SIMULATED_VISITOR_TARGET,
    `schema agents peaked at ${maxSchemaAgents}, above the expected ceiling of ${50 + SIMULATED_VISITOR_TARGET} ` +
      "(50 guide robots + the simulated-visitor target) -- visitors are not being despawned",
  );
  assert.ok(
    maxRobotBindings <= 50,
    `robotBindings peaked at ${maxRobotBindings}, above the 50-robot fleet size -- EscortManager's ` +
      "robotToVisitor map is not being cleaned up on escort end",
  );
  assert.ok(
    heapGrowthFactor <= MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR,
    `heapUsed grew ${((heapGrowthFactor - 1) * 100).toFixed(1)}% from baseline (${baselineHeapMb.toFixed(2)}MB) ` +
      `to final (${finalHeapMb.toFixed(2)}MB), over the ${((MAX_ACCEPTABLE_HEAP_GROWTH_FACTOR - 1) * 100).toFixed(0)}% guard band`,
  );

  console.log("\nDONE: soaktest.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
