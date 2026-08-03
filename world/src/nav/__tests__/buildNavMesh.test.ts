/**
 * End-to-end navmesh tests: build once from the real floor-14.json, then prove
 *   1. findRoomTarget resolves both a bare room number ("1425") and the full name
 *      ("Classroom 1425") to a point near the door coordinate in the JSON, and
 *   2. computePath from the entrance to multiple rooms' doors actually ARRIVES --
 *      this is the real proof the doors connect to the corridor, not just that the
 *      navmesh built without throwing.
 *
 * Per Task 1.1's instructions: if a room's door doesn't path from the entrance, that is
 * reported here as a real, specific finding (room name + door coordinate) rather than
 * silently worked around -- it's a floor-14.json wall-gap data issue, not a bug in this
 * code, and floor-14.json is NOT edited by this task to compensate.
 *
 * IMPORTANT (found 2026-08-02): `NavMeshQuery.computePath` returns `success: true` and a
 * non-empty `path` even when the target polygon is UNREACHABLE from the start -- Detour's
 * underlying `findPath` returns a PARTIAL result (a path to the closest polygon it could
 * actually reach) and `computePath` never surfaces that partiality to the caller. A test
 * that only asserts `success && path.length > 0` therefore PASSES on a disconnected room,
 * silently. (This is exactly how three genuinely-unreachable rooms -- 1407, 1408, 1409 --
 * went undetected: the old version of this test asserted only `success`.) So this test
 * asserts two independent things per room, either of which alone would have caught it:
 *   (a) the path's FINAL point actually lands at (or very near) the requested target --
 *       not just "some point on the way there", and
 *   (b) `Detour.DT_PARTIAL_RESULT` is NOT set on the raw status `NavMeshQuery.findPath`
 *       returns for the same start/end polygons `computePath` resolves internally --
 *       recast-navigation exports this flag (`Detour.DT_PARTIAL_RESULT` + `statusDetail`),
 *       so this checks the library's own "did I actually get there" signal directly,
 *       rather than only inferring it from geometry.
 *
 * Run with: npx tsx src/nav/__tests__/buildNavMesh.test.ts
 */
import assert from "node:assert/strict";

import { Detour, statusDetail } from "recast-navigation";

import { buildNavMesh } from "../buildNavMesh.js";
import { loadFloorPlan } from "../loadFloorPlan.js";
import { AGENT_RADIUS_M } from "../agentProfile.js";

const DOOR_SNAP_TOLERANCE_M = 1.0;
const MIN_REACHABLE_ROOMS = 3;

