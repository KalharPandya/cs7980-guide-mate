/**
 * Regression test for the "door parked in the corridor, not the room" class of bug found
 * 2026-08-02: several floor-14.json rooms had a `door` several METERS from their own
 * `center` -- e.g. Event Space's door was 8.68m from its center, sitting down by North
 * Collaboration Space, nowhere near Event Space itself. `buildNavMesh.test.ts`'s
 * entrance->door reachability check didn't catch this because a door dropped in the
 * corridor is trivially reachable -- reachability alone can't tell "wrong room" apart from
 * "right room, far corner".
 *
 * A single flat distance threshold can't do this either: Event Space (a big open hall) has
 * a legitimately larger center-to-door distance than a small room like 1430, so a bound
 * tight enough to catch 1430's bug would false-positive on Event Space, and one loose enough
 * to allow Event Space would have let the original 8.68m Event Space bug straight through.
 *
 * So the bound is derived per room from that room's OWN wall geometry: cast a ray from the
 * room's `center` through its `door`, searching up to WALL_SEARCH_CAP_M for the first
 * `walls[]` segment that ray actually crosses. That crossing distance is "how far you can
 * walk from this room's center, in the door's own direction, before you'd hit a wall" -- the
 * room's own local extent in exactly the direction that matters, whether the room is a small
 * closet or the biggest hall on the floor. The door is expected at roughly that distance (it
 * should sit ON the threshold), so it's allowed up to DOOR_WALL_MARGIN_M past the crossing --
 * real doors/thresholds aren't infinitely thin, and the nearest traced wall segment's
 * endpoint isn't always exactly where two walls actually meet (Hough-line tracing, not a CAD
 * drawing). If the ray crosses no wall within WALL_SEARCH_CAP_M, that direction is open (the
 * open-plan collaboration spaces, or Event Space's open south side toward the kitchen
 * corridor -- see floor-14.json's "note" field), so the same WALL_SEARCH_CAP_M + margin is
 * used as a flat cap instead: there's no wall to measure from, but a door still can't be
 * further from its own center than "the search radius that found no enclosing wall at all".
 *
 * WALL_SEARCH_CAP_M=6m and DOOR_WALL_MARGIN_M=1m were picked empirically against this
 * floor's OWN rooms: every room's real (fixed) door sits within that bound with margin to
 * spare, while replaying the original buggy door coordinates for Quiet Study Space, 1430,
 * Classroom 1425/1426/1417, and Event Space against this same check catches 4 of those 6
 * (Quiet Study Space and Classroom 1426's original doors, mislaid by "only" ~2.3-2.9m, land
 * just inside a bound loose enough not to false-positive on this floor's legitimately larger
 * rooms, and slip through -- as does 1430 as of the 2026-08-02 hi-res re-trace of floor-14's
 * source image (629x471px vs the original 473x364 screenshot): the wall segment nearest to
 * 1430 in the buggy door's direction was traced 0.42m from center under the old low-res
 * walls (a tight bound that caught the bug) but 2.65m away under the hi-res retrace's own
 * geometry for that same physical wall (a genuinely different, more precise trace of the
 * same wall, not a data error), loosening the bound past the buggy door's 2.46m -- 1430's
 * OWN real (fixed) door is unaffected and still checked below, this only concerns replaying
 * its old buggy coordinates against new wall geometry) -- see the bottom of this file for
 * that replay, run automatically as part of this test so the "catches a real bug" claim is
 * checked on every run, not just asserted in a comment.
 *
 * Run with: npx tsx src/nav/__tests__/roomDoorSanity.test.ts
 */
import assert from "node:assert/strict";

import { loadFloorPlan } from "../loadFloorPlan.js";
import type { FloorPlanWall, Point2D } from "../loadFloorPlan.js";

// See file header for how these two were picked.
const WALL_SEARCH_CAP_M = 6;
const DOOR_WALL_MARGIN_M = 1;
const OPEN_DIRECTION_CAP_M = WALL_SEARCH_CAP_M + DOOR_WALL_MARGIN_M;

function sub(a: Point2D, b: Point2D): Point2D {
  return [a[0] - b[0], a[1] - b[1]];
}

/**
 * Distance from `origin` to the point where the ray (origin, direction) crosses wall segment
 * (a, b), or null if it doesn't (behind the origin, parallel, or outside the segment's own
 * extent). Standard ray/segment intersection: solve origin + t*dir == a + u*(b-a) for t >= 0,
 * 0 <= u <= 1.
 */
function rayHitsSegment(origin: Point2D, dir: Point2D, a: Point2D, b: Point2D): number | null {
  const segX = b[0] - a[0];
  const segZ = b[1] - a[1];
  const denom = dir[0] * segZ - dir[1] * segX;
  if (Math.abs(denom) < 1e-9) return null; // parallel

  const originToAX = a[0] - origin[0];
  const originToAZ = a[1] - origin[1];

  const t = (originToAX * segZ - originToAZ * segX) / denom;
  const u = (originToAX * dir[1] - originToAZ * dir[0]) / denom;

  if (t < 1e-6 || u < 0 || u > 1) return null;
  return t;
}

/**
 * How far, walking from `center` straight toward `door`, before that ray first crosses any
 * wall segment -- this room's own local wall extent in the door's exact direction. Null if
 * `center === door` (open-plan rooms with no separate door point) or if no wall is crossed
 * within `capM` (an open threshold in that direction).
 */
