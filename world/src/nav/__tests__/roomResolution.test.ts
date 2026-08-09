/**
 * Forgiving room-name resolution (`findRoomTarget`).
 *
 * Regression guard for a bug found by live end-to-end testing of Moses: the model said
 * "Classroom 1408" but the room is named "1408" (aliases only "room 1408"), so the old
 * exact-only lookup returned null and the visitor got a failure. Both the LLM and real
 * visitors fuzz room names, so resolution has to forgive case, whitespace, trailing
 * punctuation, a leading "the", the generic words room/classroom/space, a plain room number,
 * and a distinctive keyword -- WITHOUT ever resolving to the wrong room (a null the visitor
 * re-phrases beats a confident wrong destination).
 *
 * Two layers of proof:
 *   1. End-to-end through `findRoomTarget` (real navmesh): every fuzzy phrasing resolves to
 *      the SAME snapped door point as the room's canonical exact name, and the must-fail
 *      inputs return null. Same-point equality is what proves "right room, not just a room".
 *   2. Pure `makeRoomResolver` unit checks (no WASM): asserts the intended layer fires and,
 *      crucially, that genuinely ambiguous inputs (a bare "washroom", "collaboration")
 *      resolve to null rather than picking one of several matching rooms.
 *
 * Run with: npx tsx src/nav/__tests__/roomResolution.test.ts
 */
import assert from "node:assert/strict";

import { buildNavMesh, __internal } from "../buildNavMesh.js";
import { loadFloorPlan } from "../loadFloorPlan.js";

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const { findRoomTarget } = await buildNavMesh(plan);

  // --- Layer proof 1: fuzzy phrasing resolves to the SAME point as the canonical name ---
  // (query, canonical room name it MUST resolve to). If both sides snap to the same door
  // point, the fuzzy query reached the right room.
  const shouldResolve: Array<[query: string, canonical: string]> = [
    // The exact bug that was reported: "Classroom N" for a bare-number room named "N".
    ["Classroom 1408", "1408"],
    ["classroom 1409", "1409"],
    // Bare number, exact-name path (name IS the number).
    ["1409", "1409"],
    // Alias path, and noise variants of it.
    ["room 1430", "1430"],
    ["  Room 1430  ", "1430"],
    ["1430 room", "1430"],
    ["the 1429", "1429"],
    ["1407.", "1407"],
    // Real Classroom rooms with the "Classroom" word dropped or number-only.
    ["1426", "Classroom 1426"],
    ["the classroom 1425", "Classroom 1425"],
    // Leading "the" / trailing punctuation on a plain name.
    ["the kitchen", "Kitchen"],
    ["Kitchen.", "Kitchen"],
    // Generic word "space" dropped, and the abbreviation "collab" ignored while the
    // distinctive token "north" still pins the room.
    ["north collaboration space", "North Collaboration Space"],
    ["north collab", "North Collaboration Space"],
    ["south collab", "South Collaboration Space"],
    // Distinctive keyword buried in a sentence (last-resort layer).
    ["take me to the kitchen please", "Kitchen"],
    ["I need the wellness room", "Wellness Room"],
    ["Event Space", "Event Space"],
  ];

  for (const [query, canonical] of shouldResolve) {
    const got = findRoomTarget(query);
    const want = findRoomTarget(canonical);
    assert.ok(want, `canonical name ${JSON.stringify(canonical)} must resolve (test setup)`);
    assert.ok(got, `findRoomTarget(${JSON.stringify(query)}) should resolve, got null`);
    assert.deepEqual(
      got,
      want,
      `findRoomTarget(${JSON.stringify(query)}) resolved to a DIFFERENT room than ` +
        `${JSON.stringify(canonical)}: got (${got.x.toFixed(2)}, ${got.z.toFixed(2)}), ` +
        `want (${want.x.toFixed(2)}, ${want.z.toFixed(2)})`,
    );
  }
  console.log(`PASS: all ${shouldResolve.length} fuzzy phrasings resolved to the right room`);

  // --- Must return null: nothing should be guessed for these ---
  const shouldBeNull = [
    "1499", // a 4-digit number no room owns
    "somewhere", // no name, alias, number, or distinctive keyword
    "", // empty
    "   ", // whitespace only
    "washroom", // ambiguous: 3 washrooms, "washroom" is deliberately non-distinctive
    "collaboration", // ambiguous: north AND south collaboration
    "classroom", // pure generic filler, strips to nothing
    "room", // pure generic filler
  ];
  for (const query of shouldBeNull) {
    assert.equal(
      findRoomTarget(query),
      null,
      `findRoomTarget(${JSON.stringify(query)}) should return null (no confident match)`,
    );
  }
  console.log(`PASS: all ${shouldBeNull.length} ambiguous/garbage inputs returned null`);

  // --- Layer proof 2: pure resolver, asserts WHICH room index and rejects ambiguity ---
  const resolve = __internal.makeRoomResolver(plan.rooms);
  const indexOf = (name: string): number => {
    const i = plan.rooms.findIndex((r) => r.name === name);
    assert.ok(i >= 0, `floor-14.json should contain a room named ${JSON.stringify(name)}`);
    return i;
  };

  assert.equal(resolve("Classroom 1408"), indexOf("1408"), "layer 2: strip 'classroom' -> 1408");
  assert.equal(resolve("1417"), indexOf("Classroom 1417"), "layer 3: unique number -> Classroom 1417");
  assert.equal(resolve("north collab"), indexOf("North Collaboration Space"), "layer 4: distinctive 'north'");
  assert.equal(resolve("kitchen"), indexOf("Kitchen"), "layer 1: exact alias");
  assert.equal(resolve("washroom"), null, "ambiguous shared token must not guess a washroom");
  assert.equal(resolve("collaboration"), null, "ambiguous shared token must not guess a collab space");
  console.log("PASS: makeRoomResolver picks the correct room index per layer and rejects ambiguity");

  console.log("\nALL PASS: roomResolution.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
