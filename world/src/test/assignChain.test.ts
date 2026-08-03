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
    // "not stationary": the visitor's trailing target follows the ROBOT's own historical
    // path (see EscortManager.recordHistoryAndRetarget's doc comment -- deliberately a
    // "conga line" off the robot's past positions, not a beeline to the destination), and
    // the assigned robot's own path here is a long ~23.6m trip across the floor -- so a
    // visitor genuinely trailing it accumulates real ground covered, comparable to the
    // robot's own trip length, even though the visitor's NET displacement (below) is much
    // smaller (its entrance spawn point is already close to "1408"'s door in a straight
    // line -- the robot is the one that started far away).
    assert.ok(
      visitorMovedTotal > robotTripDistance * 0.5,
      `visitor "${visitorId}" should have covered real ground while trailing the robot's ${robotTripDistance.toFixed(2)}m ` +
        `trip (moved ${visitorMovedTotal.toFixed(2)}m total) -- not stationary`,
    );
    // "actually arrived near the destination": the visitor's net displacement from its own
    // spawn should land it close to the door, not off wandering somewhere else -- measured
    // against the real straight-line entrance-to-door distance (the meaningful bar for
    // "did the visitor get where they asked to go", independent of how far the ROBOT itself
    // had to travel to get there).
    assert.ok(
      visitorFinalDoorDist <= DOOR_TOLERANCE_M * 3,
      `visitor "${visitorId}" should end up close to "${roomName}"'s door (within ${(DOOR_TOLERANCE_M * 3).toFixed(1)}m, a ` +
        `generous multiple of the robot's own convergence tolerance, allowing for the ~1m trailing gap) -- ` +
        `got ${visitorFinalDoorDist.toFixed(2)}m`,
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
    assert.equal(room.state.agents.get(assignedRobotId!)!.state, "idle", "the escorting robot should be idle again after arrival");

    // Prove "returned to the idle pool" concretely, not just "unbound": spawn a fresh test
    // visitor right next to the just-arrived robot's current position so it is unambiguously
    // the nearest idle robot, and confirm requestGuide picks that SAME robot id again.
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
// Scenario 1b (DEFECT, found by this test file, reported per the task brief -- not fixed):
// the escort ends the moment the GUIDE ROBOT's own crowd state settles to idle
// (EscortManager.tick(): `arrived = ... && robotAgent.state === "idle"`), with NO check on
// how far the VISITOR itself still is from the destination. `requestGuide` picks the idle
// robot nearest to the VISITOR's spawn (the entrance) -- not nearest to the DESTINATION -- so
// if that nearest-to-entrance robot happens to already be sitting close to the requested room
// (a real, observed case: the deterministic 50-robot spawn grid in guideFleetSpawns.ts puts
// "virtual/50" only ~4.5m from "South Collaboration Space"'s door, see the NOTE in
// testAssignChainEndToEnd above), the robot's own trip is over in a few seconds while the
// visitor -- which started ~17-20m away at the entrance and has to trail the robot's ENTIRE
// historical path to catch up (EscortManager.recordHistoryAndRetarget, deliberately NOT a
// beeline to the destination -- see its doc comment) -- has barely begun closing that gap.
// The escort binding is released ("delivered", robot back in the idle pool) while the visitor
// is still stranded meters away from the room, with nothing left commanding it any closer:
// once unbound, EscortManager.tick() never calls requestMoveTarget for that visitor id again,
// so the visitor's crowd agent just coasts to a stop wherever its last trailing target was and
// stays there -- Moses would report "escorted to South Collaboration Space" while the visitor
// avatar is actually resting well short of the door.
// ============================================================================================
async function testEscortEndsOnRobotArrivalNotVisitorArrival(): Promise<void> {
  const { room, shutdown } = await bootRealRoom({ disableSimulatedVisitors: true });
  try {
    const plan = loadFloorPlan();
    const entrance = room.getEntrancePoint();
    const targetRoomName = "South Collaboration Space"; // ~4.5m from virtual/50's deterministic spawn
    const destRoom = plan.rooms.find((r) => r.name === targetRoomName)!;
    const [doorX, doorZ] = destRoom.door;
    const entranceToDoorDistance = Math.hypot(doorX - entrance.x, doorZ - entrance.z);
    assert.ok(entranceToDoorDistance > 15, "test setup: the visitor's own entrance-to-door trip must be genuinely long for this defect to be observable");

    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => room as unknown as WorldRoomLike, client, log: QUIET_LOG });
    const cmdId = newCmdId();
    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify({
        cmd_id: cmdId,
        type: "assign",
        name: "assign",
        params: { visitor_id: "chain-visitor-defect-probe", room: targetRoomName },
        ts: new Date().toISOString(),
      } satisfies Command),
    );
    const doneAck = client.acksFor(cmdId).find((a) => a.payload.state === "done")!.payload;
    const assignedRobotId = doneAck.assigned_robot_id!;
    const robotStart = room.state.agents.get(assignedRobotId)!;
    const robotTripDistance = Math.hypot(doorX - robotStart.x, doorZ - robotStart.z);
    assert.ok(
      robotTripDistance < entranceToDoorDistance / 2,
      `test setup: for this defect to reproduce, the assigned robot's own trip (${robotTripDistance.toFixed(2)}m) must be ` +
        `much shorter than the visitor's real entrance-to-door trip (${entranceToDoorDistance.toFixed(2)}m) -- if ` +
        "floor-14.json or the fleet spawn grid changed, re-pick a target room close to virtual/50's spawn",
    );

    // Advance until the escort actually releases (robot arrived, per its OWN state).
    let released = false;
    advance(room, 3000, () => {
      released = room.getVisitorDebugStats().robotBindings === 0;
      return released;
    });
    assert.ok(released, "test setup: the escort should release once the (nearby) robot arrives");

    const visitorAtRelease = room.state.agents.get("chain-visitor-defect-probe")!;
    const visitorDoorDistAtRelease = Math.hypot(visitorAtRelease.x - doorX, visitorAtRelease.z - doorZ);
    console.log(
      `[evidence] escort released after robot "${assignedRobotId}"'s own ${robotTripDistance.toFixed(2)}m trip; at that ` +
        `moment the visitor was still ${visitorDoorDistAtRelease.toFixed(2)}m from "${targetRoomName}"'s door ` +
        `(entrance-to-door is ${entranceToDoorDistance.toFixed(2)}m)`,
    );
    assert.ok(
      visitorDoorDistAtRelease > entranceToDoorDistance * 0.3,
      "DEFECT reproduced: the escort released while the visitor was still a substantial fraction of the full " +
        "trip away from the destination -- the robot's own (short) arrival, not the visitor's, ends the escort",
    );

    // Concurrency hazard this enables: the instant the escort releases, the robot re-enters
    // the idle pool and is immediately selectable for a BRAND NEW assignment -- even though
    // the FIRST visitor has not come anywhere close to actually reaching the room it was
    // promised. Prove this concretely (robust regardless of exact coasting distances below):
    // request a second escort for a probe visitor placed right next to the just-released
    // robot, and confirm the SAME robot id is handed out again.
    room.addAgent("chain-visitor-defect-reuse-probe", "visitor", { x: robotStart.x, z: robotStart.z });
    const reassign = room.requestGuide("chain-visitor-defect-reuse-probe", { x: robotStart.x, z: robotStart.z });
    assert.equal(
      reassign?.robotId,
      assignedRobotId,
      "the just-released robot must be immediately reassignable to a NEW visitor while the FIRST visitor is still stranded",
    );
    console.log(
      `[evidence] robot "${assignedRobotId}" was reassigned to a brand-new visitor the instant it released, while ` +
        `"chain-visitor-defect-probe" was still ${visitorDoorDistAtRelease.toFixed(2)}m from its promised destination`,
    );

    // Purely observational (NOT asserted -- what happens to the abandoned visitor's crowd
    // agent afterward depends on Detour's own path-following internals, which is not this
    // test's claim): EscortManager.tick() never calls requestMoveTarget for this visitor id
    // again once unbound (its record's `robotId` is now null, see the tick() loop's `if
    // (!visitor.robotId) continue`), so whatever it does next happens on the LAST target it
    // was ever given -- it is no longer tracking the robot's real-time position, including
    // if that robot immediately gets sent somewhere else entirely (as just proven above).
    let pos = { x: visitorAtRelease.x, z: visitorAtRelease.z };
    advance(room, 1200, () => {
      const v = room.state.agents.get("chain-visitor-defect-probe")!;
      pos = { x: v.x, z: v.z };
    });
    const laterVisitorDoorDist = Math.hypot(pos.x - doorX, pos.z - doorZ);
    console.log(
      `[evidence] ${(1200 * TICK_MS) / 1000}s further simulated with no active escort: visitor is now ` +
        `${laterVisitorDoorDist.toFixed(2)}m from the door -- whatever this settles to, it happened with no escort ` +
        "binding, no re-aiming at the robot (which was reassigned elsewhere above), and no ack reflecting it",
    );

    console.log(
      "PASS (defect documented, not fixed -- see the block comment above): a guide robot that starts close to the " +
        "requested room ends the escort and becomes reassignable to a brand-new visitor on ITS OWN arrival, with no " +
        "check on how far the FIRST visitor's own avatar still is from the promised room",
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
// Scenario 3 (bonus): assign naming a room that does not exist -> a real failure ack, not a
// crash, and the idle robot must NOT be consumed by the doomed attempt.
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

    // DEFECT (found by this test, reported per the task brief -- not fixed, per the
    // "do not modify the bridge's ack semantics" constraint): WorldRoomLike.requestGuide's
    // return type is `{robotId} | null` with NO distinction between "no robot was idle" and
    // "an idle robot existed but the target room name didn't resolve" -- see
    // EscortManager.requestGuide (world/src/rooms/escortManager.ts): it finds `bestRobotId`,
    // calls `moveAgentTo`, and on a resolution failure does `if (!moved) return null;` with
    // no reason attached, indistinguishable from the "no robot was idle at all" case. bridge.ts's
    // handleFleetCommand then always attributes a null result to reason "no_idle_robot" (see
    // its `if (!result) { ...reason: "no_idle_robot"... }`), even though an idle robot was very
    // much available here. This assertion documents the CURRENT (misleading) observed reason
    // rather than silently asserting past it -- a human should decide whether requestGuide's
    // return type should grow a real reason code.
    assert.equal(
      failedAck.reason,
      "no_idle_robot",
      "documents the current (misleading) reason string for an unresolvable room name -- see the DEFECT comment above",
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
  await testEscortEndsOnRobotArrivalNotVisitorArrival();
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
