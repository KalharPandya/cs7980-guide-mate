/**
 * Unit tests for loadFloorPlan.ts: schema validation and the real floor-14.json data.
 * Plain node:assert script, run with tsx -- matches the existing convention in
 * src/test/join.test.ts (no test framework dependency added for this).
 *
 * Run with: npx tsx src/nav/__tests__/loadFloorPlan.test.ts
 */
import assert from "node:assert/strict";

import { DEFAULT_FLOOR_PLAN_PATH, loadFloorPlan, validateFloorPlan } from "../loadFloorPlan.js";

function testLoadsRealFloorPlan(): void {
  const plan = loadFloorPlan();
  assert.equal(plan.units, "meters");
  assert.equal(plan.floor, 14);
  assert.ok(plan.walkableOutline.length >= 3, "walkableOutline should have >= 3 points");
  assert.ok(plan.rooms.length > 0, "rooms should be non-empty");
  assert.ok(plan.walls.length > 0, "walls should be non-empty");
  assert.ok(
    plan.rooms.some((r) => r.name === "Classroom 1425" && r.aliases?.includes("1425")),
    "Classroom 1425 with alias 1425 should be present",
  );
  console.log(`PASS: loadFloorPlan() loaded ${DEFAULT_FLOOR_PLAN_PATH}`);
}

function testExplicitPathMatchesDefault(): void {
  const plan = loadFloorPlan(DEFAULT_FLOOR_PLAN_PATH);
  assert.equal(plan.floor, 14);
  console.log("PASS: loadFloorPlan(explicit path) matches default");
}

function testRejectsMissingRequiredField(): void {
  const validSubset = {
    units: "meters",
    floor: 14,
    walkableOutline: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    holes: [],
    walls: [],
    rooms: [],
    entrance: { name: "entrance", point: [0, 0] },
  };

  // Sanity: the valid subset itself should validate.
  validateFloorPlan(validSubset);

  const missingWalls = { ...validSubset } as Record<string, unknown>;
  delete missingWalls.walls;
  assert.throws(
    () => validateFloorPlan(missingWalls),
    /walls/,
    "should throw mentioning the missing 'walls' field",
  );
  console.log("PASS: validateFloorPlan rejects a missing required field (walls)");
}

function testRejectsMalformedPoint(): void {
  const bad = {
    units: "meters",
    floor: 14,
    walkableOutline: [
      [0, 0],
      [1, 0],
      ["not-a-number", 1],
    ],
    holes: [],
    walls: [],
    rooms: [],
    entrance: { name: "entrance", point: [0, 0] },
  };
  assert.throws(
    () => validateFloorPlan(bad),
    /walkableOutline/,
    "should throw mentioning the malformed walkableOutline point",
  );
  console.log("PASS: validateFloorPlan rejects a malformed [x, z] point");
}

function testRejectsTooFewOutlinePoints(): void {
  const bad = {
    units: "meters",
    floor: 14,
    walkableOutline: [
      [0, 0],
      [1, 0],
    ],
    holes: [],
    walls: [],
    rooms: [],
    entrance: { name: "entrance", point: [0, 0] },
  };
  assert.throws(
    () => validateFloorPlan(bad),
    /walkableOutline/,
    "should throw: a 2-point outline can't form a polygon",
  );
  console.log("PASS: validateFloorPlan rejects a walkableOutline with < 3 points");
}

function main(): void {
  testLoadsRealFloorPlan();
  testExplicitPathMatchesDefault();
  testRejectsMissingRequiredField();
  testRejectsMalformedPoint();
  testRejectsTooFewOutlinePoints();
  console.log("ALL PASS: loadFloorPlan.test.ts");
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err);
  process.exit(1);
}