// A genuinely-arrived path's final point should land within a few centimeters of the
// requested target (computePath clamps the straight path to the target itself when the
// target's polygon is reached, so a real arrival is ~0.00m in practice -- see the
// 2026-08-02 investigation). A PARTIAL path, by contrast, stops wherever the reachable
// region runs out, which was 1.1m-2.7m short for the three real dead-end rooms found here
// -- multiple meters, not centimeters. AGENT_RADIUS_M (the footprint the navmesh itself
// was eroded for) is the natural yardstick for "close enough to have arrived": twice the
// agent's own radius (its diameter) is generous enough to absorb polygon-snap/floating-
// point noise while staying an order of magnitude tighter than any partial-path shortfall
// actually observed.
const ARRIVAL_TOLERANCE_M = AGENT_RADIUS_M * 2;

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const { navMeshQuery, findRoomTarget } = await buildNavMesh(plan);

  // --- findRoomTarget: bare number vs. full name, both case variants required by the task ---
  const room1425 = plan.rooms.find((r) => r.name === "Classroom 1425");
  assert.ok(room1425, "floor-14.json should contain a room named 'Classroom 1425'");
  const [doorX, doorZ] = room1425.door;

  for (const query of ["1425", "Classroom 1425", "classroom 1425"]) {
    const target = findRoomTarget(query);
    assert.ok(target, `findRoomTarget(${JSON.stringify(query)}) should resolve to a point`);
    const dist = Math.hypot(target.x - doorX, target.z - doorZ);
    assert.ok(
      dist <= DOOR_SNAP_TOLERANCE_M,
      `findRoomTarget(${JSON.stringify(query)}) resolved to (${target.x.toFixed(2)}, ${target.z.toFixed(2)}), ` +
        `expected within ${DOOR_SNAP_TOLERANCE_M}m of the door (${doorX}, ${doorZ}); got ${dist.toFixed(2)}m`,
    );
  }
  console.log('PASS: findRoomTarget("1425"), findRoomTarget("Classroom 1425"), and a lowercase ' +
    "variant all resolve near the door coordinate");

  assert.equal(
    findRoomTarget("this room does not exist"),
    null,
    "an unknown room name/alias should return null",
  );
  console.log("PASS: findRoomTarget returns null for an unknown name");

  // --- path reachability: entrance -> every room's door ---
  const entrancePoint = { x: plan.entrance.point[0], y: 0, z: plan.entrance.point[1] };
  const entranceSnap = navMeshQuery.findClosestPoint(entrancePoint);
  assert.ok(
    entranceSnap.success,
    `entrance point (${entrancePoint.x}, ${entrancePoint.z}) should snap onto the navmesh`,
  );

  interface RoomResult {
    name: string;
    door: [number, number];
    success: boolean;
    reason: string;
    pathPoints: number;
    finalDistM: number;
    partialResult: boolean;
  }

  const results: RoomResult[] = [];

  for (const room of plan.rooms) {
    const target = findRoomTarget(room.name);
    if (!target) {
      results.push({
        name: room.name,
        door: room.door,
        success: false,
        reason: "door point did not snap onto the navmesh (findClosestPoint failed)",
        pathPoints: 0,
        finalDistM: NaN,
        partialResult: false,
      });
      continue;
    }
    const targetPoint = { x: target.x, y: 0, z: target.z };

    const { success, error, path } = navMeshQuery.computePath(entranceSnap.point, targetPoint);

    // Check (a): does the path's final point actually land at the target?
    const lastPoint = path[path.length - 1];
    const finalDistM = lastPoint
      ? Math.hypot(lastPoint.x - targetPoint.x, lastPoint.z - targetPoint.z)
      : NaN;
    const arrived = success && path.length > 0 && finalDistM <= ARRIVAL_TOLERANCE_M;

    // Check (b), belt-and-braces: ask Detour directly, via the same findNearestPoly ->
    // findPath sequence computePath uses internally, whether it flagged this a PARTIAL
    // result -- recast-navigation's computePath wrapper computes this but never returns
    // it, so we recompute it here rather than trust only the geometric distance check.
    const startNear = navMeshQuery.findNearestPoly(entranceSnap.point);
    const endNear = navMeshQuery.findNearestPoly(targetPoint);
    let partialResult = false;
    if (startNear.success && endNear.success) {
      const findPathResult = navMeshQuery.findPath(
        startNear.nearestRef,
        endNear.nearestRef,
        entranceSnap.point,
        targetPoint,
      );
      partialResult = statusDetail(findPathResult.status, Detour.DT_PARTIAL_RESULT);
      findPathResult.polys.destroy();
    }

    const ok = arrived && !partialResult;
    let reason: string;
    if (ok) {
      reason = "ok";
    } else if (!success) {
      reason = `computePath failed (${error?.name ?? "unknown error"})`;
    } else if (path.length === 0) {
      reason = "computePath succeeded but returned an empty path";
    } else if (partialResult) {
      reason = `Detour flagged this a PARTIAL result (DT_PARTIAL_RESULT set) -- target polygon unreachable, final point ${finalDistM.toFixed(2)}m short`;
    } else {
      reason = `path's final point is ${finalDistM.toFixed(2)}m from the target, exceeds the ${ARRIVAL_TOLERANCE_M}m arrival tolerance`;
    }

    results.push({
      name: room.name,
      door: room.door,
      success: ok,
      reason,
      pathPoints: path.length,
      finalDistM,
      partialResult,
    });
  }

  console.log(
    `\nRoom reachability from entrance (entrance -> room door, via computePath; arrival tolerance ${ARRIVAL_TOLERANCE_M}m = 2x AGENT_RADIUS_M):`,
  );
  for (const r of results) {
    console.log(
      `  [${r.success ? "PASS" : "FAIL"}] ${r.name} door=[${r.door[0]}, ${r.door[1]}] -- ${r.reason} ` +
        `(path points: ${r.pathPoints}, final-point distance: ${r.finalDistM.toFixed(2)}m, partial=${r.partialResult})`,
    );
  }

  const passing = results.filter((r) => r.success);
  const failing = results.filter((r) => !r.success);

  console.log(`\n${passing.length}/${results.length} rooms reachable from entrance.`);
  if (failing.length > 0) {
    console.log(
      "NOT reachable -- likely a wall-gap issue in floor-14.json for these rooms " +
        "(cross-check against the wall segment notes for each room):",
    );
    for (const r of failing) {
      console.log(`  - ${r.name}: door=[${r.door[0]}, ${r.door[1]}] :: ${r.reason}`);
    }
  }

  // Task 1.1's required minimum proof is that at least 3 different rooms path from the
  // entrance (floor-14.json's coordinates were eyeballed from an image, not measured, so a
  // wall-gap bug in the data was a real possibility -- this test's job is to surface it
  // precisely, not hide behind a weaker assertion). As of this writing all 18/18 rooms in
  // floor-14.json are actually reachable, so this asserts the full acceptance bar ("all room
  // doors path-reachable from the entrance") rather than settling for the minimum: if a
  // future edit to floor-14.json's walls breaks a door's connection to the corridor, this
  // test should fail loudly and name the room, not silently regress to "just barely 3".
  // If this ever fails: that is a floor-14.json wall-gap bug, fixed by whoever owns that
  // file's source floor-plan images -- NOT by editing this test or this module's code.
  assert.ok(
    passing.length >= MIN_REACHABLE_ROOMS,
    `expected at least ${MIN_REACHABLE_ROOMS} rooms reachable from the entrance, got ${passing.length}/${results.length}`,
  );
  assert.equal(
    failing.length,
    0,
    `expected all ${results.length} rooms reachable from the entrance; ${failing.length} failed: ` +
      failing.map((r) => r.name).join(", "),
  );
  console.log(
    `PASS: all ${results.length}/${results.length} rooms are path-reachable from the entrance`,
  );

  console.log("\nALL PASS: buildNavMesh.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
