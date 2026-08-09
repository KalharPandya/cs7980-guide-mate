/**
 * End-to-end integration test for the ONE chain that has never been tested as a single
 * thing: Moses receives "take me to room X" -> publishes an `assign` fleet Command ->
 * IotBridge routes it -> a real guide-robot from the virtual/N fleet is assigned -> it
 * escorts the visitor to the requested room's door -> they arrive. Every existing test
 * covers one hop:
 *   - `iot/__tests__/bridge.test.ts` drives `assign` against a FAKE `WorldRoomLike` (a
 *     hand-written test double) -- no real navigation happens, `requestGuide` is a stub
 *     that returns a canned `{robotId}`.
 *   - `rooms/__tests__/visitors.test.ts` calls `WorldRoom.requestGuide()` DIRECTLY --
 *     bypassing the entire Command/bridge/dedupe/ack layer.
 * This file wires them together: a REAL `WorldRoom` (booted through the exact
 * `matchMaker.createRoom()` lifecycle production uses, see `persistence.test.ts`) fed a
 * REAL `assign` Command through the REAL `IotBridge.handleMessage` (only the MQTT
 * transport itself is faked -- a structural `MqttClientLike`, per bridge.ts's own doc
 * comment on why that boundary exists; AWS IoT Core is out of scope here, see
 * `bridge.integration.test.ts` for the gated real-broker round trip of the `navigate`
 * path).
 *
 * ---- why `matchMaker.createRoom()`, not `new WorldRoom(); onCreate()` ----
 * `world/scripts/soaktest.ts`'s header explains the shortcut `WorldRoom.test.ts`/
 * `visitors.test.ts` use (`new WorldRoom()` then straight into `onCreate()`) skips
 * Colyseus's `Room#__init()` step the MatchMaker normally runs first, which is what
 * upgrades `state` from a plain object to the real `@colyseus/schema` encoder-backed
 * accessor. That distinction doesn't matter for those files' narrower units, but this
 * file's whole point is to prove the chain works the way it actually runs in production
 * (`world/src/index.ts` boots the room via this exact same `matchMaker.createRoom()`
 * call), so it pays for the real lifecycle via a real `Server` + `WebSocketTransport`,
 * same shape as `persistence.test.ts`. No browser/`@colyseus/sdk` client ever joins here
 * (this test's assertions only need direct server-side access, which the "create" handler
 * event -- see `bootRealRoom()` below -- already gives us); `persistence.test.ts` is the
 * one that exercises the client-join/leave lifecycle, this file exercises the
 * command/simulation lifecycle.
 *
 * ---- deterministic simulated time on a REAL room ----
 * `onCreate()` starts a real wall-clock `setSimulationInterval`. `bootRealRoom()` clears
 * it immediately (`Room#setSimulationInterval()` with no callback just calls
 * `clearInterval` on the existing one -- see node_modules/@colyseus/core/build/Room.mjs)
 * and every scenario below drives simulated time itself via repeated `room.update(TICK_MS)`
 * calls, exactly like `visitors.test.ts`/`WorldRoom.test.ts` already do -- the only
 * difference is the room was booted through the real matchmaker first.
 *
 * ---- the Python wire-format cross-check ----
 * `fixtures/pythonAssignCommand.json` is the BYTE-FOR-BYTE output of
 * `shared/guidemate_msgs/guidemate_msgs/messages.py`'s `Command` pydantic model for an
 * `assign` command, produced by actually running the Python side (not hand-typed):
 *
 *   cd <repo root> && agent_service/.venv/Scripts/python.exe -c "
 *   import sys; sys.path.insert(0, 'shared/guidemate_msgs')
 *   from guidemate_msgs.messages import Command
 *   import json
 *   cmd = Command(cmd_id='fixture-assign-cmd-001', type='assign', name='assign',
 *                 params={'visitor_id': 'moses-assign-chain-test-visitor',
 *                         'room': 'South Collaboration Space'},
 *                 ts='2026-08-03T00:00:00+00:00')
 *   print(cmd.model_dump_json(indent=2))"
 *
 * Checked in as a static fixture (not re-generated at test time) so `npm run test:all`
 * never needs a Python interpreter/venv on whatever machine runs it -- the genuine
 * cross-check is that this file loads the fixture UNCHANGED and feeds it through
 * `messages.ts`'s real `parseCommand()` (the same parser `IotBridge.handleMessage` uses
 * on every real message), proving the two languages agree on the wire shape byte-for-byte,
 * not just "some fields with the right names".
 *
 * ---- the route ----
 * A real visitor always spawns at the floor plan's ENTRANCE (`WorldRoom.getEntrancePoint`,
 * called from `bridge.ts`'s `handleFleetCommand` for a brand-new visitor_id) -- so the
 * "genuinely long route" bar here is entrance-to-door distance, not door-to-door. Scanning
 * every room in `data/floor-14.json` from the entrance point (24.821, 13.99), "South
 * Collaboration Space" (door at 5.641, 7.07) is the FARTHEST at ~20.39m -- longer than
 * `visitors.test.ts`'s own Wellness-Room-to-Event-Space pick (~18.42m door-to-door), and
 * the real fleet's 50 robots are all present and contesting the floor exactly like
 * production, not disabled for this scenario.
 *
 * Run with: npx tsx src/test/assignChain.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";

import { WorldRoom, GUIDE_ROBOT_COUNT } from "../rooms/WorldRoom.js";
import { IotBridge } from "../iot/bridge.js";
import type { WorldRoomLike, MqttClientLike } from "../iot/bridge.js";
import {
  fleetCmdTopic,
  fleetStatusTopic,
  statusTopic,
  parseCommand,
  newCmdId,
  type Ack,
  type Command,
} from "../iot/messages.js";
import { loadFloorPlan } from "../nav/loadFloorPlan.js";

const TICK_MS = 16.6;
const DOOR_TOLERANCE_M = 1.0; // matches WorldRoom.test.ts / visitors.test.ts's convergence tolerance

const QUIET_LOG = { log() {}, warn() {}, error() {} };

let nextPort = 22697; // distinct range from persistence.test.ts's 22597, join.test.ts's default

/** In-memory MQTT client double, structurally identical to bridge.test.ts's own
 * `FakeMqttClient` (kept local to this file rather than imported/shared -- each test file
 * in this repo owns its fakes, see bridge.test.ts vs. bridge.integration.test.ts). Only
 * the MQTT wire itself is faked; everything downstream of `IotBridge.handleMessage` --
 * parsing, dedupe, routing, and the real `WorldRoom` it drives -- is the genuine article. */
