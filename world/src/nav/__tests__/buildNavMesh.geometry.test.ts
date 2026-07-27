/**
 * Pure-logic unit tests for the earcut triangulation + wall-quad winding in buildNavMesh.ts,
 * isolated from recast-navigation's WASM (no `init()`/`generateSoloNavMesh` call here -- see
 * buildNavMesh.test.ts for the end-to-end navmesh + pathfinding tests). Catches winding-order
 * regressions fast and without a WASM boot.
 *
 * Run with: npx tsx src/nav/__tests__/buildNavMesh.geometry.test.ts
 */
import assert from "node:assert/strict";

import { __internal } from "../buildNavMesh.js";
import type { FloorPlan } from "../loadFloorPlan.js";

const { buildGeometry } = __internal;

/** A simple 4x4 square room with a 1x1 hole in the middle, plus one wall. */
function samplePlan(): FloorPlan {
  return {
    units: "meters",
    floor: 1,
    walkableOutline: [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
    holes: [
      {
        name: "test-hole",
        polygon: [
          [1.5, 1.5],
          [2.5, 1.5],
          [2.5, 2.5],
          [1.5, 2.5],
        ],
      },
    ],
    walls: [{ a: [0, 0], b: [4, 0], height: 2.7, glass: false }],
    rooms: [],
    entrance: { name: "entrance", point: [2, 0] },
  };
}

/**
 * Cross product y-component for a 3D triangle whose points all have y=0.
 * Positive means the face normal points up (+Y) -- Recast's required orientation for a
 * walkable floor.
 */
function normalY(
  positions: number[],
  i0: number,
  i1: number,
  i2: number,
): number {
  const p0x = positions[i0 * 3];
  const p0z = positions[i0 * 3 + 2];
  const p1x = positions[i1 * 3];
  const p1z = positions[i1 * 3 + 2];
  const p2x = positions[i2 * 3];
  const p2z = positions[i2 * 3 + 2];
  return (p1z - p0z) * (p2x - p0x) - (p1x - p0x) * (p2z - p0z);
}

function testFloorTrianglesFaceUp(): void {
  const plan = samplePlan();
  const { positions, indices } = buildGeometry(plan);

  // Floor triangles come first; the one wall contributes exactly 2 triangles (6 indices) at
  // the end, so everything before the last 6 indices is floor.
  const floorIndexCount = indices.length - 6;
  assert.ok(floorIndexCount > 0, "expected at least one floor triangle");

  for (let t = 0; t < floorIndexCount; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    const n = normalY(positions, i0, i1, i2);
    assert.ok(
      n > 0,
      `floor triangle at index ${t} faces down (normalY=${n}), expected an upward-facing (+Y) triangle`,
    );
  }
  console.log(`PASS: all ${floorIndexCount / 3} floor triangles face up (+Y)`);
}

function testHoleIsExcludedFromFloor(): void {
  const plan = samplePlan();
  const { positions, indices } = buildGeometry(plan);

  // Sample the hole's center (2, 0, 2) -- no floor triangle should cover it.
  // A point-in-triangle test against every floor triangle (XZ projection).
  const floorIndexCount = indices.length - 6;
  const holeCenter = { x: 2, z: 2 };

  const sign = (ax: number, az: number, bx: number, bz: number, px: number, pz: number) =>
    (px - bx) * (az - bz) - (ax - bx) * (pz - bz);

  const pointInTriangle = (
    px: number,
    pz: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
  ) => {
    const d1 = sign(ax, az, bx, bz, px, pz);
    const d2 = sign(bx, bz, cx, cz, px, pz);
    const d3 = sign(cx, cz, ax, az, px, pz);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  let coveredByFloor = false;
  for (let t = 0; t < floorIndexCount; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    const ax = positions[i0 * 3];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cz = positions[i2 * 3 + 2];
    if (pointInTriangle(holeCenter.x, holeCenter.z, ax, az, bx, bz, cx, cz)) {
      coveredByFloor = true;
      break;
    }
  }

  assert.equal(coveredByFloor, false, "the hole's center should not be covered by any floor triangle");
  console.log("PASS: the hole polygon is excluded from the floor triangulation");
}

function testWallQuadGeometry(): void {
  const plan = samplePlan();
  const { positions, indices } = buildGeometry(plan);

  // Last 6 indices are the one wall's 2 triangles; last 4 vertices (12 floats) are its quad.
  const wallVertexStart = positions.length / 3 - 4;
  const wallPositions = positions.slice(wallVertexStart * 3);

  assert.equal(wallPositions.length, 12, "wall should contribute exactly 4 vertices (12 floats)");

  // v0=(0,0,0), v1=(4,0,0), v2=(4,2.7,0), v3=(0,2.7,0)
  assert.deepEqual(wallPositions, [0, 0, 0, 4, 0, 0, 4, 2.7, 0, 0, 2.7, 0]);

  const wallIndices = indices.slice(indices.length - 6).map((i) => i - wallVertexStart);
  assert.deepEqual(wallIndices, [0, 1, 2, 0, 2, 3]);
  console.log("PASS: wall quad has correct 4 vertices and 2-triangle winding");
}

function main(): void {
  testFloorTrianglesFaceUp();
  testHoleIsExcludedFromFloor();
  testWallQuadGeometry();
  console.log("ALL PASS: buildNavMesh.geometry.test.ts");
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err);
  process.exit(1);
}
