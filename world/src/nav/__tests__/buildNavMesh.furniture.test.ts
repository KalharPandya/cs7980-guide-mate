/**
 * Furniture-obstacle navmesh test. Proves the two things that make furniture safe to carve into
 * the navmesh (so robots/visitors route AROUND it) rather than leaving it render-only:
 *
 *   1. GRIDLOCK SAFETY: with the selected furniture obstacles carved in, EVERY room is still
 *      path-reachable from the entrance with no Detour PARTIAL result -- the exact same gate
 *      buildNavMesh.test.ts applies to the bare navmesh, re-run here on the furnished one. An
 *      obstacle that closed a doorway or filled a small room would fail this loudly and name the
 *      room, instead of silently gridlocking the sim.
 *   2. FURNITURE IS SOLID: a point inside a known included-furniture footprint is NOT reachable
 *      from the entrance (Detour returns a PARTIAL path / the path stops short) -- i.e. an agent
 *      is routed around it, not through it. This is the whole point of the change; without it the
 *      obstacle would be cosmetic in the navmesh too.
 *
 * Plus a unit check on the pure selection logic (inset + skip), and a report of how many of the
 * ~96 items were included vs skipped and why.
 *
 * Run with: npx tsx src/nav/__tests__/buildNavMesh.furniture.test.ts
 */
import assert from "node:assert/strict";

import { Detour, statusDetail } from "recast-navigation";

import { buildNavMesh } from "../buildNavMesh.js";
import { loadFloorPlan } from "../loadFloorPlan.js";
import {
  loadFurniture,
  selectFurnitureObstacles,
  furnitureFootprint,
  FURNITURE_INSET_M,
} from "../loadFurniture.js";
import { AGENT_RADIUS_M } from "../agentProfile.js";

const ARRIVAL_TOLERANCE_M = AGENT_RADIUS_M * 2;

/** True if a path from `entrance` genuinely ARRIVES at `target` (not PARTIAL, lands on target). */
function arrives(
  navMeshQuery: import("recast-navigation").NavMeshQuery,
  entrance: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): { arrived: boolean; partial: boolean; finalDistM: number } {
  const { success, path } = navMeshQuery.computePath(entrance, target);
  const last = path[path.length - 1];
  const finalDistM = last ? Math.hypot(last.x - target.x, last.z - target.z) : NaN;
  const arrived = success && path.length > 0 && finalDistM <= ARRIVAL_TOLERANCE_M;

  const startNear = navMeshQuery.findNearestPoly(entrance);
  const endNear = navMeshQuery.findNearestPoly(target);
  let partial = false;
  if (startNear.success && endNear.success) {
    const fp = navMeshQuery.findPath(startNear.nearestRef, endNear.nearestRef, entrance, target);
    partial = statusDetail(fp.status, Detour.DT_PARTIAL_RESULT);
    fp.polys.destroy();
  }
  return { arrived: arrived && !partial, partial, finalDistM };
}

function testSelectionIsPure(): void {
  const plan = loadFloorPlan();
  const furniture = loadFurniture();
  const selection = selectFurnitureObstacles(furniture, plan);

  assert.equal(
    selection.decisions.length,
    furniture.items.length,
    "one decision per furniture item",
  );
  assert.equal(
    selection.obstacles.length,
    selection.decisions.filter((d) => d.included).length,
    "obstacle count must equal the number of included decisions",
  );
  assert.ok(selection.obstacles.length > 0, "at least some furniture must be carved in");

  // Every included obstacle is a non-degenerate 4-corner polygon strictly smaller than the raw
  // footprint (the inset actually shrank it).
  for (const d of selection.decisions) {
    if (!d.included) continue;
    const item = furniture.items[d.index];
    const inset = furnitureFootprint(item, FURNITURE_INSET_M);
    const raw = furnitureFootprint(item, 0);
    assert.equal(inset.length, 4, "footprint is a quad");
    const insetLong = Math.hypot(inset[0][0] - inset[1][0], inset[0][1] - inset[1][1]);
    const rawLong = Math.hypot(raw[0][0] - raw[1][0], raw[0][1] - raw[1][1]);
    assert.ok(insetLong < rawLong, "inset footprint must be smaller than the raw one");
    assert.ok(insetLong > 0, "inset footprint must have positive extent");
  }
  console.log(
    `PASS: selection is pure/consistent (${selection.obstacles.length} obstacles, all non-degenerate and inset)`,
  );
}