class FakeMqttClient implements MqttClientLike {
  published: { topic: string; payload: Ack }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(): void {}

  subscribe(_topic: string, _opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void {
    cb?.(null);
  }

  publish(topic: string, message: string, _opts: { qos: 0 | 1 | 2 }, cb?: (err?: Error) => void): void {
    this.published.push({ topic, payload: JSON.parse(message) as Ack });
    cb?.();
  }

  end(_force?: boolean, cb?: () => void): void {
    cb?.();
  }

  acksFor(cmdId: string): { topic: string; payload: Ack }[] {
    return this.published.filter((p) => p.payload.cmd_id === cmdId);
  }
}

interface RealRoomHandle {
  room: WorldRoom;
  shutdown: () => Promise<void>;
}

/**
 * Boots a real Colyseus `Server` + `WebSocketTransport`, pre-creates the "world" room via
 * `matchMaker.createRoom()` (the exact same low-level entry point `world/src/index.ts`
 * uses at boot, see that file's own doc comment), captures the live `WorldRoom` instance
 * via the `RegisteredHandler`'s "create" event (the same technique `world/src/index.ts`
 * uses to track `activeRoom` for the real IoT bridge, and `persistence.test.ts` uses to
 * count creations) -- no client ever needs to join for this file's assertions, which all
 * read/drive the room server-side.
 *
 * `matchMaker.createRoom()` internally `await`s `room.onCreate()` before resolving (see
 * node_modules/@colyseus/core/build/MatchMaker.mjs's `handleCreateRoom`) and only emits
 * "create" AFTER that -- so by the time this function returns, the room's navmesh/Crowd
 * are fully built and `room.state.agents` already holds the guide-robot fleet (unless
 * `disableGuideRobots` was passed).
 */
async function bootRealRoom(options: Record<string, unknown> = {}): Promise<RealRoomHandle> {
  const port = nextPort++;
  const app = express();
  const httpServer = createServer(app);
  const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }), greet: false });
  const handler = gameServer.define("world", WorldRoom);

  let captured: WorldRoom | undefined;
  handler.on("create", (room) => {
    captured = room;
  });

  await gameServer.listen(port);
  await matchMaker.createRoom("world", options);

  if (!captured) {
    throw new Error("bootRealRoom: matchMaker.createRoom() resolved but the 'create' handler never fired");
  }
  const room = captured;

  // Stop the real wall-clock tick onCreate() started; every scenario below drives
  // simulated time itself via room.update(TICK_MS) -- see this file's header comment.
  room.setSimulationInterval();

  return {
    room,
    shutdown: async () => {
      await gameServer.gracefullyShutdown(false);
    },
  };
}

/** Advances `room` by `ticks` simulated steps of `TICK_MS` each, invoking `onTick` (if
 * given) after every step so callers can track convergence/trailing/separation without
 * duplicating the loop. Returns the number of ticks actually run (== `ticks` unless
 * `onTick` returns `true` to request an early stop, e.g. "target reached"). */
function advance(room: WorldRoom, ticks: number, onTick?: () => boolean | void): number {
  for (let i = 0; i < ticks; i++) {
    room.update(TICK_MS);
    if (onTick?.()) return i + 1;
  }
  return ticks;
}