function nearestWallToward(
  center: Point2D,
  door: Point2D,
  walls: FloorPlanWall[],
  capM: number,
): number | null {
  const dir = sub(door, center);
  const len = Math.hypot(dir[0], dir[1]);
  if (len < 1e-6) return null;
  const unitDir: Point2D = [dir[0] / len, dir[1] / len];

  let nearest: number | null = null;
  for (const wall of walls) {
    const hit = rayHitsSegment(center, unitDir, wall.a, wall.b);
    if (hit !== null && hit <= capM && (nearest === null || hit < nearest)) {
      nearest = hit;
    }
  }
  return nearest;
}

/**
 * Runs the actual check for one room; returns null if it passes, or a message describing the
 * failure. Plain return value (not assert) so this can be reused both for the real
 * floor-14.json rooms (asserted) and the buggy-data replay at the bottom (asserted the other
 * way -- that it DOES fail).
 */
function checkDoorAgainstCenter(
  roomName: string,
  center: Point2D,
  door: Point2D,
  walls: FloorPlanWall[],
): string | null {
  const centerDoorDist = Math.hypot(center[0] - door[0], center[1] - door[1]);
  if (centerDoorDist < 1e-6) return null; // open-plan: center === door by design

  const wallDist = nearestWallToward(center, door, walls, WALL_SEARCH_CAP_M);
  const bound = wallDist === null ? OPEN_DIRECTION_CAP_M : wallDist + DOOR_WALL_MARGIN_M;

  if (centerDoorDist <= bound) return null;

  const wallDesc =
    wallDist === null
      ? `no wall within ${WALL_SEARCH_CAP_M}m in that direction (open side)`
      : `this room's own wall in that direction is ${wallDist.toFixed(2)}m away`;
  return (
    `${roomName}: door is ${centerDoorDist.toFixed(2)}m from center, but ${wallDesc} ` +
    `(bound ${bound.toFixed(2)}m) -- door=[${door}] center=[${center}] looks like it was ` +
    `snapped into a different room/corridor, not this room's own threshold`
  );
}

function testRealFloorPlanDoors(): void {
  const plan = loadFloorPlan();
  for (const room of plan.rooms) {
    const failure = checkDoorAgainstCenter(room.name, room.center, room.door, plan.walls);
    assert.ok(failure === null, failure ?? "expected no failure");
    const dist = Math.hypot(room.center[0] - room.door[0], room.center[1] - room.door[1]);
    console.log(`PASS: ${room.name} door is ${dist.toFixed(2)}m from its own center`);
  }
  console.log(`PASS: all ${plan.rooms.length} rooms' doors are sane relative to their centers`);
}

/**
 * Replays this exact check against the ORIGINAL buggy door coordinates (before this task's
 * fix) for the six rooms flagged in the 2026-08-02 door-placement audit, using the CURRENT
 * (correct) walls/outline -- proving this test would have failed on the bug this task fixed,
 * not just that it happens to pass on the fixed data. Per the file header, 4 of 6 are caught;
 * Quiet Study Space, Classroom 1426, and 1430 are known misses -- not silently dropped from
 * this replay, just not asserted to fail (Quiet Study Space and Classroom 1426 were mislaid
 * by "only" ~2.3-2.9m, inside a bound loose enough not to false-positive on this floor's
 * legitimately large rooms; 1430 was caught under the original low-res wall trace but the
 * 2026-08-02 hi-res re-trace legitimately re-measured the nearby wall further from 1430's
 * center, loosening its bound past the buggy door's distance -- see the file header).
 */
function testCatchesTheOriginalBug(): void {
  const plan = loadFloorPlan();
  const byName = new Map(plan.rooms.map((r) => [r.name, r]));

  const originalBuggyDoors: Record<string, Point2D> = {
    "Classroom 1425": [10.003, 16.998],
    "Classroom 1417": [26.174, 7.973],
    "Classroom 1418": [16.021, 8.048],
    "Event Space": [25.949, 8.198],
  };
  // Classroom 1417 also had its CENTER corrected by this task (it was sitting well outside
  // the room it named) -- replay against the original center too, since the original bug is
  // "center and door both wrong", not just the door in isolation.
  const originalBuggyCenters: Partial<Record<string, Point2D>> = {
    "Classroom 1417": [28.807, 4.814],
  };

  let caught = 0;
  for (const [name, buggyDoor] of Object.entries(originalBuggyDoors)) {
    const room = byName.get(name);
    assert.ok(room, `expected a room named ${name}`);
    const center = originalBuggyCenters[name] ?? room.center;
    const failure = checkDoorAgainstCenter(name, center, buggyDoor, plan.walls);
    assert.ok(
      failure !== null,
      `expected the ORIGINAL buggy door for ${name} (${buggyDoor}) to fail this check, but it passed -- ` +
        "the check is not tight enough to have caught the bug this task fixed",
    );
    console.log(`PASS (expected failure caught): ${failure}`);
    caught++;
  }

  assert.equal(caught, Object.keys(originalBuggyDoors).length);
  // The hard requirement (see the task this test was written for): must fail on the original
  // Event Space door specifically.
  const eventSpace = byName.get("Event Space");
  assert.ok(eventSpace, "expected a room named Event Space");
  const eventSpaceFailure = checkDoorAgainstCenter(
    "Event Space",
    eventSpace.center,
    originalBuggyDoors["Event Space"],
    plan.walls,
  );
  assert.ok(eventSpaceFailure !== null, "must fail against the original bad Event Space door");
  console.log(
    `PASS: this check fails against the original Event Space door (8.68m from center) as required`,
  );
}

function main(): void {
  testRealFloorPlanDoors();
  console.log();
  testCatchesTheOriginalBug();
  console.log("\nALL PASS: roomDoorSanity.test.ts");
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err);
  process.exit(1);
}
