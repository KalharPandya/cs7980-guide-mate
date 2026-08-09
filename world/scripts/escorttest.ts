/**
 * Escort-outcome measurement harness.
 *
 * The problem this closes: `EscortManager.tick()` (escortManager.ts) used to log ONLY on
 * timeout (`console.warn` on the `ESCORT_TIMEOUT_S` safety valve). A production run
 * showing a handful of timeout lines in the first few minutes told nobody whether that was
 * a healthy minority alongside many silent successes, or nearly every escort failing --
 * because nothing ever logged (or counted) a SUCCESSFUL arrival to compare against. Given
 * commit 7a9b171 changed completion to require BOTH `robotAtDestination` AND
 * `visitorCaughtUpToRobot` (VISITOR_ARRIVAL_DISTANCE_M = 2.5m -- see that constant's doc
 * comment in escortManager.ts), a systemic follow-behavior defect would present as exactly
 * "escorts time out instead of completing", i.e. the original "people are stuck" complaint
 * this whole project traces back to. This script answers, with real numbers over a real run
 * at real demo scale, which of those it is.
 *
 * ---- what it drives ----
 * A single real `WorldRoom` (`new WorldRoom()` + `onCreate()`, same construction pattern as
 * `WorldRoom.test.ts`/`visitors.test.ts` -- no live Colyseus transport needed, this doesn't
 * touch the wire or schema encoding, just the escort/crowd logic), at REAL demo scale and
 * REAL timing: the real `GUIDE_ROBOT_COUNT` (50) guide-robot fleet (not disabled), the real
 * `SIMULATED_VISITOR_TARGET` (45) simulated-visitor spawner target (not disabled, not
 * overridden), and the real `spawnStaggerSeconds`/`dwellMinSeconds`/`dwellMaxSeconds`/
 * `escortTimeoutSeconds` defaults (unlike soaktest.ts/pooltest.ts, this script does NOT
 * compress dwell/stagger timing -- the whole point is to measure the real system's real
 * behavior, not a compressed stand-in for it). Simulated time is hand-driven via repeated
 * `update(DT_MS)` calls, DT_MS=100 matching `WorldRoom.ts`'s own `MAX_TICK_SECONDS` clamp
 * (the same convention `soaktest.ts`/`visitors.test.ts` use, so every tick is a real 1:1
 * simulated step with no wasted clamping).
 *
 * ---- how outcomes are collected ----
 * Via `EscortManager`'s `onEscortOutcome` hook (escortManager.ts's `EscortOutcome`/
 * `EscortManagerOptions`, added alongside this script), passed through
 * `WorldRoom.onCreate()`'s existing `visitorManagerOptions` injection point (the same one
 * `soaktest.ts`/`pooltest.ts` already use to compress timing) -- an opt-in instrumentation
 * hook, same convention as `WorldRoom.ts`'s `onUpdateSectionTiming`, so this collection has
 * ZERO cost on the production path (no production code sets it) and does NOT add a
 * per-completion `console.log` to the server's own logging -- which would flood the output
 * at ~45 concurrent visitors, the exact thing this task was told not to do. The hook fires
 * once per escort ending, with the duration, final separation, and whether the robot itself
 * had reached "idle at destination" -- everything needed to root-cause a timeout without
 * re-deriving it from polled positions.
 *
 * ---- what's asserted vs. reported ----
 * The regression guard (MIN_ACCEPTABLE_DELIVERY_RATE) is a floor set from THIS script's own
 * measured runs (see the numbers in the assertion's own comment) -- not a number invented in
 * advance -- so future runs are checked against actual observed healthy behavior, not a guess.
 *
 * ---- what this harness got WRONG for a while, and why (read before trusting a number here) ----
 * Every escort outcome used to be summarised by `separationM` (robot-to-visitor distance at
 * release) and nothing else, and the headline number was the share of escorts EscortManager
 * itself reported as "completed". Both are blind in the same place. The robot is standing right
 * next to the person at the END OF THE FETCH LEG just as much as at the destination, so an
 * escort released at the PICKUP point produces a ~1.4m `separationM` that is indistinguishable
 * from a real delivery -- and the reported-completed rate is whatever the completion gate says,
 * so it cannot possibly audit that gate. A real defect lived behind those numbers: the gate
 * accepted a bare `robotAgent.state === "idle"` as "robot has arrived at the destination", which
 * is true the instant the fetch leg ends, so escorts reported `completed` with the person still
 * 20+ m from the room they asked for -- while this script printed a healthy 98.6-98.7%.
 * The fix here is the `visitorDistanceToDestinationM` block plus the zero-tolerance delivery
 * assertion below: distance to the destination THEY ASKED FOR is the only measurement that can
 * tell a delivery from a plausible-looking release next to a robot.
 *
 * Run with: npm run test:escort   (== npx tsx scripts/escorttest.ts)
 * Configurable via env var (optional): ESCORT_TEST_SIM_SECONDS.
 */