// ============================================================================================
// Scenario 1: the full happy-path chain, real navigation, real trailing, real ack sequence.
// ============================================================================================
async function testAssignChainEndToEnd(): Promise<void> {
  const { room, shutdown } = await bootRealRoom({ disableSimulatedVisitors: true });
  try {
    assert.equal(
      room.state.agents.size,
      GUIDE_ROBOT_COUNT,
      `a freshly matchMaker-booted room should hold exactly the ${GUIDE_ROBOT_COUNT}-robot guide fleet and nothing else yet`,
    );

    // ---- hop 0: load the Python-generated fixture and cross-check the wire format ----
    const fixtureRaw = readFileSync(
      new URL("./fixtures/pythonAssignCommand.json", import.meta.url),
      "utf-8",
    );
    const fixtureJson: unknown = JSON.parse(fixtureRaw);
    const parsedFixture = parseCommand(fixtureJson);
    assert.ok(
      parsedFixture,
      "the Python-generated assign Command fixture must parse via messages.ts's real parseCommand() -- " +
        "proves the JS/TS wire schema agrees with shared/guidemate_msgs/guidemate_msgs/messages.py, not just in theory",
    );
    assert.equal(parsedFixture!.type, "assign");
    assert.equal(parsedFixture!.name, "assign");
    assert.equal(typeof parsedFixture!.params.visitor_id, "string");
    assert.equal(typeof parsedFixture!.params.room, "string");
    console.log(
      "PASS: Python-generated assign Command fixture (shared/guidemate_msgs) round-trips " +
        "unchanged through messages.ts's parseCommand",
    );

    const visitorId = parsedFixture!.params.visitor_id as string;
    const roomName = parsedFixture!.params.room as string;

    // ---- the destination room ----
    // NOTE on route length: a real visitor always spawns at the entrance, but the ASSIGNED
    // ROBOT does not -- `requestGuide` picks the idle robot nearest to the VISITOR (i.e.
    // nearest to the entrance), and the 50-robot fleet's deterministic spawn grid
    // (guideFleetSpawns.ts) happens to cluster on the building's west/south side, which is
    // also where several room doors sit. Measured empirically (world/scripts's
    // dumpspawns-style probe against computeGuideFleetSpawns): the entrance-nearest robot
    // ("virtual/50") spawns at (10.00, 6.06), only ~4.5m from "South Collaboration Space"'s
    // door -- picking THAT room as the destination would make the robot's own trip trivially
    // short (a few seconds) regardless of how far the VISITOR itself has to travel, which
    // is exactly the scenario `testEscortEndsWithGuideRobotNotVisitorArrival` below
    // deliberately exploits to document a real defect this test file found. To prove
    // genuine, non-trivial ROBOT navigation here in the happy-path scenario, "1408" is used
    // instead: ~23.6m from virtual/50's spawn point (the farthest of any room from it) --
    // asserted below from the robot's actual live position, not assumed.
    const plan = loadFloorPlan();
    const entrance = room.getEntrancePoint();
    const destRoom = plan.rooms.find((r) => r.name === roomName);
    assert.ok(destRoom, `floor-14.json should contain "${roomName}"`);
    const [doorX, doorZ] = destRoom!.door;

    // ---- hop 1: real assign Command through the real IotBridge, on the real fleet topic ----
    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => room as unknown as WorldRoomLike, client, log: QUIET_LOG });

    const cmdId = newCmdId();
    const command: Command = { ...(parsedFixture as Command), cmd_id: cmdId };
    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(command));

    const acks = client.acksFor(cmdId);
    assert.deepEqual(
      acks.map((a) => a.payload.state),
      ["received", "done"],
      `assign should ack received -> done synchronously (no async navigate polling for the assign command itself); ` +
        `got ${JSON.stringify(acks.map((a) => a.payload.state))}`,
    );
    for (const { topic } of acks) {
      assert.equal(
        topic,
        fleetStatusTopic(),
        "assign acks must publish on the FLEET status topic -- proves the command was routed through " +
          "handleFleetCommand and NOT misrouted through the per-robot extractRobotId path (fleetCmdTopic() " +
          'structurally matches the per-robot wildcard regex, extracting "virtual/fleet" as a fake robot id, ' +
          "if the fleet-topic-first check in handleMessage() were ever removed)",
      );
    }
    const doneAck = acks.find((a) => a.payload.state === "done")!.payload;
    const assignedRobotId = doneAck.assigned_robot_id;
    assert.ok(assignedRobotId, "the done ack must carry assigned_robot_id");
    assert.match(
      assignedRobotId!,
      /^virtual\/\d+$/,
      `assigned robot id should be a real virtual-fleet robot id (virtual/N), got "${assignedRobotId}"`,
    );
    // never any per-robot-topic ack for this cmd_id either
    assert.equal(
      client.published.some((p) => p.topic === statusTopic(assignedRobotId!) && p.payload.cmd_id === cmdId),
      false,
      "the assign command must never also produce a per-robot-topic ack",
    );
    console.log(
      `PASS: assign command routed via ${fleetCmdTopic()}, acked received -> done on ${fleetStatusTopic()}, ` +
        `assigned real fleet robot "${assignedRobotId}"`,
    );

    // ---- hop 2: the visitor was actually spawned into the world ----
    const visitorAgent = room.state.agents.get(visitorId);
    assert.ok(visitorAgent, `visitor "${visitorId}" should have been spawned into the world by the assign handler`);
    assert.equal(visitorAgent!.kind, "visitor");
    assert.equal(visitorAgent!.x, entrance.x);
    assert.equal(visitorAgent!.z, entrance.z);
    console.log(`PASS: visitor "${visitorId}" spawned at the entrance (${entrance.x.toFixed(2)}, ${entrance.z.toFixed(2)})`);

    const robotAgent = room.state.agents.get(assignedRobotId!);
    assert.ok(robotAgent, `assigned robot "${assignedRobotId}" should be a tracked agent`);
    assert.equal(robotAgent!.kind, "robot");

    // The robot's OWN trip distance (its live spawn position -> the destination door) is the
    // metric that determines how long the escort stays bound -- see the NOTE above.
    const robotStart = { x: robotAgent!.x, z: robotAgent!.z };
    const robotTripDistance = Math.hypot(doorX - robotStart.x, doorZ - robotStart.z);
    assert.ok(
      robotTripDistance > 10,
      `test setup: assigned robot "${assignedRobotId}"'s own trip to "${roomName}" should be genuinely long (>10m); ` +
        `got ${robotTripDistance.toFixed(2)}m from (${robotStart.x.toFixed(2)}, ${robotStart.z.toFixed(2)}) -- ` +
        "pick a farther-from-the-fleet room if floor-14.json or the fleet spawn grid changed",
    );
    console.log(
      `[setup] entrance (${entrance.x.toFixed(2)}, ${entrance.z.toFixed(2)}) -> robot "${assignedRobotId}" spawn ` +
        `(${robotStart.x.toFixed(2)}, ${robotStart.z.toFixed(2)}) -> "${roomName}" door: robot's own trip is ${robotTripDistance.toFixed(2)}m`,
    );

    // ---- hop 3: advance REAL simulated time -- the robot must actually navigate to the door ----
    const visitorStart = { x: visitorAgent!.x, z: visitorAgent!.z };
    let robotDoorDist = Infinity;
    let visitorMovedTotal = 0;
    let sawNonTrivialSeparation = false;
    let lastVisitorPos = { ...visitorStart };

    const MAX_TICKS = 4200; // ~69.7s simulated -- generous headroom over visitors.test.ts's
    // measured ~25.9s for a slightly shorter (~18.42m) trip with the same 50-robot fleet present
    const ticksRun = advance(room, MAX_TICKS, () => {
      const robot = room.state.agents.get(assignedRobotId!)!;
      const visitor = room.state.agents.get(visitorId)!;

      robotDoorDist = Math.hypot(robot.x - doorX, robot.z - doorZ);

      const step = Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
      visitorMovedTotal += step;
      lastVisitorPos = { x: visitor.x, z: visitor.z };

      const separation = Math.hypot(visitor.x - robot.x, visitor.z - robot.z);
      if (separation > 0.15) sawNonTrivialSeparation = true;

      return robotDoorDist <= DOOR_TOLERANCE_M;
    });

    assert.ok(
      robotDoorDist <= DOOR_TOLERANCE_M,
      `assigned robot "${assignedRobotId}" did not converge within ${DOOR_TOLERANCE_M}m of "${roomName}"'s door ` +
        `after ${ticksRun} ticks; last distance ${robotDoorDist.toFixed(2)}m`,
    );
    console.log(
      `PASS: robot "${assignedRobotId}" navigated its ${robotTripDistance.toFixed(2)}m trip and converged to within ` +
        `${robotDoorDist.toFixed(2)}m of "${roomName}"'s door in ${ticksRun} ticks (${(ticksRun * (TICK_MS / 1000)).toFixed(1)}s simulated)`,
    );

    // ---- hop 4: the visitor genuinely follows -- trails behind, does not teleport/collapse ----
    // Keep ticking a bounded extra window for the escort to settle/un-bind, same pattern as
    // visitors.test.ts -- the robot reaches the door before the visitor (who is still trailing
    // a real distance behind), so the distance tally keeps running through this settle window too.
    const MAX_SETTLE_TICKS = 2500;
    let settled = false;
    advance(room, MAX_SETTLE_TICKS, () => {
      const visitor = room.state.agents.get(visitorId)!;
      const robot = room.state.agents.get(assignedRobotId!)!;
      const step = Math.hypot(visitor.x - lastVisitorPos.x, visitor.z - lastVisitorPos.z);
      visitorMovedTotal += step;
      lastVisitorPos = { x: visitor.x, z: visitor.z };
      if (Math.hypot(visitor.x - robot.x, visitor.z - robot.z) > 0.15) sawNonTrivialSeparation = true;
      if (room.getVisitorDebugStats().robotBindings === 0) settled = true;
      return settled;
    });
    assert.ok(settled, "escort binding should be released once the robot arrives and settles to idle");

    const visitorNetDisplacement = Math.hypot(lastVisitorPos.x - visitorStart.x, lastVisitorPos.z - visitorStart.z);
    const visitorFinalDoorDist = Math.hypot(lastVisitorPos.x - doorX, lastVisitorPos.z - doorZ);
    const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
    console.log(
      `[evidence] visitor moved ${visitorMovedTotal.toFixed(2)}m total, net displacement ${visitorNetDisplacement.toFixed(2)}m, ` +
        `final distance to "${roomName}"'s door ${visitorFinalDoorDist.toFixed(2)}m (straight-line entrance-to-door was ` +
        `${entranceToDoorDistance.toFixed(2)}m; robot's own trip was ${robotTripDistance.toFixed(2)}m)`,
    );
    // "not stationary": in the fetch-then-lead flow the visitor WAITS at the entrance while
    // the robot comes to fetch it and greets it, then trails the robot only during the
    // LEADING phase -- so the visitor's own trip is roughly the entrance-to-door distance
    // (its trailing conga path, plus wiggle, over that leg), NOT the robot's much longer
    // spawn-to-door trip (the robot's extra distance was spent BEFORE the visitor ever moved,
    // coming to get it). So this is measured against entranceToDoorDistance.
    assert.ok(
      visitorMovedTotal > entranceToDoorDistance * 0.8,
      `visitor "${visitorId}" should have covered real ground while trailing the robot over the leading leg ` +
        `(~${entranceToDoorDistance.toFixed(2)}m entrance-to-door; moved ${visitorMovedTotal.toFixed(2)}m total) -- not stationary`,
    );
    // "actually arrived near the destination": the visitor's net displacement from its own
    // spawn should land it close to the door, not off wandering somewhere else -- measured
    // against the real straight-line entrance-to-door distance (the meaningful bar for
    // "did the visitor get where they asked to go", independent of how far the ROBOT itself
    // had to travel to get there).
    // Bound derived from the completion contract: the robot is within DOOR_TOLERANCE_M of the
    // door and the visitor releases within VISITOR_ARRIVAL_DISTANCE_M (2.5m) of the robot, so
    // the visitor can be up to ~3.5m from the door at release. (The old ~1m emergent packing was
    // an artifact of the idle-only gate, which is not robust when parked fleet robots crowd a
    // busy door -- see ROBOT_ARRIVAL_TOLERANCE_M in escortManager.ts.)
    assert.ok(
      visitorFinalDoorDist <= DOOR_TOLERANCE_M + 2.5,
      `visitor "${visitorId}" should end up near "${roomName}"'s door (within ${(DOOR_TOLERANCE_M + 2.5).toFixed(1)}m, ` +
        `the robot-at-door + visitor-arrival-radius contract) -- got ${visitorFinalDoorDist.toFixed(2)}m`,
    );
    assert.ok(
      visitorNetDisplacement > entranceToDoorDistance * 0.5,
      `visitor's net displacement (${visitorNetDisplacement.toFixed(2)}m) should be a meaningful fraction of the real ` +
        `entrance-to-door distance (${entranceToDoorDistance.toFixed(2)}m), not stuck near its spawn point`,
    );
    assert.ok(sawNonTrivialSeparation, `visitor "${visitorId}" should stay a real trailing distance behind the robot, not overlap it`);
    console.log(
      `PASS: visitor "${visitorId}" genuinely followed (moved ${visitorMovedTotal.toFixed(2)}m total, net displacement ` +
        `${visitorNetDisplacement.toFixed(2)}m, trailed behind, never collapsed onto the robot)`,
    );

    // ---- hop 5: escort released, robot back in the idle pool (provably selectable again) ----
    const statsAfterArrival = room.getVisitorDebugStats();
    assert.equal(statsAfterArrival.robotBindings, 0, "robot binding should be released on arrival");

    // The robot may still read "moving" the instant it released (a trailing visitor packing
    // against it keeps its speed flickering above idle, and it heads home once free), and
    // requestGuide only picks IDLE robots -- so let it settle to idle first, then prove it is
    // reassignable by spawning a fresh visitor at its then-position (unambiguously the nearest).
    let arrivedRobotIdle = false;
    advance(room, 4000, () => {
      arrivedRobotIdle = room.state.agents.get(assignedRobotId!)!.state === "idle";
      return arrivedRobotIdle;
    });
    assert.ok(arrivedRobotIdle, "the freed robot should settle to idle after finishing its escort");
    const arrivedRobot = room.state.agents.get(assignedRobotId!)!;
    room.addAgent("assign-chain-reuse-probe", "visitor", { x: arrivedRobot.x, z: arrivedRobot.z });
    const reuseResult = room.requestGuide("assign-chain-reuse-probe", entrance);
    assert.equal(
      reuseResult?.robotId,
      assignedRobotId,
      `robot "${assignedRobotId}" should be selectable again for a new escort immediately after finishing the previous one`,
    );
    console.log(`PASS: escort binding released on arrival; robot "${assignedRobotId}" returned to the idle pool and was reassigned`);
  } finally {
    await shutdown();
  }
}

