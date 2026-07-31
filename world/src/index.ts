import { createServer } from "node:http";

import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom } from "./rooms/WorldRoom.js";
import { startIotBridgeFromEnv } from "./iot/bridge.js";
import type { WorldRoomLike } from "./iot/bridge.js";

const port = Number(process.env.PORT) || 2567;

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

const handler = gameServer.define("world", WorldRoom);

// Task 2.3: the IoT bridge needs a live handle to "the" WorldRoom instance to call
// moveAgentTo on, but Colyseus creates/disposes rooms on demand (first join / last leave)
// rather than eagerly at boot -- there is no synchronous "get me the room" API. The
// RegisteredHandler returned by define() emits create/dispose events for exactly this,
// so this tracks the current instance without touching WorldRoom.ts itself. A navigate
// command that arrives while no client has joined (activeRoom undefined) acks
// failed/"world_not_ready" -- see bridge.ts's handleCommand.
let activeRoom: WorldRoomLike | undefined;
handler.on("create", (room) => {
  activeRoom = room;
});
handler.on("dispose", (room) => {
  if (activeRoom === room) activeRoom = undefined;
});

// Env-gated: GUIDEMATE_IOT_ENDPOINT/GUIDEMATE_CERT/GUIDEMATE_KEY not all set (e.g. plain
// `npm run dev`) -> logs and returns undefined, the world-server still boots and serves
// WebSocket clients normally. A present-but-bad cert/endpoint throws inside mqtt.connect
// or readFileSync; caught here so a bad IoT config degrades the bridge, not the server.
try {
  startIotBridgeFromEnv(process.env, () => activeRoom);
} catch (err) {
  console.error("[iot-bridge] failed to start -- world-server continues without it:", err);
}

gameServer.listen(port).then(() => {
  console.log(`World-server listening on ws://localhost:${port}`);
});
