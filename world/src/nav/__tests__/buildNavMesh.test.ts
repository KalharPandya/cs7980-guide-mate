/**
 * End-to-end navmesh tests: build once from the real floor-14.json, then prove
 *   1. findRoomTarget resolves both a bare room number ("1425") and the full name
 *      ("Classroom 1425") to a point near the door coordinate in the JSON, and
 *   2. computePath from the entrance to multiple rooms' doors actually succeeds --
 *      this is the real proof the doors connect to the corridor, not just that the
 *      navmesh built without throwing.
 *
 * Per Task 1.1's instructions: if a room's door doesn't path from the entrance, that is
 * reported here as a real, specific finding (room name + door coordinate) rather than
 * silently worked around -- it's a floor-14.json wall-gap data issue, not a bug in this
 * code, and floor-14.json is NOT edited by this task to compensate.
 *
 * Run with: npx tsx src/nav/__tests__/buildNavMesh.test.ts
 */
import assert from "node:assert/strict";

import { buildNavMesh } from "../buildNavMesh.js";
import { loadFloorPlan } from "../loadFloorPlan.js";

const DOOR_SNAP_TOLERANCE_M = 1.0;
const MIN_REACHABLE_ROOMS = 3;

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
      });
      continue;
    }

    const { success, error, path } = navMeshQuery.computePath(entranceSnap.point, {
      x: target.x,
      y: 0,
      z: target.z,
    });

    const ok = success && path.length > 0;
    results.push({
      name: room.name,
      door: room.door,
      success: ok,
      reason: ok
        ? "ok"
        : success
          ? "computePath succeeded but returned an empty path"
          : `computePath failed (${error?.name ?? "unknown error"})`,
      pathPoints: path.length,
    });
  }

  console.log("\nRoom reachability from entrance (entrance -> room door, via computePath):");
  for (const r of results) {
    console.log(
      `  [${r.success ? "PASS" : "FAIL"}] ${r.name} door=[${r.door[0]}, ${r.door[1]}] -- ${r.reason} ` +
        `(path points: ${r.pathPoints})`,
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
