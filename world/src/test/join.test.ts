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

import { WorldRoom } from "../rooms/WorldRoom.js";

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
    const room = await client.joinOrCreate("world");

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

    assert.equal(state.agents.size, 0, "agents map should start empty");
    assert.equal(typeof state.floor, "number", "floor should be present as a number");

    await room.leave();
    console.log("PASS: joined 'world' room, received initial state (agents empty, floor present)");
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
