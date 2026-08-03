/**
 * World-persistence regression test: `WorldRoom` used to rely on Colyseus's default
 * `autoDispose = true`, so the virtual world (all 50 guide-robots + every simulated
 * visitor) was destroyed the moment the last browser client disconnected, and the next
 * join created a brand-new room (fresh id, visitor population re-ramping from zero over
 * ~30s). That also widened the IoT bridge's `world_not_ready` window (see
 * `world/src/index.ts`'s `activeRoom` tracking): a Moses `assign`/`navigate` arriving
 * while nobody happened to have the big screen open would fail, even though nothing was
 * actually broken.
 *
 * Fix (see `WorldRoom.ts`'s `onCreate()` doc comment): `onCreate()` now sets
 * `this.autoDispose = false`, and `world/src/index.ts` pre-creates the room eagerly at
 * boot via `matchMaker.createRoom()` (the same low-level entry point `joinOrCreate()`
 * uses internally, so the existing `handler.on("create", ...)` wiring picks it up with no
 * further changes) instead of waiting for the first browser join.
 *
 * This test proves, against a REAL Colyseus server + `@colyseus/sdk` client (same shape
 * as `join.test.ts`, not a `new WorldRoom()` unit test -- the whole point is to exercise
 * the actual dispose-on-last-leave lifecycle, which only fires through the matchmaker):
 *   1. the room exists (via `matchMaker.createRoom`) before any client ever joins.
 *   2. a client joining lands in that pre-created room, not a freshly-created one.
 *   3. after the last client leaves, the room is NOT disposed (no `RegisteredHandler`
 *      "dispose" event) -- distinct from `join.test.ts`, which never exercises leave.
 *   4. a second client joining afterward gets the SAME room id and the SAME 50-robot
 *      guide fleet ids (not re-spawned) -- proving state survives the zero-clients gap,
 *      not just that some room object happens to still exist.
 *   5. `gameServer.gracefullyShutdown()` still disposes the room exactly once -- the
 *      native WASM (NavMesh/NavMeshQuery/Crowd) cleanup in `onDispose()` must not be
 *      orphaned just because `autoDispose` is now false.
 *
 * Run with: npx tsx src/test/persistence.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Client } from "@colyseus/sdk";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom, GUIDE_ROBOT_COUNT } from "../rooms/WorldRoom.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 22597;
const DISPOSE_GRACE_MS = 2000; // long enough that a stray autoDispose timer would have fired

async function main(): Promise<void> {
  const app = express();
  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
  });
  const handler = gameServer.define("world", WorldRoom);

  let createCount = 0;
  let disposeCount = 0;
  handler.on("create", () => {
    createCount++;
  });
  handler.on("dispose", () => {
    disposeCount++;
  });

  await gameServer.listen(TEST_PORT);

  try {
    // --- 1. eager boot-time creation, mirroring index.ts ---
    await matchMaker.createRoom("world", {});
    assert.equal(createCount, 1, "matchMaker.createRoom() at boot should create exactly one room");
    console.log("PASS: eager matchMaker.createRoom() pre-creates the world room before any client joins");

    // --- 2. a client joining reuses the pre-created room ---
    const client1 = new Client(`ws://localhost:${TEST_PORT}`);
    const room1 = await client1.joinOrCreate("world", {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for initial state")), 5000);
      room1.onStateChange.once(() => {
        clearTimeout(t);
        resolve();
      });
    });
    const firstRoomId = room1.roomId;
    const state1 = room1.state as { agents: Map<string, unknown> };
    const firstAgentIds = new Set<string>(state1.agents.keys());

    assert.equal(createCount, 1, "joining should reuse the pre-created room, not create a new one");
    assert.ok(
      firstAgentIds.size >= GUIDE_ROBOT_COUNT,
      `pre-created room should already have at least the full ${GUIDE_ROBOT_COUNT}-robot guide fleet, got ${firstAgentIds.size}`,
    );
    console.log(`PASS: client join reused the pre-created room (roomId=${firstRoomId}, ${firstAgentIds.size} agents)`);

    // --- 3. last client leaving must NOT dispose the room ---
    await room1.leave();
    await new Promise((r) => setTimeout(r, DISPOSE_GRACE_MS));
    assert.equal(disposeCount, 0, "room must not be disposed when the last client disconnects");
    console.log(`PASS: room survived ${DISPOSE_GRACE_MS}ms with zero connected clients (disposeCount=0)`);

    // --- 4. a fresh join lands in the SAME room, with the SAME guide-robot fleet ---
    const client2 = new Client(`ws://localhost:${TEST_PORT}`);
    const room2 = await client2.joinOrCreate("world", {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for initial state")), 5000);
      room2.onStateChange.once(() => {
        clearTimeout(t);
        resolve();
      });
    });
    const state2 = room2.state as { agents: Map<string, unknown> };
    const secondAgentIds = new Set<string>(state2.agents.keys());

    assert.equal(room2.roomId, firstRoomId, "rejoin after the last client left must land in the SAME room instance");
    assert.equal(createCount, 1, "no new room should have been created for the rejoin");

    const firstRobotIds = [...firstAgentIds].filter((id) => id.startsWith("virtual/")).sort();
    const secondRobotIds = [...secondAgentIds].filter((id) => id.startsWith("virtual/")).sort();
    assert.equal(firstRobotIds.length, GUIDE_ROBOT_COUNT, "sanity: exactly the 50-robot guide fleet before the gap");
    assert.deepEqual(
      secondRobotIds,
      firstRobotIds,
      "the guide-robot fleet's ids must be byte-for-byte identical across the leave/rejoin gap (not re-spawned)",
    );
    // Visitor/agent count must not have been reset to zero and re-ramped -- it may only
    // grow (the simulated-visitor spawner legitimately keeps ticking while unobserved,
    // which is the point of this fix, not a bug in this assertion).
    assert.ok(
      secondAgentIds.size >= firstAgentIds.size,
      `agent count must not shrink/reset across the leave/rejoin gap: was ${firstAgentIds.size}, now ${secondAgentIds.size}`,
    );
    console.log(
      `PASS: rejoin landed in the same room (roomId=${room2.roomId}), same ${GUIDE_ROBOT_COUNT}-robot fleet ids, ` +
        `agent count ${firstAgentIds.size} -> ${secondAgentIds.size} (world kept simulating while unobserved, did not reset to 0)`,
    );

    await room2.leave();
    console.log("\nALL PASS: persistence.test.ts");
  } finally {
    // --- 5. an ACTUAL server shutdown must still dispose the room exactly once, freeing
    // the native NavMesh/NavMeshQuery/Crowd resources -- autoDispose=false must not
    // orphan real shutdown cleanup. ---
    await gameServer.gracefullyShutdown(false);
    assert.equal(disposeCount, 1, "gracefully shutting down the server must still dispose the persistent room exactly once");
    console.log("PASS: gracefullyShutdown() force-disposes the persistent room (native WASM cleanup not orphaned)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