// ============================================================================================
// Scenario 1b (3-phase escort through the real chain + FIX VERIFICATION). Proves the
// fetch-then-lead flow end to end over the real IotBridge/WorldRoom:
//   - approaching: the assigned robot goes to FETCH the visitor (which spawned at the
//     entrance); the visitor waits in place and the escort stays bound the whole time.
//   - greeting:   once the robot reaches the visitor, both pause together for ~10-15s.
//   - leading:    the robot leads the visitor to the destination; completion is gated on the
//     VISITOR catching up (the existing visitor-arrival gating, see
//     VISITOR_ARRIVAL_DISTANCE_M's doc comment in escortManager.ts), NOT just the robot's own
//     idle state.
// It also fixes the "wait for ALL bindings to clear" artifact the old version had: the
// premature-reassign probe below deliberately binds ANOTHER fleet robot (an incidental second
// escort), and the charging-station return-home retasks freed robots, so `robotBindings === 0`
// is the WRONG signal for THIS one escort releasing. Release is detected on the SPECIFIC
// assigned robot's binding clearing via `VisitorManager.isRobotEscorting(assignedRobotId)`
// (reached through the room's private `visitors` field, a test-only cast in the same spirit as
// the existing `room.state as unknown as {...}` casts). A generous escortTimeoutSeconds
// override keeps the ESCORT_TIMEOUT_S safety valve (covered separately in visitors.test.ts's
// `testEscortTimeoutStillFiresWhenVisitorNeverCatchesUp`) from cutting a genuine catch-up off
// and being misread as "arrived".
// ============================================================================================
async function testEscortEndsOnVisitorArrivalNotJustRobot(): Promise<void> {
  const { room, shutdown } = await bootRealRoom({
    disableSimulatedVisitors: true,
    // Generous override (vs. the real 90s default) purely to decouple THIS test's claim
    // ("the visitor genuinely arrives") from the timeout safety valve, which is covered
    // separately -- see the block comment above.
    visitorManagerOptions: { escortTimeoutSeconds: 180 },
  });
  try {
    // Test-only reach into the room's private VisitorManager to check the SPECIFIC assigned
    // robot's escort binding (there is no public per-robot accessor on WorldRoom, and
    // robotBindings === 0 is the wrong signal here -- see the block comment above).
    const escorting = (robotId: string): boolean =>
      (room as unknown as { visitors: { isRobotEscorting(id: string): boolean } }).visitors.isRobotEscorting(robotId);

    const plan = loadFloorPlan();
    const entrance = room.getEntrancePoint();
    const targetRoomName = "South Collaboration Space"; // the room farthest from the entrance
    const destRoom = plan.rooms.find((r) => r.name === targetRoomName)!;
    const [doorX, doorZ] = destRoom.door;
    const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
    assert.ok(
      entranceToDoorDistance > 15,
      "test setup: the visitor's own entrance-to-door trip must be genuinely long for the leading leg to be meaningful",
    );

    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => room as unknown as WorldRoomLike, client, log: QUIET_LOG });
    const cmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: cmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-fix-probe", room: targetRoomName },
        ts: new Date().toISOString(),
      } satisfies Command),
    );
    const doneAck = client.acksFor(cmdId).find((a) => a.payload.state === "done")!.payload;
    const assignedRobotId = doneAck.assigned_robot_id!;
    const robotStart = { ...room.state.agents.get(assignedRobotId)! };
    const visitorStart = { ...room.state.agents.get("chain-visitor-fix-probe")! };
    assert.equal(escorting(assignedRobotId), true, "the assigned robot should be escorting immediately after assign");

    // ---- PHASE 1 (approaching): the robot fetches the WAITING person ----
    // Advance until the robot reaches the person (idle within the arrival radius of the
    // person). Throughout, the escort must stay bound and the person must stay put. Early in
    // the approach, run the premature-reassign probe: the still-owed robot must NOT be handed
    // to another visitor.
    let approachEndTicks = -1;
    let approachDisp = 0;
    let prematureChecked = false;
    for (let i = 0; i < 6000 && approachEndTicks < 0; i++) {
      room.update(TICK_MS);
      const robot = room.state.agents.get(assignedRobotId)!;
      const visitor = room.state.agents.get("chain-visitor-fix-probe")!;
      assert.equal(escorting(assignedRobotId), true, "the assigned robot must stay bound to its visitor throughout approaching");

      if (!prematureChecked && i === 30) {
        // The real fleet is present, so requestGuide should hand out some OTHER idle robot for
        // this probe (or none) -- never the still-owed assignedRobotId.
        room.addAgent("chain-visitor-fix-premature-probe", "visitor", { x: robotStart.x, z: robotStart.z });
        const prematureReassign = room.requestGuide("chain-visitor-fix-premature-probe", { x: robotStart.x, z: robotStart.z });
        assert.notEqual(
          prematureReassign.robotId,
          assignedRobotId,
          "the still-owed robot must NOT be reassignable to a new visitor while it is still escorting its own",
        );
        assert.equal(escorting(assignedRobotId), true, "the assigned robot is still bound to its own visitor after the premature probe");
        prematureChecked = true;
      }

      const dist = Math.hypot(robot.x - visitor.x, robot.z - visitor.z);
      if (robot.state === "idle" && dist <= 2.5 && i > 30) {
        approachEndTicks = i;
        approachDisp = Math.hypot(visitor.x - visitorStart.x, visitor.z - visitorStart.z);
      }
    }
    assert.ok(approachEndTicks > 0, "the robot should reach the waiting person during approaching");
    assert.ok(prematureChecked, "the premature-reassign probe should have run during approaching");
    assert.ok(
      approachDisp < 1.5,
      `the person should wait in place while the robot fetches it (net displacement ${approachDisp.toFixed(2)}m during approaching)`,
    );
    console.log(
      `[evidence] robot "${assignedRobotId}" fetched the waiting visitor (person moved ${approachDisp.toFixed(2)}m during approaching); ` +
        "escort stayed bound and the still-owed robot was never handed to the premature probe",
    );

    // ---- PHASE 2 (greeting): both stay put ~10-15s before leading ----
    let greetTicks = 0;
    let maxGreetDist = 0;
    let leadStarted = false;
    let greetCum = 0;
    const v0 = room.state.agents.get("chain-visitor-fix-probe")!;
    let lastV = { x: v0.x, z: v0.z };
    for (let i = 0; i < 3000 && !leadStarted; i++) {
      room.update(TICK_MS);
      greetTicks++;
      const robot = room.state.agents.get(assignedRobotId)!;
      const visitor = room.state.agents.get("chain-visitor-fix-probe")!;
      maxGreetDist = Math.max(maxGreetDist, Math.hypot(robot.x - visitor.x, robot.z - visitor.z));
      greetCum += Math.hypot(visitor.x - lastV.x, visitor.z - lastV.z);
      lastV = { x: visitor.x, z: visitor.z };
      if (greetCum > 0.5) leadStarted = true; // visitor set off => leading has begun
    }
    assert.ok(leadStarted, "leading should begin after the greeting pause");
    const greetDuration = (greetTicks * TICK_MS) / 1000;
    assert.ok(
      greetDuration >= 9 && greetDuration <= 16.5,
      `greeting pause should last ~10-15s of simulated time before leading (got ${greetDuration.toFixed(2)}s)`,
    );
    assert.ok(maxGreetDist <= 2.6, `robot and person should stay together during greeting (max ${maxGreetDist.toFixed(2)}m)`);

    const visitorAtLeadStart = room.state.agents.get("chain-visitor-fix-probe")!;
    const visitorDoorDistAtLeadStart = Math.hypot(visitorAtLeadStart.x - doorX, visitorAtLeadStart.z - doorZ);
    console.log(
      `[evidence] greeting pause lasted ${greetDuration.toFixed(2)}s (max sep ${maxGreetDist.toFixed(2)}m); leading began with the ` +
        `visitor ${visitorDoorDistAtLeadStart.toFixed(2)}m from "${targetRoomName}"'s door`,
    );

    // ---- PHASE 3 (leading): the visitor follows; the escort releases only once the visitor
    // catches up. Detected on the SPECIFIC assigned robot's binding clearing (NOT robotBindings
    // === 0 -- the premature probe bound another robot). ----
    let released = false;
    for (let i = 0; i < 6000 && !released; i++) {
      room.update(TICK_MS);
      released = !escorting(assignedRobotId);
    }
    assert.ok(released, "the assigned robot's escort should release once its visitor catches up during leading");

    const visitorAtRelease = room.state.agents.get("chain-visitor-fix-probe")!;
    const robotAtRelease = room.state.agents.get(assignedRobotId)!;
    const visitorDoorDistAtRelease = Math.hypot(visitorAtRelease.x - doorX, visitorAtRelease.z - doorZ);
    const finalSeparation = Math.hypot(visitorAtRelease.x - robotAtRelease.x, visitorAtRelease.z - robotAtRelease.z);
    console.log(
      `[evidence] the assigned robot's escort released with the visitor ${visitorDoorDistAtRelease.toFixed(2)}m from "${targetRoomName}"'s door ` +
        `(was ${visitorDoorDistAtLeadStart.toFixed(2)}m away when leading began), final robot-visitor separation ${finalSeparation.toFixed(2)}m`,
    );
    assert.ok(
      visitorDoorDistAtRelease < visitorDoorDistAtLeadStart,
      "the visitor should have gotten meaningfully closer to the door between leading starting and the escort releasing",
    );
    // Bound derived from the completion contract (robot within DOOR_TOLERANCE_M of the door +
    // visitor within VISITOR_ARRIVAL_DISTANCE_M of the robot at release), so up to ~3.5m from
    // the door -- see the matching note in testAssignChainEndToEnd.
    assert.ok(
      visitorDoorDistAtRelease <= DOOR_TOLERANCE_M + 2.5,
      `the visitor should end up near "${targetRoomName}"'s door (within ${(DOOR_TOLERANCE_M + 2.5).toFixed(1)}m, the ` +
        `robot-at-door + visitor-arrival-radius contract) once the escort releases -- got ${visitorDoorDistAtRelease.toFixed(2)}m`,
    );
    // Release fires once the visitor is within the arrival radius (VISITOR_ARRIVAL_DISTANCE_M =
    // 2.5m) of the robot-at-destination -- the documented completion contract.
    assert.ok(
      finalSeparation <= 2.5,
      `the visitor should have caught up to within the arrival radius of the robot before the escort released -- got ${finalSeparation.toFixed(2)}m apart`,
    );
    // The robot may still read "moving" at release (the trailing visitor packing against it,
    // plus parked fleet robots crowding a busy door, keep its speed flickering above idle); the
    // meaningful check is that it has genuinely reached the destination door.
    assert.ok(
      Math.hypot(robotAtRelease.x - doorX, robotAtRelease.z - doorZ) <= DOOR_TOLERANCE_M * 2,
      `the escorting robot should be at the destination door when its escort releases (got ${Math.hypot(robotAtRelease.x - doorX, robotAtRelease.z - doorZ).toFixed(2)}m)`,
    );

    // NOW the specific robot is legitimately free. It may still be "moving" the instant it
    // released (jittering at the crowded door, then heading home once free), and requestGuide
    // only picks IDLE robots, so let it settle to idle first, then prove it is reassignable
    // (spawn the probe at the robot's then-position so it is unambiguously the nearest idle one).
    let robotSettledIdle = false;
    advance(room, 4000, () => {
      robotSettledIdle = room.state.agents.get(assignedRobotId)!.state === "idle" && !escorting(assignedRobotId);
      return robotSettledIdle;
    });
    assert.ok(robotSettledIdle, "the freed robot should settle to idle after finishing its escort (no deadlock)");
    const robotSettled = room.state.agents.get(assignedRobotId)!;
    room.addAgent("chain-visitor-fix-reuse-probe", "visitor", { x: robotSettled.x, z: robotSettled.z });
    const reassign = room.requestGuide("chain-visitor-fix-reuse-probe", { x: robotSettled.x, z: robotSettled.z });
    assert.equal(
      reassign.robotId,
      assignedRobotId,
      "the assigned robot should be selectable again for a new escort once it settles after genuinely finishing the previous one",
    );
    console.log(
      `PASS: 3-phase escort over the real chain -- robot fetched the waiting visitor, greeted (${greetDuration.toFixed(2)}s), led it to ` +
        `the door, released only once the visitor caught up (${visitorDoorDistAtRelease.toFixed(2)}m from the door), and was reassignable right after`,
    );
  } finally {
    await shutdown();
  }
}

