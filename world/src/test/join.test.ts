/**
 * Minimal smoke test for Task 0.1: boot the world-server, connect a Colyseus
 * client, join the `world` room, and assert the initial state looks right
 * (empty `agents` map, `floor` present). Deliberately a single script, not a
 * full test harness -- that comes later once there's more to test.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Client } from "@colyseus/sdk";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom, GUIDE_ROBOT_COUNT } from "../rooms/WorldRoom.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 22567;

async function main(): Promise<void> {
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
  });
  gameServer.define("world", WorldRoom);

  await gameServer.listen(TEST_PORT);

  try {
    const client = new Client(`ws://localhost:${TEST_PORT}`);
    // disableSimulatedVisitors: this is a bare connectivity smoke test, not a
    // visitor-lifecycle test -- without this, the Task 4.1 simulated-visitor
    // spawner can add a visitor before the first state patch arrives, making
    // the "agents map has exactly GUIDE_ROBOT_COUNT (the seeded guide fleet, no
    // visitors yet)" assertion below intermittently flaky. Reproduced directly (back when
    // the fleet was a single seeded robot): this test failed with `agents.size === 2`
    // under concurrent load, passed cleanly once isolated.
    const room = await client.joinOrCreate("world", { disableSimulatedVisitors: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for initial state")),
        5000,
      );
      room.onStateChange.once(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const state = room.state as { agents: Map<string, unknown>; floor: number };

    // WorldRoom seeds the full guide-robot fleet on creation (see WorldRoom.ts's
    // GUIDE_ROBOT_COUNT / onCreate). This test's original "agents map should start empty"
    // assumption no longer holds; it's not a regression, it's this task's own change to
    // what "initial state" means -- first to "1 test agent" (Task 1.2), now to "the real
    // fleet" (this bugfix: a single test robot left every visitor past the first with no
    // idle robot to assign, see WorldRoom.ts's GUIDE_ROBOT_COUNT doc comment).
    assert.equal(
      state.agents.size,
      GUIDE_ROBOT_COUNT,
      `agents map should start with the ${GUIDE_ROBOT_COUNT}-robot guide fleet`,
    );
    assert.equal(typeof state.floor, "number", "floor should be present as a number");

    await room.leave();
    console.log(
      `PASS: joined 'world' room, received initial state (${GUIDE_ROBOT_COUNT} guide robots, floor present)`,
    );
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
