/**
 * Reconnect-vs-persistence interaction guard.
 *
 * Two changes landed independently, each tested on its own, never together:
 *   1. Client reconnect handling (world-client/src/net/useWorldRoom.ts, commit d9931a8):
 *      retries with backoff on an unexpected drop, and calls `clearAgents()` right before
 *      re-subscribing on every successful (re)connect. Its own doc comment explains why:
 *      a brand-new `Room` instance's `onAdd` only fires for agents present in ITS state, so
 *      an agent removed server-side while disconnected would never get an `onRemove` on the
 *      new room and would linger forever as a ghost.
 *   2. Persistent world (WorldRoom.ts's `onCreate`, commit 383f561): `autoDispose = false`
 *      plus eager `matchMaker.createRoom()` at boot, so the room -- and its ~95 simulated
 *      agents -- survives with zero clients and keeps ticking unattended.
 *
 * (1) was designed against EPHEMERAL rooms: losing the connection meant the room disposed,
 * so a reconnect was really a join to a brand-new, empty room that would then repopulate
 * from `onAdd` as the fresh join's initial state decoded. With (2), a reconnecting client
 * instead rejoins the SAME long-lived room, whose ~70 agents have been simulating the whole
 * time it was disconnected. Nobody has proven, against a real server, that Colyseus 0.17
 * still delivers a complete `onAdd` sweep on a fresh `joinOrCreate` to an ALREADY-POPULATED
 * room -- as opposed to some delta, or nothing, which would leave the big screen empty or
 * partially populated after a reconnect while the client believes it is connected (the
 * dangerous failure mode `useWorldRoom.ts`'s own `ConnectionStatus` doc comment calls out:
 * positions live in a ref, so a frozen/incomplete screen shows no sign anything is wrong).
 *
 * This script is a real end-to-end proof, not a unit test of either change in isolation:
 * boots a REAL `colyseus` `Server` + `WebSocketTransport` on a throwaway port, pre-creates
 * the `WorldRoom` via `matchMaker.createRoom()` exactly like `world/src/index.ts` does at
 * boot (persistence.test.ts's own pattern), lets it reach a real steady state (50 guide
 * robots + simulated visitors ramping), then connects a REAL `@colyseus/sdk` client whose
 * subscription logic is a deliberate line-for-line mirror of `useWorldRoom.ts`: same
 * `getStateCallbacks`, same fresh-plain-object snapshot in `onAdd`, same scalar-field sync
 * in `onChange`, same `Map.delete` in `onRemove`, same `clearAgents()` before every
 * subscribe, same `room.reconnection.enabled = false` (so Colyseus's own same-session
 * resume never engages -- see useWorldRoom.ts's doc comment on why that's deliberately
 * off), and the same intentional-vs-unexpected `onLeave` classification driving
 * `reconnectPolicy.ts`'s real `shouldReconnect`/`computeReconnectDelayMs` (imported
 * directly from world-client, not reimplemented, so this can't silently drift from what
 * production actually decides -- the file is dependency-free by design, see its own header).
 *
 * ---- what it proves, and how ----
 *  1. UNEXPECTED disconnect, not a deliberate leave: the underlying Node `ws` socket is
 *     `.terminate()`d directly (reaching through `room.connection.transport.ws`, all public
 *     runtime fields -- see Room.mjs/Connection.mjs/WebSocketTransport.mjs in
 *     node_modules/@colyseus/sdk/build) -- an abrupt TCP close with no close handshake, the
 *     closest a script can get to "the network died" rather than "the client hung up
 *     politely". This is the exact path `room.onLeave` handles in production (an
 *     ABNORMAL_CLOSURE-class code routes through `handleReconnection`, which -- since
 *     `reconnection.enabled` is false, mirroring the hook -- immediately re-invokes
 *     `onLeave`, same as any other close code would).
 *  2. Ghost case: while disconnected, a dedicated always-present test agent
 *     ("ghost-test-visitor", added once up front) is removed server-side via
 *     `WorldRoom.removeAgent` directly (deterministic, vs. waiting on a natural despawn).
 *     After reconnect, it must be ABSENT client-side -- proving `clearAgents()` still earns
 *     its place under the new persistent-room behavior, not vestigial.
 *  3. Repopulation completeness: after reconnect settles, the client's mirrored agent-key
 *     set must exactly equal the server's live `state.agents` key set (checked with the
 *     server briefly PAUSED via `WorldRoom.pause()`, mirroring pooltest.ts's "freeze the
 *     world for a lag-free comparison" technique -- otherwise both sides are reads of a
 *     moving target from different clocks and a transient mismatch would be pure
 *     replication lag, not evidence of anything).
 *  4. Liveness, not a frozen-looking screen: a specific guide robot is given a real
 *     `moveAgentTo` target BEFORE the disconnect (so it's actively walking across the whole
 *     gap); after reconnect its position is sampled twice with a real gap between samples
 *     and must have actually moved -- proving the NEW subscription's `onChange` callbacks
 *     are live, not that `onAdd` merely painted one static snapshot.
 *  5. Same room, kept simulating: the reconnect must land in the SAME `roomId` (proving
 *     persistence, not a fresh room), and the moving robot's SERVER-side position at
 *     reconnect-settle must have advanced measurably from its pre-disconnect position --
 *     proving the world kept ticking the whole time nobody was connected, which is the
 *     entire point of `autoDispose = false`.
 *
 * Run with: npm run test:reconnect   (== npx tsx scripts/reconnecttest.ts)
 * Configurable via env var (optional): RECONNECT_TEST_PORT.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom, GUIDE_ROBOT_COUNT } from "../src/rooms/WorldRoom.js";
import { loadFloorPlan } from "../src/nav/loadFloorPlan.js";
// Imported directly from world-client, not reimplemented: reconnectPolicy.ts is
// deliberately dependency-free (no React, no Colyseus, no browser APIs -- see its own file
// header), so this cross-package import is safe under tsx's file-by-file transpile and is
// what makes the "unexpected -> shouldReconnect -> computeReconnectDelayMs" path this
// script drives PROVABLY the same decision production's useWorldRoom.ts makes, not a
// hand-rewritten stand-in that could silently drift from it.
import {
  computeReconnectDelayMs,
  shouldReconnect,
  type DisconnectReason,
} from "../../world-client/src/net/reconnectPolicy.js";

const TEST_PORT = Number(process.env.RECONNECT_TEST_PORT) || 24918; // throwaway, NOT 2567
const WORLD_URL = `ws://localhost:${TEST_PORT}`;

/** Compressed only so the world reaches a meaningfully-populated "visitors ramping" state
 * inside a short, real-wall-clock test run -- shipped defaults (simulatedVisitorSpawner.ts's
 * SIMULATED_VISITOR_TARGET=45, 0.5s stagger) are untouched; same "compress waiting, not
 * simulation" convention pooltest.ts/soaktest.ts already use. Walking speed/distance is NOT
 * compressed. */