// ============================================================================================
// Scenario 2: no_idle_robot, against a REAL room, through the REAL bridge -- every robot
// already escorting when a second assign for a different visitor arrives.
// ============================================================================================
async function testNoIdleRobotThroughRealChain(): Promise<void> {
  const { room, shutdown } = await bootRealRoom({ disableGuideRobots: true, disableSimulatedVisitors: true });
  try {
    const entrance = room.getEntrancePoint();
    const added = room.addAgent("chain-only-robot", "robot", entrance);
    assert.ok(added, "test setup: adding the single robot must succeed");

    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => room as unknown as WorldRoomLike, client, log: QUIET_LOG });

    const firstCmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: firstCmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-1", room: "Kitchen" },
        ts: new Date().toISOString(),
      } satisfies Command),
    );
    assert.deepEqual(
      client.acksFor(firstCmdId).map((a) => a.payload.state),
      ["received", "done"],
      "the first visitor should succeed (the one robot is idle)",
    );

    const secondCmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: secondCmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-2", room: "Kitchen" },
        ts: new Date().toISOString(),
      } satisfies Command),
    );
    const secondAcks = client.acksFor(secondCmdId);
    assert.deepEqual(
      secondAcks.map((a) => a.payload.state),
      ["received", "failed"],
      "the second visitor should fail: the only robot is already escorting",
    );
    assert.equal(secondAcks.find((a) => a.payload.state === "failed")!.payload.reason, "no_idle_robot");
    assert.equal(secondAcks.find((a) => a.payload.state === "failed")!.payload.assigned_robot_id, null);

    // The second visitor is still spawned into the world (addAgent runs before requestGuide
    // is even attempted) -- it just isn't escorted yet.
    const secondVisitor = room.state.agents.get("chain-visitor-2");
    assert.ok(secondVisitor, "the second visitor should still be spawned into the world despite the failed assign");
    assert.equal(secondVisitor!.kind, "visitor");

    console.log("PASS: no_idle_robot through the real chain -- second assign fails cleanly, visitor still spawned, no double-assignment");
  } finally {
    await shutdown();
  }
}

