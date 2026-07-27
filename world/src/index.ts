import { createServer } from "node:http";

import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom } from "./rooms/WorldRoom.js";

const port = Number(process.env.PORT) || 2567;

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("world", WorldRoom);

gameServer.listen(port).then(() => {
  console.log(`World-server listening on ws://localhost:${port}`);
});