async function main(): Promise<void> {
  testSelectionIsPure();

  const plan = loadFloorPlan();
  const furniture = loadFurniture();
  const selection = selectFurnitureObstacles(furniture, plan);

  const included = selection.decisions.filter((d) => d.included);
  const skipped = selection.decisions.filter((d) => !d.included);
  console.log(
    `\nFurniture obstacle selection: ${included.length}/${furniture.items.length} included, ` +
      `${skipped.length} skipped (inset ${FURNITURE_INSET_M}m/side).`,
  );

  const { navMeshQuery, findRoomTarget } = await buildNavMesh(plan, {
    furnitureObstacles: selection.obstacles,
  });

  // --- 1. GRIDLOCK SAFETY: every room still reachable, no PARTIAL, with furniture carved in. ---
  const entranceSnap = navMeshQuery.findClosestPoint({
    x: plan.entrance.point[0],
    y: 0,
    z: plan.entrance.point[1],
  });
  assert.ok(entranceSnap.success, "entrance point should snap onto the furnished navmesh");

  const failing: string[] = [];
  for (const room of plan.rooms) {
    const target = findRoomTarget(room.name);
    if (!target) {
      failing.push(`${room.name}: door did not snap onto the navmesh`);
      continue;
    }
    const res = arrives(navMeshQuery, entranceSnap.point, { x: target.x, y: 0, z: target.z });
    if (!res.arrived) {
      failing.push(
        `${room.name}: not reachable with furniture (partial=${res.partial}, ` +
          `final ${res.finalDistM.toFixed(2)}m short)`,
      );
    }
  }
  assert.equal(
    failing.length,
    0,
    `expected all ${plan.rooms.length} rooms reachable WITH furniture obstacles; failed:\n  ` +
      failing.join("\n  "),
  );
  console.log(
    `PASS: all ${plan.rooms.length}/${plan.rooms.length} rooms still path-reachable with furniture carved in (no PARTIAL)`,
  );

  // --- 2. FURNITURE IS SOLID: a known included item's interior is NOT reachable (routed around). ---
  // Use the largest-area included item: its interior is the most unambiguously enclosed, so a
  // failure here is a real "agents can walk through furniture" regression, not floating-point noise.
  const includedItems = included.map((d) => ({ index: d.index, item: furniture.items[d.index] }));
  includedItems.sort((a, b) => b.item.size[0] * b.item.size[1] - a.item.size[0] * a.item.size[1]);
  const probe = includedItems[0].item;
  const probeCenter = { x: probe.center[0], y: 0, z: probe.center[1] };
  const probeRes = arrives(navMeshQuery, entranceSnap.point, probeCenter);
  assert.ok(
    !probeRes.arrived,
    `a point inside furniture item ${includedItems[0].index} (center [${probe.center}], ` +
      `size [${probe.size}]) should NOT be reachable from the entrance (agents route around it), ` +
      `but a path arrived there (partial=${probeRes.partial}, final ${probeRes.finalDistM.toFixed(2)}m)`,
  );
  console.log(
    `PASS: interior of the largest carved furniture item (center [${probe.center}], size [${probe.size}]) ` +
      `is NOT reachable from the entrance (partial=${probeRes.partial}) -- agents route around it`,
  );

  // Belt-and-braces: the SAME point is walkable on the BARE navmesh, proving the obstacle (not the
  // floor plan) is what makes it unreachable -- otherwise a point that was never walkable would
  // pass the assertion above for the wrong reason.
  const bare = await buildNavMesh(plan);
  const bareRes = arrives(bare.navMeshQuery, entranceSnap.point, probeCenter);
  assert.ok(
    bareRes.arrived,
    `sanity: the probe point should be reachable on the BARE navmesh (it is only the furniture ` +
      `obstacle that blocks it); got partial=${bareRes.partial}, final ${bareRes.finalDistM.toFixed(2)}m`,
  );
  console.log(
    "PASS: the same interior point IS reachable on the bare navmesh -- the furniture obstacle is what blocks it",
  );

  // --- Report: included vs skipped, with reasons grouped. ---
  console.log(`\nSkipped ${skipped.length} items:`);
  const grouped = new Map<string, number>();
  for (const d of skipped) {
    const bucket = d.reason.startsWith("degenerate")
      ? "degenerate after inset (dimension <= 0)"
      : d.reason.startsWith("short side")
        ? "sliver (short side below min)"
        : d.reason.startsWith("footprint is")
          ? "too close to a door/entrance (would pinch the doorway)"
          : d.reason;
    grouped.set(bucket, (grouped.get(bucket) ?? 0) + 1);
  }
  for (const [reason, count] of grouped) console.log(`  ${count}: ${reason}`);

  bare.navMesh.destroy();
  bare.navMeshQuery.destroy();

  console.log("\nALL PASS: buildNavMesh.furniture.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
