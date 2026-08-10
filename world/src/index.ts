import { createServer } from "node:http";

import { Server, matchMaker } from "colyseus";
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

// Read-only observability endpoint (no mutation): dumps the live world's agents so an
// operator or an E2E test can OBSERVE the fleet directly (real name, kind, state,
// position) instead of inferring it from an MQTT ack. Reachable in prod at /world/agents
// (Caddy strips the /world prefix, same as /world/healthz). Returns { agents: [] } when no
// room exists yet (before the eager boot pre-creation resolves, or after a dispose).
app.get("/agents", (_req, res) => {
  if (!activeRoom) {
    res.json({ agents: [] });
    return;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const agents: { id: string; kind: string; name: string; state: string; x: number; z: number }[] = [];
  // WorldRoomLike.state.agents (bridge.ts) is deliberately a minimal structural type
  // exposing only `.get`; the live map is a colyseus MapSchema<Agent> with the full agent
  // fields. Cast just here to iterate it read-only for this dump -- no mutation.
  const liveAgents = activeRoom.state.agents as unknown as {
    forEach(cb: (agent: {
      id?: string;
      kind?: string;
      name?: string;
      state?: string;
      x?: number;
      z?: number;
    }) => void): void;
  };
  liveAgents.forEach((agent) => {
    agents.push({
      id: agent.id ?? "",
      kind: agent.kind ?? "",
      name: agent.name ?? "",
      state: agent.state ?? "",
      x: round2(agent.x ?? 0),
      z: round2(agent.z ?? 0),
    });
  });
  res.json({ agents });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

const handler = gameServer.define("world", WorldRoom);

// Task 2.3: the IoT bridge needs a live handle to "the" WorldRoom instance to call
// moveAgentTo on. Colyseus's own room lifecycle (first join / last leave) doesn't give a
// synchronous "get me the room" API, so this tracks the current instance itself, via the
// RegisteredHandler create/dispose events, without touching WorldRoom.ts. A navigate
// command that arrives while no room exists yet (activeRoom undefined) acks
// failed/"world_not_ready" -- see bridge.ts's handleCommand. World-persistence fix: with
// WorldRoom.onCreate() now setting `autoDispose = false`, this window shrinks to "before
// the eager matchMaker.createRoom() call below resolves at boot" -- it no longer reopens
// every time the browser's last tab closes.
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

gameServer.listen(port).then(async () => {
  console.log(`World-server listening on ws://localhost:${port}`);

  // World-persistence fix: pre-create the "world" room at boot instead of waiting for the
  // first browser join, so a Moses `assign`/`navigate` arriving before anyone has opened
  // the big screen doesn't hit the world_not_ready window at all. matchMaker.createRoom()
  // is the same low-level entry point client.joinOrCreate() uses internally (see the
  // installed colyseus 0.17.10's node_modules/@colyseus/core/build/MatchMaker.mjs:
  // handleCreateRoom() emits the handler's "create" event exactly like a client-triggered
  // creation does), so the existing handler.on("create", ...) wiring above picks this room
  // up as activeRoom with no further changes needed. Wrapped in try/catch, not awaited by
  // the outer listen().then() chain's caller, so a failure here (e.g. a floor-plan/navmesh
  // build error) is logged but degrades to the pre-existing lazy on-first-join behavior
  // rather than crashing an otherwise-healthy WebSocket server.
  try {
    await matchMaker.createRoom("world", {});
    console.log("[world-server] pre-created 'world' room at boot (eager, not waiting for first join)");
  } catch (err) {
    console.error(
      "[world-server] eager room pre-creation failed -- falling back to lazy on-first-join creation:",
      err,
    );
  }
});