// ============================================================================================
// Scenario 3 (bonus, FIX VERIFICATION): assign naming a room that does not exist -> a real
// failure ack, not a crash, and the idle robot must NOT be consumed by the doomed attempt.
// This used to document a real defect this test file found: WorldRoomLike.requestGuide's
// return type collapsed "no robot was idle" and "an idle robot existed but the target room
// name didn't resolve" into the same bare `null`, so bridge.ts's handleFleetCommand always
// attributed a failed assign to reason "no_idle_robot" -- misleading here, since an idle
// robot was very much available. Fixed: requestGuide now returns `{ robotId: null, reason }`
// with a distinct "target_unresolved" reason (the SAME string bridge.ts's per-robot
// `navigate` path already uses for its own unresolved-target failure), and the bridge relays
// whatever reason requestGuide gives it instead of hardcoding "no_idle_robot".
// ============================================================================================
async function testAssignToNonexistentRoom(): Promise<void> {
  const { room, shutdown } = await bootRealRoom({ disableGuideRobots: true, disableSimulatedVisitors: true });
  try {
    const entrance = room.getEntrancePoint();
    room.addAgent("chain-only-robot-2", "robot", entrance);

    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => room as unknown as WorldRoomLike, client, log: QUIET_LOG });

    const cmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: cmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-bad-room", room: "Room That Does Not Exist 9999" },
        ts: new Date().toISOString(),
      } satisfies Command),
    );

    const acks = client.acksFor(cmdId);
    assert.deepEqual(
      acks.map((a) => a.payload.state),
      ["received", "failed"],
      "assigning a nonexistent room must ack failed, never throw or hang",
    );
    const failedAck = acks.find((a) => a.payload.state === "failed")!.payload;
    console.log(`[evidence] assign to a nonexistent room failed with reason="${failedAck.reason}"`);

    // FIX VERIFIED: an idle robot WAS available here (chain-only-robot-2), so the failure
    // must be attributed to the target not resolving, not misreported as "no_idle_robot" --
    // see the block comment above.
    assert.equal(
      failedAck.reason,
      "target_unresolved",
      "an idle robot was available; the failure must be attributed to the unresolvable room name, not misreported as no_idle_robot",
    );

    // The idle robot must not have been silently consumed by the doomed attempt.
    const robot = room.state.agents.get("chain-only-robot-2")!;
    assert.equal(robot.state, "idle", "the idle robot must not be left bound/consumed by an assign that failed to resolve its target");
    assert.equal(room.getVisitorDebugStats().robotBindings, 0, "no escort binding should exist after a failed-to-resolve assign");

    // And the SAME robot must still be usable for a real, valid assign right after.
    const followupCmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: followupCmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-followup", room: "Kitchen" },
        ts: new Date().toISOString(),
      } satisfies Command),
    );
    const followupAcks = client.acksFor(followupCmdId);
    assert.deepEqual(followupAcks.map((a) => a.payload.state), ["received", "done"]);
    assert.equal(followupAcks.find((a) => a.payload.state === "done")!.payload.assigned_robot_id, "chain-only-robot-2");

    console.log(
      "PASS: assign to a nonexistent room acks failed (not a crash) without consuming the idle robot; " +
        "the same robot was successfully assigned right after",
    );
  } finally {
    await shutdown();
  }
}

async function main(): Promise<void> {
  await testAssignChainEndToEnd();
  await testEscortEndsOnVisitorArrivalNotJustRobot();
  await testNoIdleRobotThroughRealChain();
  await testAssignToNonexistentRoom();

  console.log("\nALL PASS: assignChain.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