import assert from "node:assert/strict";

import { WorldRoom } from "../src/rooms/WorldRoom.js";
import type { EscortOutcome } from "../src/rooms/escortManager.js";

/** Matches WorldRoom.ts's MAX_TICK_SECONDS clamp (0.1s) exactly -- see file header. */
const DT_MS = 100;

/** Total simulated seconds to run. 6000s (100 simulated minutes) matches soaktest.ts's
 * default run length -- known from that script to complete in low-single-digit wall-clock
 * minutes at this ~95-agent scale, and (per this script's own first run) drives many
 * hundreds of full escort cycles even at REAL (uncompressed) dwell/stagger timing. Override
 * with ESCORT_TEST_SIM_SECONDS for a longer/shorter run. */
const TOTAL_SIM_SECONDS = Number(process.env.ESCORT_TEST_SIM_SECONDS ?? 6000);
const TOTAL_TICKS = Math.round((TOTAL_SIM_SECONDS * 1000) / DT_MS);

/** Below this many total escort outcomes, the run hasn't exercised enough of the system to
 * say anything meaningful -- fail loudly instead of reporting a confident-sounding
 * percentage off a handful of samples. "Many hundreds" per the task brief; set well below
 * that as a floor so a slower CI machine doesn't spuriously fail this on tick-count alone. */
const MIN_TOTAL_ESCORTS = 300;

/**
 * How far (meters) from the destination THEY ASKED FOR a visitor may be, at the moment the
 * escort ends, and still count as genuinely DELIVERED.
 *
 * Derived from the completion contract in escortManager.ts, not picked to make a number look
 * good: completion requires the ROBOT within `ROBOT_DESTINATION_RADIUS_M` (1.0m) of the
 * resolved destination point AND the VISITOR within `VISITOR_ARRIVAL_DISTANCE_M` (2.5m) of
 * that robot, so by the triangle inequality a legitimately-completed escort can leave the
 * visitor at most 1.0 + 2.5 = 3.5m from the destination. This is the same bound
 * `src/test/assignChain.test.ts` already asserts against (`DOOR_TOLERANCE_M + 2.5`).
 *
 * Why this metric had to be added: the harness previously reported only `separationM`
 * (robot-to-visitor), which is ~1.4m for a healthy delivery AND ~1.4m for an escort that
 * falsely "completed" at the PICKUP point with the person still 20m from where they asked to
 * go -- the two are indistinguishable in that number. A 98.6% "completion" rate measured that
 * way was not measuring delivery at all.
 */
const DELIVERED_RADIUS_M = 3.5;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function summarize(label: string, values: number[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: (none)`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${values.length} min=${sorted[0].toFixed(2)} p10=${percentile(sorted, 0.1).toFixed(2)} ` +
      `median=${percentile(sorted, 0.5).toFixed(2)} p90=${percentile(sorted, 0.9).toFixed(2)} ` +
      `max=${sorted[sorted.length - 1].toFixed(2)} mean=${mean(values).toFixed(2)}`,
  );
}