const SIMULATED_TARGET = Number(process.env.RECONNECT_TEST_SIMULATED_TARGET ?? 20);
const SPAWN_STAGGER_S = 0.2;
const RAMP_MS = 4500;

const GHOST_ID = "ghost-test-visitor";
const MOVING_ROBOT_ID = "virtual/1";

const SETTLE_MS = 700;
const LIVE_CHECK_MS = 800;
const PAUSE_SETTLE_MS = 400;
/** Guide robots move at DEFAULT_AGENT_PARAMS.maxSpeed=1.4 m/s (WorldRoom.ts); this floor is
 * comfortably below what even a slow, obstacle-avoidance-laden couple of seconds of real
 * travel toward the entrance should cover, for any of the 50 spawn points
 * (guideFleetSpawns.ts spreads them across the whole floor). */
const MIN_SERVER_MOVE_DISTANCE_M = 0.15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors world-client/src/net/useWorldRoom.ts's `AgentSnapshot` exactly. */
interface AgentSnapshot {
  id: string;
  kind: string;
  x: number;
  z: number;
  heading: number;
  state: string;
  route: ArrayLike<number>;
}

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };

  const app = express();
  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
  });
  const handler = gameServer.define("world", WorldRoom);

  let serverRoom: WorldRoom | undefined;
  handler.on("create", (room) => {
    serverRoom = room as WorldRoom;
  });

  try {
    await gameServer.listen(TEST_PORT);

    // Eager boot-time creation, mirroring world/src/index.ts and persistence.test.ts --
    // the room exists and is already ticking before any client ever joins.
    await matchMaker.createRoom("world", {
      visitorManagerOptions: {
        simulatedTarget: SIMULATED_TARGET,
        spawnStaggerSeconds: SPAWN_STAGGER_S,
      },
    });
    assert.ok(serverRoom, "matchMaker.createRoom should have handed us the WorldRoom instance via 'create'");
    const room = serverRoom!;

    console.log(
      `Booted world-server on port ${TEST_PORT}. Letting the world ramp for ${RAMP_MS}ms ` +
        `(${GUIDE_ROBOT_COUNT} guide robots + simulatedTarget=${SIMULATED_TARGET} visitors, ` +
        `real default 45, compressed for test wall time only)...\n`,
    );
    await sleep(RAMP_MS);
    console.log(
      `Ramp complete: server has ${room.state.agents.size} live agents ` +
        `(${room.getVisitorDebugStats().simulatedActive} simulated visitors active).`,
    );

    // Deterministic ghost-removal fixture: added once, up front, so it's present in the
    // client's very first sync (proving it CAN be tracked) before being removed while
    // disconnected. Using a dedicated fixed id (rather than waiting on a natural simulated
    // despawn) makes the test's timing deterministic instead of racing the spawner.
    assert.ok(room.addAgent(GHOST_ID, "visitor", entrance), "failed to add the ghost-test fixture agent");

    // Deterministic liveness/persistence fixture: send a real guide robot walking toward
    // the entrance BEFORE the disconnect, so it's actively in motion across the whole
    // disconnect gap -- this is what lets the final assertions measure real movement
    // instead of hoping a random simulated visitor happens to be moving at the right moment.
    assert.ok(
      room.moveAgentTo(MOVING_ROBOT_ID, entrance),
      `failed to send ${MOVING_ROBOT_ID} toward the entrance`,
    );

    // ---- client-side state, mirroring useWorldRoom.ts's module-level closure vars ----
    const agents = new Map<string, AgentSnapshot>();
    let currentRoom: Room | null = null;
    let intentionalLeave = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Single-outstanding-waiter helpers -- this script only ever awaits one "next connect"
    // or "next leave" at a time (the flow below is strictly sequential), so a single mutable
    // resolver slot (armed by whoever calls wait*, fired and cleared by the event) is enough
    // and keeps this closer to plain async/await than a full event-emitter would.
    let connectedResolver: (() => void) | null = null;
    function waitForNextConnect(): Promise<void> {
      return new Promise((resolve) => {
        connectedResolver = resolve;
      });
    }
    function notifyConnected(): void {
      const r = connectedResolver;
      connectedResolver = null;
      r?.();
    }

    let leaveResolver: ((reason: DisconnectReason) => void) | null = null;
    function waitForNextLeave(): Promise<DisconnectReason> {
      return new Promise((resolve) => {
        leaveResolver = resolve;
      });
    }
    function notifyLeave(reason: DisconnectReason): void {
      const r = leaveResolver;
      leaveResolver = null;
      r?.(reason);
    }

    // Exact mirror of useWorldRoom.ts's clearAgents().
    const clearAgents = (): void => {
      agents.clear();
    };

    const scheduleRetry = (): void => {
      attempt += 1;
      const delay = computeReconnectDelayMs(attempt);
      console.log(`  scheduling reconnect attempt ${attempt} in ${delay}ms (reconnectPolicy.ts, unchanged)`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    // Exact mirror of useWorldRoom.ts's connect(): a FRESH Client per attempt (Colyseus's
    // own same-session resume is disabled below, same as the hook), clearAgents() before
    // re-subscribing, same onAdd/onChange/onRemove shape, same onLeave intentional/unexpected
    // classification driving the real reconnectPolicy.ts functions.
    function connect(): void {
      const client = new Client(WORLD_URL);
      client
        .joinOrCreate("world", {})
        .then((joinedRoom) => {
          currentRoom = joinedRoom;
          intentionalLeave = false;
          attempt = 0;

          // See useWorldRoom.ts's doc comment: disabled so Colyseus's own "resume the SAME
          // session" inner reconnection loop never engages -- clearAgents() + a fresh
          // subscribe on every (re)connect is the ONLY repopulation path this script (and
          // production) actually relies on.
          joinedRoom.reconnection.enabled = false;

          clearAgents();

          const $ = getStateCallbacks(joinedRoom);
          $(joinedRoom.state as never).agents.onAdd((agent: never, key: string) => {
            const a = agent as {
              id: string;
              kind: string;
              x: number;
              z: number;
              heading: number;
              state: string;
              route: ArrayLike<number>;
            };
            agents.set(key, {
              id: a.id,
              kind: a.kind,
              x: a.x,
              z: a.z,
              heading: a.heading,
              state: a.state,
              route: a.route,
            });

            $(agent).onChange(() => {
              const snapshot = agents.get(key);
              if (snapshot) {
                snapshot.x = a.x;
                snapshot.z = a.z;
                snapshot.heading = a.heading;
                snapshot.state = a.state;
              }
            });
          });

          $(joinedRoom.state as never).agents.onRemove((_agent: never, key: string) => {
            agents.delete(key);
          });

          joinedRoom.onError((code, message) => {
            console.error("reconnecttest: room error", code, message);
          });

          joinedRoom.onLeave((code, reason) => {
            currentRoom = null;
            const disconnectReason: DisconnectReason = intentionalLeave ? "intentional" : "unexpected";
            notifyLeave(disconnectReason);
            if (!shouldReconnect(disconnectReason)) return;
            console.warn(
              `reconnecttest: room left unexpectedly (code=${code}, reason=${reason ?? ""}), reconnecting`,
            );
            scheduleRetry();
          });

          // Fires once the first state sync (initial ROOM_STATE, or a later patch) has been
          // decoded -- @colyseus/schema's decode is synchronous, so every onAdd for
          // currently-present agents has already fired by the time this callback runs (same
          // pattern join.test.ts/persistence.test.ts/pooltest.ts all use to know "initial
          // state has landed" deterministically instead of guessing with a sleep).
          joinedRoom.onStateChange.once(() => {
            notifyConnected();
          });
        })
        .catch((err: unknown) => {
          console.error("reconnecttest: failed to join 'world' room", err);
          scheduleRetry();
        });
    }

    // ---- 1. initial connect (mirrors the hook's very first `connect()` call) ----
    connect();
    await waitForNextConnect();
    // Let a couple more patches land (onAdd for late-arriving visitors, first onChange
    // batch) before treating this as "settled" -- matches join.test.ts's own settle wait.
    await sleep(SETTLE_MS);

    const roomId1 = currentRoom!.roomId;
    assert.ok(agents.has(GHOST_ID), "ghost fixture must be present after the initial join's onAdd sweep");
    console.log(
      `PASS: initial join synced ${agents.size} agents (server has ${room.state.agents.size}), ` +
        `roomId=${roomId1}, ghost fixture present.`,
    );

    const serverMovingBefore = { x: room.state.agents.get(MOVING_ROBOT_ID)!.x, z: room.state.agents.get(MOVING_ROBOT_ID)!.z };

    // ---- 2. force an UNEXPECTED disconnect: terminate the raw socket from the SERVER
    // side, not room.leave() ----
    // Node 22's native `globalThis.WebSocket` (undici) has no `.terminate()`, and
    // @colyseus/sdk's WebSocketTransport prefers it over the `ws` package when present
    // (`const WebSocket = globalThis.WebSocket || NodeWebSocket` -- verified against
    // node_modules/@colyseus/sdk/build/transport/WebSocketTransport.mjs), so reaching into
    // the CLIENT's raw socket isn't portable. The SERVER side is real `ws` regardless
    // (@colyseus/ws-transport always uses the `ws` package -- verified against
    // node_modules/@colyseus/ws-transport/build/WebSocketClient.mjs's `this.ref`, a real
    // `ws` WebSocket with `.terminate()`), so this reaches `room.clients` (colyseus's own
    // public `Room#clients` array) for the Client matching this session and terminates ITS
    // underlying socket instead -- an abrupt TCP close with no close handshake sent, from
    // the server's side this time. From the connected client's perspective this is
    // indistinguishable from "the world-server died mid-connection", which is precisely the
    // scenario useWorldRoom.ts's reconnect logic exists to survive (see its own doc comment
    // on why Colyseus's built-in same-session resume is disabled: it hung forever the one
    // time this was tested against an actually-killed-and-replaced server process).
    const leavePromise = waitForNextLeave();
    const serverClient = room.clients.find((c) => c.sessionId === currentRoom!.sessionId);
    assert.ok(serverClient, `no server-side Client found for sessionId ${currentRoom!.sessionId}`);
    (serverClient as unknown as { ref: { terminate: () => void } }).ref.terminate();
    const reason = await leavePromise;
    assert.equal(reason, "unexpected", `disconnect must be classified 'unexpected', got '${reason}'`);
    console.log("PASS: forced socket termination was classified 'unexpected' by the hook-mirrored onLeave handler");

    // ---- 3. while disconnected: remove the ghost agent server-side ----
    assert.ok(room.state.agents.has(GHOST_ID), "ghost fixture must still be live server-side right before removal");
    room.removeAgent(GHOST_ID);
    assert.ok(!room.state.agents.has(GHOST_ID), "ghost fixture must be gone server-side immediately after removeAgent");
    console.log("PASS: ghost fixture removed server-side while the client was disconnected");

    // ---- 4. wait for the retry to land (fresh Client, fresh Room, same persistent room) ----
    await waitForNextConnect();
    assert.equal(
      currentRoom!.roomId,
      roomId1,
      `reconnect must land back in the SAME persistent room (was ${roomId1}, got ${currentRoom!.roomId})`,
    );
    console.log(`PASS: reconnect landed in the SAME room (roomId=${currentRoom!.roomId}), not a fresh one`);

    await sleep(SETTLE_MS);

    // ---- 5. ghost must NOT have come back ----
    assert.ok(
      !agents.has(GHOST_ID),
      "ghost fixture must be ABSENT client-side after reconnect -- clearAgents() should have dropped it",
    );
    console.log("PASS: ghost fixture stayed absent after reconnect (clearAgents() earned its place)");

    // ---- 6. liveness: the moving robot's position must actually update post-reconnect ----
    const clientMovingT1 = agents.get(MOVING_ROBOT_ID);
    assert.ok(clientMovingT1, `${MOVING_ROBOT_ID} must be present in the client's post-reconnect map`);
    const t1 = { x: clientMovingT1!.x, z: clientMovingT1!.z };
    await sleep(LIVE_CHECK_MS);
    const clientMovingT2 = agents.get(MOVING_ROBOT_ID)!;
    const t2 = { x: clientMovingT2.x, z: clientMovingT2.z };
    assert.ok(
      t1.x !== t2.x || t1.z !== t2.z,
      `${MOVING_ROBOT_ID}'s position must be updating live on the NEW subscription, not frozen ` +
        `(t1=(${t1.x.toFixed(3)},${t1.z.toFixed(3)}), t2=(${t2.x.toFixed(3)},${t2.z.toFixed(3)}))`,
    );
    console.log(
      `PASS: ${MOVING_ROBOT_ID} kept moving after reconnect ((${t1.x.toFixed(3)},${t1.z.toFixed(3)}) -> ` +
        `(${t2.x.toFixed(3)},${t2.z.toFixed(3)})) -- the new onChange subscription is live`,
    );

    // ---- 7. freeze the world for a lag-free exact key-set comparison (pooltest.ts's
    // "pause, then compare" technique -- otherwise both sides are moving targets read from
    // two different clocks and a transient mismatch would be replication lag, not a bug) ----
    room.pause();
    await sleep(PAUSE_SETTLE_MS);

    const clientKeys = new Set(agents.keys());
    const serverKeys = new Set(room.state.agents.keys());
    assert.equal(
      clientKeys.size,
      serverKeys.size,
      `post-reconnect key-set SIZE mismatch: client=${clientKeys.size}, server=${serverKeys.size}`,
    );
    for (const k of serverKeys) {
      assert.ok(clientKeys.has(k), `server has agent "${k}" but the client's post-reconnect map does not`);
    }
    for (const k of clientKeys) {
      assert.ok(serverKeys.has(k), `client's post-reconnect map has agent "${k}" but the server does not (ghost)`);
    }
    console.log(
      `PASS: post-reconnect client/server agent key sets match EXACTLY (${clientKeys.size} agents, ` +
        `>= ${GUIDE_ROBOT_COUNT} guide robots): a fresh join to an already-populated persistent room ` +
        "delivers a complete onAdd sweep, not a delta or partial state.",
    );

    // ---- 8. the world kept simulating the whole disconnect gap, on the SAME room ----
    const serverMovingAfter = room.state.agents.get(MOVING_ROBOT_ID)!;
    const serverMoveDistance = Math.hypot(
      serverMovingAfter.x - serverMovingBefore.x,
      serverMovingAfter.z - serverMovingBefore.z,
    );
    assert.ok(
      serverMoveDistance >= MIN_SERVER_MOVE_DISTANCE_M,
      `${MOVING_ROBOT_ID} should have moved >= ${MIN_SERVER_MOVE_DISTANCE_M}m server-side across the whole ` +
        `disconnect gap (moved ${serverMoveDistance.toFixed(3)}m: ` +
        `(${serverMovingBefore.x.toFixed(3)},${serverMovingBefore.z.toFixed(3)}) -> ` +
        `(${serverMovingAfter.x.toFixed(3)},${serverMovingAfter.z.toFixed(3)})) -- ` +
        "the world must not have paused/reset just because no client was connected",
    );
    console.log(
      `PASS: ${MOVING_ROBOT_ID} moved ${serverMoveDistance.toFixed(3)}m server-side across the disconnect gap -- ` +
        "the persistent world kept simulating throughout, unattended, exactly as autoDispose=false intends",
    );

    room.resume();

    // ---- cleanup: an intentional leave must NOT schedule a retry ----
    intentionalLeave = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    await currentRoom!.leave();

    console.log("\nALL PASS: reconnecttest.ts");
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