async function main(): Promise<void> {
  console.log(
    `Plan: ${TOTAL_SIM_SECONDS}s simulated (${TOTAL_TICKS} ticks @ ${DT_MS}ms/tick), real demo scale ` +
      `(50 guide robots, 45-visitor simulated target, REAL dwell/stagger/timeout defaults -- nothing compressed).\n`,
  );

  const outcomes: EscortOutcome[] = [];

  const room = new WorldRoom();
  // Real fleet, real spawner target, real timing -- no disable*/override options passed
  // except the onEscortOutcome collection hook itself (zero-behavior-impact, see file
  // header). This is deliberately the same config production room creation
  // (world/src/index.ts) gets.
  await room.onCreate({
    visitorManagerOptions: {
      onEscortOutcome: (outcome) => outcomes.push(outcome),
    },
  });
  room.setSimulationInterval();

  const startedAtMs = Date.now();
  for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
    room.update(DT_MS);
  }
  const wallClockSeconds = (Date.now() - startedAtMs) / 1000;

  const finalStats = room.getVisitorDebugStats();
  room.onDispose();

  console.log(
    `Ran ${TOTAL_TICKS} ticks (${TOTAL_SIM_SECONDS}s simulated) in ${wallClockSeconds.toFixed(1)}s wall-clock.\n`,
  );

  // Sanity: EscortManager's own lifetime counters (EscortDebugStats.completedEscorts/
  // timedOutEscorts) must agree with what the hook collected -- if they don't, the hook
  // itself (or the counters) has a bug, and nothing below can be trusted.
  const completed = outcomes.filter((o) => o.outcome === "completed");
  const timedOut = outcomes.filter((o) => o.outcome === "timed_out");
  assert.equal(
    completed.length,
    finalStats.completedEscorts,
    `hook-collected completed count (${completed.length}) != EscortManager's own counter (${finalStats.completedEscorts})`,
  );
  assert.equal(
    timedOut.length,
    finalStats.timedOutEscorts,
    `hook-collected timed-out count (${timedOut.length}) != EscortManager's own counter (${finalStats.timedOutEscorts})`,
  );

  const total = outcomes.length;
  const completionRate = total > 0 ? (completed.length / total) * 100 : 0;

  // The DELIVERY definition (see DELIVERED_RADIUS_M): the escort reported "completed" AND the
  // visitor actually ended up at the destination they asked for. Reported alongside the raw
  // reported-completed rate rather than instead of it, so the two can never silently diverge
  // again without it being visible on this run's own output.
  const delivered = completed.filter(
    (o) => o.visitorDistanceToDestinationM !== null && o.visitorDistanceToDestinationM <= DELIVERED_RADIUS_M,
  );
  const falselyCompleted = completed.filter(
    (o) => o.visitorDistanceToDestinationM === null || o.visitorDistanceToDestinationM > DELIVERED_RADIUS_M,
  );
  const deliveryRate = total > 0 ? (delivered.length / total) * 100 : 0;

  console.log("=== ESCORT OUTCOME DISTRIBUTION ===");
  console.log(`Total escorts ended: ${total}`);
  console.log(
    `Completed (reported by EscortManager): ${completed.length} (${completionRate.toFixed(1)}%)`,
  );
  console.log(
    `Timed out (ESCORT_TIMEOUT_S): ${timedOut.length} (${(100 - completionRate).toFixed(1)}%)`,
  );
  console.log(`Still bound/in-progress at end of run (not counted above): ${finalStats.robotBindings}`);

  console.log("\n=== TRUE COMPLETION (visitor actually delivered to the room they asked for) ===");
  console.log(
    `DELIVERED (completed AND visitor <= ${DELIVERED_RADIUS_M}m from the requested destination): ` +
      `${delivered.length}/${total} (${deliveryRate.toFixed(1)}%)`,
  );
  console.log(
    `FALSE COMPLETIONS (reported "completed" with the visitor still > ${DELIVERED_RADIUS_M}m away): ` +
      `${falselyCompleted.length}` +
      (completed.length > 0
        ? ` (${((falselyCompleted.length / completed.length) * 100).toFixed(1)}% of reported completions)`
        : ""),
  );

  console.log("\n=== TIME-TO-COMPLETION (seconds, completed escorts only) ===");
  summarize("durationSeconds", completed.map((o) => o.durationSeconds));

  // THE metric the old harness was missing entirely. `separationM` below is robot-to-visitor
  // and reads the same (~1.4m) whether the pair is standing at the destination or at the
  // pickup point; only this block can tell those apart. Reported for ALL reported-completed
  // escorts (not just the delivered subset) precisely so a false completion shows up here as a
  // long tail instead of being filtered out of its own evidence.
  console.log(
    "\n=== VISITOR DISTANCE TO THE REQUESTED DESTINATION AT COMPLETION (m; the delivery metric) ===",
  );
  summarize(
    "visitorDistanceToDestinationM",
    completed
      .map((o) => o.visitorDistanceToDestinationM)
      .filter((d): d is number => d !== null),
  );
  console.log(
    "\n=== ROBOT DISTANCE TO THE REQUESTED DESTINATION AT COMPLETION (m) ===\n" +
      "  If this is large while separationM is small, the escort ended with the pair together\n" +
      "  somewhere that is NOT the destination -- i.e. a completion declared at the pickup point.",
  );
  summarize(
    "robotDistanceToDestinationM",
    completed
      .map((o) => o.robotDistanceToDestinationM)
      .filter((d): d is number => d !== null),
  );
  if (falselyCompleted.length > 0) {
    console.log("\n  --- the FALSE completions, in full (worst 10 by visitor distance) ---");
    for (const o of [...falselyCompleted]
      .sort((a, b) => (b.visitorDistanceToDestinationM ?? 0) - (a.visitorDistanceToDestinationM ?? 0))
      .slice(0, 10)) {
      console.log(`    ${JSON.stringify(o)}`);
    }
  }

  console.log("\n=== FINAL SEPARATION AT COMPLETION (m; sanity check, should all be <= 2.5) ===");
  summarize("separationM", completed.map((o) => o.separationM));
  const completedOverThreshold = completed.filter((o) => o.separationM > 2.5);
  assert.equal(
    completedOverThreshold.length,
    0,
    `${completedOverThreshold.length} "completed" escort(s) had separationM > 2.5 -- VISITOR_ARRIVAL_DISTANCE_M ` +
      "gate is not actually being enforced",
  );
  // Phase-ordering invariant: an escort can only COMPLETE from the leading leg, i.e. the
  // robot fetched the person first and only then walked them to the destination. A
  // completed escort recorded as still "approaching" would mean the fetch-then-guide
  // ordering had collapsed.
  const completedNotLeading = completed.filter((o) => o.phase !== "leading");
  assert.equal(
    completedNotLeading.length,
    0,
    `${completedNotLeading.length} "completed" escort(s) ended outside the leading phase -- an escort must ` +
      "fetch the person first and can only complete while leading them to the destination",
  );

  if (timedOut.length > 0) {
    // Which LEG failed. The escort is two navigations back to back -- "approaching" (the
    // robot goes to fetch the person, who waits in place) then "leading" (the robot walks
    // them to the destination, trailing behind) -- and the ESCORT_TIMEOUT_S safety valve
    // bounds each independently. A fetch-leg timeout means the robot could never reach the
    // PERSON (unreachable spot / wedged route); a lead-leg timeout means the pickup worked
    // and the trip to the destination is what didn't finish. They need different diagnoses,
    // so they are never reported as one undifferentiated timeout count.
    const timedOutFetching = timedOut.filter((o) => o.phase === "approaching");
    const timedOutLeading = timedOut.filter((o) => o.phase === "leading");
    console.log("\n=== TIMEOUT BY PHASE (which leg of the escort failed) ===");
    console.log(
      `  approaching (robot never reached the PERSON): ${timedOutFetching.length}` +
        ` (${((timedOutFetching.length / total) * 100).toFixed(1)}% of all escorts)`,
    );
    console.log(
      `  leading (person picked up, trip to the DESTINATION never finished): ${timedOutLeading.length}` +
        ` (${((timedOutLeading.length / total) * 100).toFixed(1)}% of all escorts)`,
    );

    console.log("\n=== FINAL SEPARATION AT TIMEOUT (m) -- root-cause signal ===");
    console.log(
      "  If this clusters just above 2.5m, the ARRIVAL threshold is too tight. If it's tens of\n" +
        "  metres, the visitor was never closing the gap at all (not a threshold problem).",
    );
    summarize("separationM", timedOut.map((o) => o.separationM));

    console.log("\n=== VISITOR DISTANCE TO THE REQUESTED DESTINATION AT TIMEOUT (m) ===");
    summarize(
      "visitorDistanceToDestinationM",
      timedOut.map((o) => o.visitorDistanceToDestinationM).filter((d): d is number => d !== null),
    );

    const timedOutRobotIdle = timedOut.filter((o) => o.robotAtDestination);
    const timedOutRobotNotIdle = timedOut.filter((o) => !o.robotAtDestination);
    console.log(
      `\n  Of ${timedOut.length} timed-out escorts, the ROBOT had reached the destination in ` +
        `${timedOutRobotIdle.length} (${((timedOutRobotIdle.length / timedOut.length) * 100).toFixed(1)}%) -- the rest (${
          timedOutRobotNotIdle.length
        }) timed out with the robot ITSELF still not settled (crowd congestion / a slow route), not a visitor-follow problem at all.`,
    );
    console.log(
      "  Separation for the subset where the robot WAS idle (this is the only slice where a visitor-follow\n" +
        "  defect could actually be the cause -- the visitor had a stationary target and 90s to reach it):",
    );
    summarize("separationM (robot idle, visitor never caught up)", timedOutRobotIdle.map((o) => o.separationM));

    console.log("\n=== TIME-TO-TIMEOUT (seconds, should cluster near ESCORT_TIMEOUT_S=90) ===");
    summarize("durationSeconds", timedOut.map((o) => o.durationSeconds));
  } else {
    console.log("\nNo timeouts observed in this run.");
  }

  console.log("\n=== VERDICT ===");
  assert.ok(
    total >= MIN_TOTAL_ESCORTS,
    `only ${total} escorts ended during this run (need >= ${MIN_TOTAL_ESCORTS}) -- increase ESCORT_TEST_SIM_SECONDS; ` +
      "this run did not drive enough escorts to say anything meaningful about the completion rate",
  );
  console.log(`PASS: drove ${total} escorts to completion or timeout (>= ${MIN_TOTAL_ESCORTS} floor)`);

  // THE assertion this harness was missing. A "completed" escort is a CLAIM that the person
  // was delivered; this checks the claim against where the person actually is. Zero tolerance
  // is not a strict-for-strictness choice, it is the completion contract restated: the gate in
  // escortManager.ts requires the robot within ROBOT_DESTINATION_RADIUS_M of the destination
  // and the visitor within VISITOR_ARRIVAL_DISTANCE_M of the robot, so every completion it
  // emits is <= DELIVERED_RADIUS_M from the destination BY CONSTRUCTION. Any exception means
  // the gate is not enforcing what it claims -- which is exactly the defect that let a
  // completion fire at the PICKUP point while the person was still 20.8m from the Kitchen they
  // asked for, behind a 98.6% "completion" rate measured on robot-to-visitor separation alone.
  assert.equal(
    falselyCompleted.length,
    0,
    `${falselyCompleted.length}/${completed.length} escort(s) reported "completed" with the visitor still more than ` +
      `${DELIVERED_RADIUS_M}m from the destination they asked for -- completion is not actually gated on delivery ` +
      "(see the FALSE completions listed above for the raw records)",
  );
  console.log(
    `PASS: all ${completed.length} reported completions had the visitor within ${DELIVERED_RADIUS_M}m of the ` +
      "destination they asked for (no completion declared at the pickup point)",
  );

  // Regression guard, applied to the DELIVERY rate rather than the reported-completed rate.
  // Guarding the reported rate was worse than useless while the two could diverge: the reported
  // rate stayed at 98.7% across the very runs in which escorts were completing at the pickup
  // point, so the guard would have gone on passing through the defect. The delivered rate is the
  // number that can only go up when people actually get where they asked to go.
  //
  // The floor is pinned to what THIS harness measured, at real demo scale/timing, over three
  // independent 6000s runs each side of the completion-gate fix (2026-08-08):
  //   BEFORE: reported completed 98.7% / 97.6% / 98.4%, but DELIVERED only 96.9% / 96.3% /
  //           96.0%, with 7 / 5 / 9 false completions per run (visitor up to 20.82m from the
  //           room they asked for while the escort said "completed").
  //   AFTER:  DELIVERED 98.7% / 97.9% / 98.7%, false completions 0 / 0 / 0, every remaining
  //           failure an ESCORT_TIMEOUT_S timeout in the "approaching" (fetch) leg, zero
  //           lead-leg timeouts.
  // The timeout count did not rise across the fix (5 before vs 5, 8, 5 after -- inside ordinary
  // run-to-run spread), which is the evidence that tightening the robot-side gate to
  // ROBOT_DESTINATION_RADIUS_M did not convert genuine arrivals into timeouts. Worth noting
  // from those runs: robot-to-destination at completion reaches 0.98-0.99m, i.e. real arrivals
  // do use most of that 1.0m radius under crowding, so it is not over-generous.
  //
  // Re-measured either side of the crowd-deadlock fix (2026-08-09), same harness, same scale:
  //   BEFORE (separationWeight 2, robot dispatched to the person's exact position): DELIVERED
  //          98.7% (371/376) and 97.0% (357/368), with 5 and 11 ESCORT_TIMEOUT_S timeouts. The
  //          timeouts' robot-to-visitor separations cluster at 1.21-1.24m -- the signature of
  //          the separation-vs-steering deadlock described in WorldRoom.ts's SEPARATION_WEIGHT
  //          doc comment, i.e. those escorts were stuck, not merely slow.
  //   AFTER  (separationWeight 1.0 + FETCH_STANDOFF_M, escortManager.ts): DELIVERED 100.0%
  //          (444/444) and 100.0% (441/441), ZERO timeouts in either run, and MORE escorts
  //          driven in the same 6000s (441-444 vs 368-376) because no robot/visitor pair spends
  //          90s wedged. Median time-to-completion fell from 13.6-14.0s to 12.1-12.3s.
  // The floor below is deliberately left at 90 rather than ratcheted up to the new numbers: it
  // is a regression guard against a broken system, not a high-water mark, and a guard that
  // fires on ordinary crowd luck gets ignored.
  // 90% leaves ~8 points of margin below the lowest measured delivery rate for ordinary
  // Math.random()-driven run-to-run variance (dwell times, spawn stagger, which rooms get
  // picked) while still catching a real regression in the fetch/follow/arrival logic. It is
  // deliberately NOT set just under the measured number: a delivery rate is allowed to wobble a
  // few points on crowd luck, and a guard that fires on luck gets ignored.
  const MIN_ACCEPTABLE_DELIVERY_RATE = 90;
  assert.ok(
    deliveryRate >= MIN_ACCEPTABLE_DELIVERY_RATE,
    `TRUE completion (delivery) rate ${deliveryRate.toFixed(1)}% is below the ${MIN_ACCEPTABLE_DELIVERY_RATE}% regression ` +
      `floor (${delivered.length}/${total} delivered, ${completed.length} reported completed, ${timedOut.length} timed out) ` +
      "-- see the distributions above for root cause",
  );
  console.log(
    `PASS: TRUE completion (delivery) rate ${deliveryRate.toFixed(1)}% is at or above the ` +
      `${MIN_ACCEPTABLE_DELIVERY_RATE}% regression floor (reported-completed rate was ${completionRate.toFixed(1)}%)`,
  );

  console.log("\nDONE: escorttest.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
