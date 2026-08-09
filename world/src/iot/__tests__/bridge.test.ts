/**
 * Unit tests for the Task 2.3 IoT bridge (world/src/iot/bridge.ts + messages.ts). Uses an
 * injected fake MQTT client (mirrors the Python bridge tests' FakeConnection in
 * src/guide_mate_bridge/tests/test_bridge.py) and a fake WorldRoom (mirrors WorldRoomLike
 * structurally -- no real navmesh/Crowd needed) so these run instantly with no AWS
 * dependency. The real IoT Core round trip is covered separately by the GATED
 * bridge.integration.test.ts (set GUIDEMATE_INTEGRATION=1 to run it).
 *
 * Run with: npx tsx src/iot/__tests__/bridge.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  IotBridge,
  extractRobotId,
  type WorldRoomLike,
  type MqttClientLike,
} from "../bridge.js";
import {
  cmdTopic,
  statusTopic,
  fleetCmdTopic,
  fleetStatusTopic,
  parseCommand,
  type Ack,
  type Command,
} from "../messages.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeMqttClient implements MqttClientLike {
  private readonly emitter = new EventEmitter();
  published: { topic: string; payload: Ack }[] = [];
  subscriptions: string[] = [];
  ended = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, listener: any): void {
    this.emitter.on(event, listener);
  }

  emitEvent(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  subscribe(topic: string, _opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void {
    this.subscriptions.push(topic);
    cb?.(null);
  }

  publish(
    topic: string,
    message: string,
    _opts: { qos: 0 | 1 | 2 },
    cb?: (err?: Error) => void,
  ): void {
    this.published.push({ topic, payload: JSON.parse(message) as Ack });
    cb?.();
  }

  end(_force?: boolean, cb?: () => void): void {
    this.ended = true;
    cb?.();
  }

  acksFor(cmdId: string): Ack["state"][] {
    return this.published.filter((p) => p.payload.cmd_id === cmdId).map((p) => p.payload.state);
  }
}

class FakeWorldRoom implements WorldRoomLike {
  moveResult = true;
  moveCalls: { agentId: string; target: unknown }[] = [];
  state = { agents: new Map<string, { state?: string; x?: number; z?: number; route?: number[] }>() };
  /** Test hook: when set, a string (room-name) moveAgentTo target writes this flattened
   * [x, z] pair as the agent's route -- mirrors the real WorldRoom.updateAgentRoute,
   * which always ends the synced route at the resolved target, so bridge.ts's
   * resolveIfAlreadyArrived() has something to read back for a room-name command. */
  nextRoomTargetRoute: [number, number] | undefined;

  // ---- Task 4.2 test hooks: requestGuide/addAgent/getEntrancePoint ----
  requestGuideResult: { robotId: string } | { robotId: null; reason: "no_idle_robot" | "target_unresolved" } = {
    robotId: "virtual/1",
  };
  requestGuideCalls: { visitorId: string; target: unknown }[] = [];
  addAgentCalls: { id: string; kind: "robot" | "visitor"; spawn: { x: number; z: number } }[] = [];
  /** Test hook for the MAX_AGENTS guard (security-review finding closed out alongside
   * this): set `false` to simulate `WorldRoom.addAgent` refusing because the world is
   * already at capacity, without needing to actually spawn 128 agents in this fake. */
  addAgentResult = true;
  entrancePoint = { x: 0, z: 0 };
  /** Test hook for the `assign` command's optional `from_room` param: room name -> the
   * nav-space point the real `WorldRoom.resolveRoomPoint` (nav.findRoomTarget) would
   * return. Any name NOT in this map resolves to `null`, i.e. an unresolvable room. */
  roomPoints = new Map<string, { x: number; z: number }>([
    ["Kitchen", { x: 11.5, z: 4.25 }],
    ["Classroom 1425", { x: -3.5, z: 8.75 }],
  ]);
  resolveRoomPointCalls: string[] = [];

  // ---- Task 5.2 test hooks: fleet-wide pause/resume ----
  pauseCalls = 0;
  resumeCalls = 0;
  paused = false;

  moveAgentTo(agentId: string, target: string | { x: number; z: number }): boolean {
    this.moveCalls.push({ agentId, target });
    if (this.moveResult && !this.state.agents.has(agentId)) {
      this.state.agents.set(agentId, { state: "idle" });
    }
    if (this.moveResult && typeof target === "string" && this.nextRoomTargetRoute) {
      const agent = this.state.agents.get(agentId);
      if (agent) agent.route = [...this.nextRoomTargetRoute];
    }
    return this.moveResult;
  }

  requestGuide(
    visitorId: string,
    target: string | { x: number; z: number },
  ): { robotId: string } | { robotId: null; reason: "no_idle_robot" | "target_unresolved" } {
    this.requestGuideCalls.push({ visitorId, target });
    return this.requestGuideResult;
  }

  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): boolean {
    this.addAgentCalls.push({ id, kind, spawn });
    if (!this.addAgentResult) return false;
    this.state.agents.set(id, { state: "idle", x: spawn.x, z: spawn.z });
    return true;
  }

  getEntrancePoint(): { x: number; z: number } {
    return this.entrancePoint;
  }

  resolveRoomPoint(roomName: string): { x: number; z: number } | null {
    this.resolveRoomPointCalls.push(roomName);
    return this.roomPoints.get(roomName) ?? null;
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
  }

  resume(): void {
    this.resumeCalls++;
    this.paused = false;
  }

  /** Mirrors the real WorldRoom.isPaused getter -- see WorldRoomLike's doc comment on
   * this bug fix's use of it in pollPending(). */
  get isPaused(): boolean {
    return this.paused;
  }
}

function navigateCmd(cmdId: string, room = "Classroom 1425"): Command {
  return {
    cmd_id: cmdId,
    type: "navigate",
    name: "goto",
    params: { room },
    ts: new Date().toISOString(),
  };
}

/** `fromRoom` (the optional `from_room` param -- where the user says they currently are)
 * is omitted from `params` entirely when not passed, so the default-arg case produces the
 * exact pre-`from_room` payload shape. */
function assignCmd(cmdId: string, visitorId: string, room = "Classroom 1425", fromRoom?: string): Command {
  return {
    cmd_id: cmdId,
    type: "assign",
    name: "assign",
    params: { visitor_id: visitorId, room, ...(fromRoom === undefined ? {} : { from_room: fromRoom }) },
    ts: new Date().toISOString(),
  };
}

function fleetStopCmd(cmdId: string, params: Record<string, unknown> = {}): Command {
  return {
    cmd_id: cmdId,
    type: "stop",
    name: "stop",
    params,
    ts: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  // ---- extractRobotId: topic <-> robot_id scheme ----
  {
    assert.equal(extractRobotId("guidemate/virtual/1/cmd"), "virtual/1");
    assert.equal(extractRobotId("guidemate/virtual/42/cmd"), "virtual/42");
    assert.equal(extractRobotId("guidemate/turtlebot468/cmd"), null, "non-virtual topics must not match");
    assert.equal(extractRobotId("guidemate/virtual/1/status"), null, "status topics must not match");
    assert.equal(extractRobotId("guidemate/virtual/1/2/cmd"), null, "extra path segments must not match");
    assert.equal(cmdTopic("virtual/1"), "guidemate/virtual/1/cmd", "cmd_topic must stay byte-for-byte with the Python helper");
    assert.equal(statusTopic("virtual/1"), "guidemate/virtual/1/status");
    console.log("PASS: extractRobotId / cmd_topic / status_topic");
  }

  // ---- parseCommand: mirrors messages.py's pydantic validator ----
  {
    assert.ok(parseCommand({ cmd_id: "a", type: "navigate", name: "goto", params: { room: "Kitchen" }, ts: "x" }));
    assert.ok(parseCommand({ cmd_id: "a", type: "navigate", name: "goto", params: { x: 1, z: 2 }, ts: "x" }));
    assert.equal(
      parseCommand({ cmd_id: "a", type: "navigate", name: "goto", params: {}, ts: "x" }),
      null,
      "navigate requires room OR x+z",
    );
    assert.equal(
      parseCommand({ cmd_id: "a", type: "navigate", name: "wrongname", params: { room: "Kitchen" } }),
      null,
      "navigate name must be 'goto'",
    );
    assert.equal(parseCommand({ cmd_id: "a", type: "emote", name: "happy", params: {} }) !== null, true);
    assert.equal(parseCommand({ cmd_id: "a", type: "emote", name: "not-a-real-emote", params: {} }), null);
    assert.equal(parseCommand("not an object"), null);
    assert.equal(parseCommand({ type: "emote", name: "happy" }), null, "missing cmd_id must be rejected");

    // assign.params.from_room is OPTIONAL: absent and null are both "not provided"
    // (unchanged entrance-spawn behaviour); a string is accepted and preserved; any other
    // type is a schema violation. Mirrors messages.py's assign branch exactly.
    const assignParams = (extra: Record<string, unknown>) => ({
      cmd_id: "a",
      type: "assign",
      name: "assign",
      params: { visitor_id: "v", room: "Kitchen", ...extra },
    });
    assert.ok(parseCommand(assignParams({})), "assign with no from_room must stay valid");
    assert.ok(parseCommand(assignParams({ from_room: null })), "an explicit null from_room means 'not provided'");
    const withFromRoom = parseCommand(assignParams({ from_room: "Wellness Room" }));
    assert.ok(withFromRoom, "assign with a string from_room must be accepted");
    assert.equal(withFromRoom!.params.from_room, "Wellness Room", "from_room must survive parsing unchanged");
    assert.equal(parseCommand(assignParams({ from_room: 1425 })), null, "a numeric from_room must be rejected");
    assert.equal(parseCommand(assignParams({ from_room: { name: "Kitchen" } })), null, "an object from_room must be rejected");
    console.log("PASS: parseCommand schema validation (including optional assign.from_room)");
  }

  // ---- invalid payloads: dropped silently, no ack published ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage("guidemate/virtual/1/cmd", "{not json");
    bridge.handleMessage("guidemate/virtual/1/cmd", JSON.stringify({ type: "navigate" })); // missing fields
    bridge.handleMessage("guidemate/some/other/topic", JSON.stringify(navigateCmd("x")));

    assert.equal(client.published.length, 0, "no acks should be published for invalid/unmatched input");
    assert.equal(room.moveCalls.length, 0, "moveAgentTo should never be called for invalid input");
    console.log("PASS: invalid JSON / invalid schema / non-matching topic are dropped silently");
  }

  // ---- happy path: received -> running -> (poll) done ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 15,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    const cmd = navigateCmd("cmd-1", "Classroom 1425");
    bridge.handleMessage(cmdTopic("virtual/1"), JSON.stringify(cmd));

    assert.deepEqual(room.moveCalls, [{ agentId: "virtual/1", target: "Classroom 1425" }]);
    assert.deepEqual(
      client.acksFor("cmd-1"),
      ["received", "running"],
      "moveAgentTo accepted -> received then running, arrival not yet observed",
    );
    for (const { topic } of client.published) {
      assert.equal(topic, statusTopic("virtual/1"), "acks must publish on the robot's own status topic");
    }

    // Simulate the Crowd actually driving the agent: moving, then settling back to idle
    // (WorldRoom.update()'s own "arrived" signal) -- the bridge must observe this via polling.
    room.state.agents.set("virtual/1", { state: "moving" });
    await sleep(40);
    assert.deepEqual(client.acksFor("cmd-1"), ["received", "running"], "still running while moving");

    room.state.agents.set("virtual/1", { state: "idle" });
    await sleep(40);
    assert.deepEqual(client.acksFor("cmd-1"), ["received", "running", "done"]);
    const doneAck = client.published.find((p) => p.payload.state === "done")!.payload;
    assert.equal(doneAck.simulated, true, "virtual fleet acks should carry simulated=true");

    bridge.stop();
    assert.equal(client.ended, true);
    console.log("PASS: happy-path navigate lifecycle received -> running -> done (arrival observed via polling)");
  }

  // ---- moveAgentTo rejects the target -> failed/target_unresolved, no running ack ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.moveResult = false;
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(cmdTopic("virtual/2"), JSON.stringify(navigateCmd("cmd-2", "Nonexistent Room")));

    assert.deepEqual(client.acksFor("cmd-2"), ["received", "failed"]);
    const failedAck = client.published.find((p) => p.payload.state === "failed")!.payload;
    assert.equal(failedAck.reason, "target_unresolved");
    console.log("PASS: unresolved target acks failed/target_unresolved, never running");
  }

  // ---- no live WorldRoom -> failed/world_not_ready ----
  {
    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => undefined, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(cmdTopic("virtual/3"), JSON.stringify(navigateCmd("cmd-3")));

    assert.deepEqual(client.acksFor("cmd-3"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "world_not_ready");
    console.log("PASS: no active WorldRoom acks failed/world_not_ready");
  }

  // ---- non-navigate command type -> failed/unsupported_command_type ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    const emote: Command = { cmd_id: "cmd-4", type: "emote", name: "happy", params: {}, ts: "x" };
    bridge.handleMessage(cmdTopic("virtual/4"), JSON.stringify(emote));

    assert.deepEqual(client.acksFor("cmd-4"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "unsupported_command_type");
    assert.equal(room.moveCalls.length, 0);
    console.log("PASS: non-navigate command types ack failed/unsupported_command_type");
  }

  // ---- duplicate cmd_id ignored (mirrors the Python bridge's dedupe) ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    const cmd = navigateCmd("cmd-5");
    bridge.handleMessage(cmdTopic("virtual/5"), JSON.stringify(cmd));
    bridge.handleMessage(cmdTopic("virtual/5"), JSON.stringify(cmd)); // same cmd_id

    assert.equal(room.moveCalls.length, 1, "moveAgentTo should only fire once for a duplicate cmd_id");
    console.log("PASS: duplicate cmd_id is ignored");
  }

  // ---- genuine non-arrival (agent starts and stays "moving", never reaches idle) ->
  // failed/nav_timeout ----
  //
  // NOTE: this test's setup used to leave the fake agent at its FakeWorldRoom-default
  // {state: "idle"} with no position -- indistinguishable, per the Task 2.3 code-review
  // finding, from the "already at/near target, no movement was ever needed" case this
  // file now tests separately below. That old setup asserted nav_timeout, which is the
  // WRONG outcome for an already-arrived agent; it only happened to pass because the old
  // fake never modeled "already there" at all. Rewritten so the agent visibly starts
  // moving (sawMoving becomes true) and then just never settles back to idle -- an
  // unambiguous stuck/never-arrives case, the one nav_timeout is actually for. It also
  // carries no x/z, so resolveIfAlreadyArrived() (which requires numeric x/z) is a no-op
  // here regardless, same as before this fix.
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 10,
      navTimeoutMs: 40,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    bridge.handleMessage(cmdTopic("virtual/6"), JSON.stringify(navigateCmd("cmd-6")));
    room.state.agents.set("virtual/6", { state: "moving" });
    // Agent keeps reporting "moving" forever (never settles to idle) -> should time out
    // rather than hang.
    await sleep(120);

    assert.deepEqual(client.acksFor("cmd-6"), ["received", "running", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "nav_timeout");
    bridge.stop();
    console.log("PASS: agent stuck moving forever (never reaches idle) -> failed/nav_timeout, does not hang forever");
  }

  // ---- already at the target when navigate arrives (raw x/z target) -> immediate
  // done, no moving->idle edge required, no wait for the timeout or even the poll loop ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    // Pre-seed the agent already sitting exactly on the coordinates the next command
    // will target -- models an idempotent repeat-navigate to the robot's current spot.
    room.state.agents.set("virtual/8", { state: "idle", x: 5, z: 3 });
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 5000,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });

    const cmd: Command = {
      cmd_id: "cmd-8",
      type: "navigate",
      name: "goto",
      params: { x: 5, z: 3 },
      ts: new Date().toISOString(),
    };
    bridge.handleMessage(cmdTopic("virtual/8"), JSON.stringify(cmd));

    // No sleep, no poll tick (pollIntervalMs is huge and bridge.start() was never even
    // called) -- resolveIfAlreadyArrived() must resolve this synchronously off the
    // moveAgentTo call itself.
    assert.deepEqual(
      client.acksFor("cmd-8"),
      ["received", "running", "done"],
      "agent already at the exact target coords should ack done immediately, not time out",
    );
    console.log("PASS: already-at-target (raw x/z) navigate acks done immediately");
  }

  // ---- already at the target when navigate arrives (room-name target, resolved via the
  // agent's synced route) -> immediate done ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.state.agents.set("virtual/9", { state: "idle", x: 10, z: -2 });
    // Agent's own footprint (AGENT_RADIUS_M = 0.2m) puts this just inside tolerance --
    // exercises the tolerance being a radius, not requiring exact-zero distance.
    room.nextRoomTargetRoute = [10.1, -2.05];
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 5000,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });

    bridge.handleMessage(cmdTopic("virtual/9"), JSON.stringify(navigateCmd("cmd-9", "Classroom 1425")));

    assert.deepEqual(
      client.acksFor("cmd-9"),
      ["received", "running", "done"],
      "room-name target resolved (via route) to within the agent's own footprint should ack done immediately",
    );
    console.log("PASS: already-at-target (room-name target, resolved via route) navigate acks done immediately");
  }

  // ---- near but outside tolerance -> falls back to normal moving->idle polling, not an
  // immediate done ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.state.agents.set("virtual/10", { state: "idle", x: 0, z: 0 });
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 15,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    const cmd: Command = {
      cmd_id: "cmd-10",
      type: "navigate",
      name: "goto",
      params: { x: 3, z: 4 }, // 5m away, well outside ARRIVAL_TOLERANCE_M
      ts: new Date().toISOString(),
    };
    bridge.handleMessage(cmdTopic("virtual/10"), JSON.stringify(cmd));

    assert.deepEqual(
      client.acksFor("cmd-10"),
      ["received", "running"],
      "far-off target must not be treated as already-arrived",
    );

    room.state.agents.set("virtual/10", { state: "moving" });
    await sleep(30);
    room.state.agents.set("virtual/10", { state: "idle" });
    await sleep(30);
    assert.deepEqual(client.acksFor("cmd-10"), ["received", "running", "done"]);

    bridge.stop();
    console.log("PASS: far-off target still resolves via the normal moving->idle poll, not the fast path");
  }

  // ---- a second navigate for the same robot supersedes the first in-flight one ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 15,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    bridge.handleMessage(cmdTopic("virtual/7"), JSON.stringify(navigateCmd("cmd-7a", "Classroom 1425")));
    assert.deepEqual(client.acksFor("cmd-7a"), ["received", "running"]);

    bridge.handleMessage(cmdTopic("virtual/7"), JSON.stringify(navigateCmd("cmd-7b", "Kitchen")));
    assert.deepEqual(
      client.acksFor("cmd-7a"),
      ["received", "running", "failed"],
      "the superseded command must be resolved immediately, not left hanging",
    );
    assert.equal(client.published.find((p) => p.payload.cmd_id === "cmd-7a" && p.payload.state === "failed")!.payload.reason, "superseded");
    assert.deepEqual(client.acksFor("cmd-7b"), ["received", "running"]);

    room.state.agents.set("virtual/7", { state: "moving" });
    await sleep(30);
    room.state.agents.set("virtual/7", { state: "idle" });
    await sleep(30);
    assert.deepEqual(client.acksFor("cmd-7b"), ["received", "running", "done"]);
    assert.deepEqual(client.acksFor("cmd-7a"), ["received", "running", "failed"], "cmd-7a must not also get a done");

    bridge.stop();
    console.log("PASS: a new navigate for the same robot supersedes an in-flight one");
  }

  // ==================================================================================
  // Task 4.2: fleet-scoped `assign` command handling
  // ==================================================================================

  // ---- fleet topic constants + start() subscribes to both filters ----
  {
    assert.equal(fleetCmdTopic(), "guidemate/virtual/fleet/cmd");
    assert.equal(fleetStatusTopic(), "guidemate/virtual/fleet/status");

    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });
    bridge.start();
    client.emitEvent("connect");

    assert.ok(client.subscriptions.includes("guidemate/virtual/+/cmd"), "must keep the existing per-robot wildcard subscription");
    assert.ok(client.subscriptions.includes(fleetCmdTopic()), "must additionally subscribe to the fleet topic");
    bridge.stop();
    console.log("PASS: fleet topic helpers + start() subscribes to both the per-robot wildcard and the fleet topic");
  }

  // ---- valid assign for a brand-new visitor: spawns the visitor, calls requestGuide,
  // acks received -> done on the FLEET status topic, with assigned_robot_id ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.requestGuideResult = { robotId: "virtual/7" };
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a1", "visitor-1", "Kitchen")));

    assert.deepEqual(room.addAgentCalls, [{ id: "visitor-1", kind: "visitor", spawn: room.entrancePoint }],
      "a brand-new visitor_id must be spawned at the entrance before requestGuide");
    assert.deepEqual(room.requestGuideCalls, [{ visitorId: "visitor-1", target: "Kitchen" }]);
    assert.deepEqual(client.acksFor("cmd-a1"), ["received", "done"]);
    for (const { topic, payload } of client.published) {
      assert.equal(topic, fleetStatusTopic(), "assign acks must publish on the fleet status topic, not a per-robot one");
      if (payload.cmd_id === "cmd-a1" && payload.state === "done") {
        assert.equal(payload.assigned_robot_id, "virtual/7");
      }
    }
    console.log("PASS: valid assign for a new visitor spawns it, calls requestGuide, acks received -> done with assigned_robot_id");
  }

  // ---- assign for a visitor that already exists: addAgent must NOT be called again ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.state.agents.set("visitor-2", { state: "idle", x: 1, z: 2 });
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a2", "visitor-2")));

    assert.equal(room.addAgentCalls.length, 0, "an already-tracked visitor must not be re-spawned");
    assert.deepEqual(room.requestGuideCalls, [{ visitorId: "visitor-2", target: "Classroom 1425" }]);
    assert.deepEqual(client.acksFor("cmd-a2"), ["received", "done"]);
    console.log("PASS: assign for an already-tracked visitor does not re-spawn it");
  }

  // ==================================================================================
  // `assign` params.from_room: spawn the person WHERE THE USER SAYS THEY ARE
  //
  // Moses asks "where are you in the building?"; the user's answer rides on the assign
  // command as the optional `from_room` param. The three cases below are the whole
  // contract: present-and-resolvable spawns there, present-but-unresolvable FAILS (never
  // silently falls back to the entrance -- that would put the person somewhere they are
  // not and send a robot to fetch thin air), and absent keeps the pre-existing
  // entrance-spawn behaviour byte for byte.
  // ==================================================================================

  // ---- (a) from_room present and resolvable: the visitor spawns AT THAT ROOM's point,
  // not at the entrance; the DESTINATION passed to requestGuide is still `room` ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.entrancePoint = { x: 24.821, z: 13.99 }; // a real-ish entrance, clearly != the Kitchen point
    room.requestGuideResult = { robotId: "virtual/9" };
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify(assignCmd("cmd-from-1", "visitor-from-1", "Classroom 1425", "Kitchen")),
    );

    const kitchenPoint = room.roomPoints.get("Kitchen")!;
    assert.deepEqual(room.resolveRoomPointCalls, ["Kitchen"], "from_room must be resolved via resolveRoomPoint");
    assert.deepEqual(
      room.addAgentCalls,
      [{ id: "visitor-from-1", kind: "visitor", spawn: kitchenPoint }],
      "the visitor must be spawned at the from_room point the user selected, NOT at the entrance",
    );
    assert.notDeepEqual(
      room.addAgentCalls[0].spawn,
      room.entrancePoint,
      "sanity: the from_room spawn point must actually differ from the entrance, or this test proves nothing",
    );
    assert.deepEqual(
      room.requestGuideCalls,
      [{ visitorId: "visitor-from-1", target: "Classroom 1425" }],
      "from_room must not change the DESTINATION handed to requestGuide -- that is still `room`",
    );
    assert.deepEqual(client.acksFor("cmd-from-1"), ["received", "done"]);
    console.log(
      `PASS: assign with from_room="Kitchen" spawns the visitor at (${kitchenPoint.x}, ${kitchenPoint.z}), not the entrance`,
    );
  }

  // ---- (b) from_room present but unresolvable: fail with a DISTINCT reason, spawn
  // nothing, and never reach requestGuide ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify(assignCmd("cmd-from-2", "visitor-from-2", "Kitchen", "Room That Does Not Exist 9999")),
    );

    assert.deepEqual(client.acksFor("cmd-from-2"), ["received", "failed"]);
    const failedAck = client.published.find(
      (p) => p.payload.cmd_id === "cmd-from-2" && p.payload.state === "failed",
    )!.payload;
    assert.equal(
      failedAck.reason,
      "from_room_unresolved",
      "an unresolvable from_room must get its own reason, distinct from the destination's target_unresolved",
    );
    assert.equal(failedAck.assigned_robot_id, null);
    assert.equal(
      room.addAgentCalls.length,
      0,
      "an unresolvable from_room must NOT silently fall back to spawning the person at the entrance",
    );
    assert.equal(room.requestGuideCalls.length, 0, "no robot should be dispatched for a person whose location is unknown");
    console.log("PASS: assign with an unresolvable from_room acks failed/from_room_unresolved, spawns nothing, dispatches nobody");
  }

  // ---- (c) from_room absent: unchanged entrance-spawn behaviour, and resolveRoomPoint
  // is never consulted at all ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.entrancePoint = { x: 24.821, z: 13.99 };
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-from-3", "visitor-from-3", "Kitchen")));

    assert.deepEqual(
      room.addAgentCalls,
      [{ id: "visitor-from-3", kind: "visitor", spawn: room.entrancePoint }],
      "with no from_room the visitor must still spawn at the entrance, exactly as before the param existed",
    );
    assert.deepEqual(room.resolveRoomPointCalls, [], "no from_room means no room-point resolution at all");
    assert.deepEqual(client.acksFor("cmd-from-3"), ["received", "done"]);
    console.log("PASS: assign without from_room still spawns the visitor at the entrance (unchanged behaviour)");
  }

  // ---- from_room on a visitor that ALREADY exists must not teleport them: they are a
  // person already standing somewhere in the world ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.state.agents.set("visitor-from-4", { state: "idle", x: 1, z: 2 });
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(
      fleetCmdTopic(),
      JSON.stringify(assignCmd("cmd-from-4", "visitor-from-4", "Classroom 1425", "Kitchen")),
    );

    assert.equal(room.addAgentCalls.length, 0, "an already-tracked visitor must not be re-spawned by from_room");
    assert.deepEqual(room.state.agents.get("visitor-from-4"), { state: "idle", x: 1, z: 2 }, "and must not be moved");
    assert.deepEqual(client.acksFor("cmd-from-4"), ["received", "done"]);
    console.log("PASS: from_room does not teleport a visitor that already exists in the world");
  }

  // ---- requestGuide returns robotId: null / reason: no_idle_robot -> failed/no_idle_robot ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.requestGuideResult = { robotId: null, reason: "no_idle_robot" };
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a3", "visitor-3")));

    assert.deepEqual(client.acksFor("cmd-a3"), ["received", "failed"]);
    const failedAck = client.published.find((p) => p.payload.cmd_id === "cmd-a3" && p.payload.state === "failed")!.payload;
    assert.equal(failedAck.reason, "no_idle_robot");
    assert.equal(failedAck.assigned_robot_id, null);
    console.log("PASS: requestGuide returning robotId: null / reason: no_idle_robot acks failed/no_idle_robot");
  }

  // ---- defect B fix: requestGuide returns robotId: null / reason: target_unresolved (an
  // idle robot WAS available, but the room name didn't resolve) -> the bridge must relay
  // THAT reason, not always fall back to "no_idle_robot" ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.requestGuideResult = { robotId: null, reason: "target_unresolved" };
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a3c", "visitor-3c")));

    assert.deepEqual(client.acksFor("cmd-a3c"), ["received", "failed"]);
    const failedAck = client.published.find((p) => p.payload.cmd_id === "cmd-a3c" && p.payload.state === "failed")!.payload;
    assert.equal(failedAck.reason, "target_unresolved");
    assert.equal(failedAck.assigned_robot_id, null);
    console.log("PASS: requestGuide returning robotId: null / reason: target_unresolved acks failed/target_unresolved (not misreported as no_idle_robot)");
  }

  // ---- security-review finding: addAgent refuses because the world is at MAX_AGENTS
  // capacity -> failed/world_at_capacity, requestGuide is never called for a visitor
  // that was never actually added to the Crowd/schema ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    room.addAgentResult = false;
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a3b", "visitor-3b")));

    assert.deepEqual(room.addAgentCalls, [{ id: "visitor-3b", kind: "visitor", spawn: room.entrancePoint }],
      "addAgent should still be attempted for a brand-new visitor_id");
    assert.equal(room.requestGuideCalls.length, 0, "requestGuide must not be called for a visitor addAgent refused");
    assert.deepEqual(client.acksFor("cmd-a3b"), ["received", "failed"]);
    const failedAck = client.published.find((p) => p.payload.cmd_id === "cmd-a3b" && p.payload.state === "failed")!.payload;
    assert.equal(failedAck.reason, "world_at_capacity");
    console.log("PASS: addAgent refusing (world at MAX_AGENTS) acks failed/world_at_capacity without calling requestGuide");
  }

  // ---- no live WorldRoom -> failed/world_not_ready, visitor never spawned ----
  {
    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => undefined, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a4", "visitor-4")));

    assert.deepEqual(client.acksFor("cmd-a4"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "world_not_ready");
    console.log("PASS: no active WorldRoom on the fleet topic acks failed/world_not_ready");
  }

  // ---- a non-assign command type on the fleet topic -> failed/unsupported_command_type ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    const emote: Command = { cmd_id: "cmd-a5", type: "emote", name: "happy", params: {}, ts: "x" };
    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(emote));

    assert.deepEqual(client.acksFor("cmd-a5"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "unsupported_command_type");
    assert.equal(room.requestGuideCalls.length, 0);
    assert.equal(room.addAgentCalls.length, 0);
    console.log("PASS: non-assign command types on the fleet topic ack failed/unsupported_command_type");
  }

  // ---- invalid assign payload (missing visitor_id) on the fleet topic: dropped
  // silently, exactly like an invalid per-robot command ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify({ cmd_id: "cmd-a6", type: "assign", name: "assign", params: { room: "Kitchen" } }));

    assert.equal(client.published.length, 0, "no ack should be published for an invalid assign payload");
    assert.equal(room.requestGuideCalls.length, 0);
    assert.equal(room.addAgentCalls.length, 0);
    console.log("PASS: invalid assign payload (missing visitor_id) on the fleet topic is dropped silently");
  }

  // ---- the fleet topic structurally matches the per-robot wildcard's regex (one path
  // segment after "virtual/"), but handleMessage must route it to the fleet handler, NOT
  // misinterpret it as a per-robot command for a robot named "virtual/fleet" ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(assignCmd("cmd-a7", "visitor-7")));

    assert.equal(room.moveCalls.length, 0, "must never call moveAgentTo for a fleet-topic message");
    assert.deepEqual(room.requestGuideCalls, [{ visitorId: "visitor-7", target: "Classroom 1425" }]);
    assert.deepEqual(client.acksFor("cmd-a7"), ["received", "done"]);
    console.log("PASS: the fleet topic is never misrouted through the per-robot extractRobotId path");
  }

  // ==================================================================================
  // Task 5.2: fleet-scoped `stop` command = pause/resume the whole world
  // ==================================================================================

  // ---- a bare `stop` on the fleet topic (no params) pauses the room, acks done ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(fleetStopCmd("cmd-s1")));

    assert.equal(room.pauseCalls, 1, "a bare fleet stop must call room.pause() exactly once");
    assert.equal(room.resumeCalls, 0, "a bare fleet stop must never call room.resume()");
    assert.deepEqual(client.acksFor("cmd-s1"), ["received", "done"]);
    for (const { topic } of client.published) {
      assert.equal(topic, fleetStatusTopic(), "fleet stop acks must publish on the fleet status topic");
    }
    console.log("PASS: a bare fleet stop (no params) pauses the room and acks received -> done");
  }

  // ---- a `stop` on the fleet topic with params.resume === true resumes the room ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(fleetStopCmd("cmd-s2", { resume: true })));

    assert.equal(room.resumeCalls, 1, "stop with params.resume=true must call room.resume() exactly once");
    assert.equal(room.pauseCalls, 0, "stop with params.resume=true must never call room.pause()");
    assert.deepEqual(client.acksFor("cmd-s2"), ["received", "done"]);
    console.log("PASS: fleet stop with params.resume=true resumes the room and acks received -> done");
  }

  // ---- a truthy-but-not-strictly-true resume param is treated as pause (strict ===
  // true check, not just truthiness) ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(fleetStopCmd("cmd-s3", { resume: "true" })));

    assert.equal(room.pauseCalls, 1, "a non-boolean-true resume param must fall back to pause");
    assert.equal(room.resumeCalls, 0);
    console.log("PASS: fleet stop with a non-strict-true resume param falls back to pause");
  }

  // ---- no live WorldRoom on a fleet stop -> failed/world_not_ready ----
  {
    const client = new FakeMqttClient();
    const bridge = new IotBridge({ getRoom: () => undefined, client, log: { log() {}, warn() {}, error() {} } });

    bridge.handleMessage(fleetCmdTopic(), JSON.stringify(fleetStopCmd("cmd-s4")));

    assert.deepEqual(client.acksFor("cmd-s4"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "world_not_ready");
    console.log("PASS: no active WorldRoom on a fleet stop acks failed/world_not_ready");
  }

  // ---- the existing PER-ROBOT `stop` handling must be completely unaffected: it still
  // always acks failed/unsupported_command_type and never touches pause/resume ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({ getRoom: () => room, client, log: { log() {}, warn() {}, error() {} } });

    const perRobotStop: Command = { cmd_id: "cmd-s5", type: "stop", name: "stop", params: {}, ts: "x" };
    bridge.handleMessage(cmdTopic("virtual/11"), JSON.stringify(perRobotStop));

    assert.deepEqual(client.acksFor("cmd-s5"), ["received", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "unsupported_command_type");
    assert.equal(room.pauseCalls, 0, "a per-robot stop must never pause the room");
    assert.equal(room.resumeCalls, 0, "a per-robot stop must never resume the room");
    console.log("PASS: the existing per-robot `stop` (unsupported_command_type) is unaffected by the fleet-stop feature");
  }

  // ==================================================================================
  // Bug fix (code review of Task 5.2's commit f6b79f2): pollPending()'s nav_timeout must
  // not advance while the world is paused, else pausing for a demo narration beat longer
  // than the remaining timeout window would spuriously fail a navigate that was never
  // actually stuck. Semantics under test: paused wall-clock time does NOT count against
  // navTimeoutMs at all -- the timeout clock effectively pauses and resumes with the
  // world (see pollPending()'s doc comment for the full reasoning).
  // ==================================================================================

  // ---- a pending navigate that has already burned a NON-DEGENERATE chunk of its
  // timeout budget before the world is paused must resume with that SAME reduced
  // budget -- not a full fresh navTimeoutMs, and not an already-expired one.
  //
  // Why this version of the test exists: an earlier version of this test paused
  // IMMEDIATELY after the command started, so the remaining budget at pause-time was
  // ≈ the full navTimeoutMs. That couldn't distinguish a correct fix from a bug where
  // the deadline gets reset to a fresh navTimeoutMs on resume -- both look identical
  // when ~0% of the budget was consumed pre-pause. This version burns a real, known
  // fraction of the budget BEFORE pausing so "preserved remaining budget" and "reset to
  // full" produce different, checkable timings.
  //
  // The math (spelled out here so a future reader doesn't have to re-derive it):
  //   navTimeoutMs = 400ms
  //   preElapsed   = 200ms  (50% of budget consumed BEFORE pause -> remaining ~200ms)
  //   pauseHoldMs  = 1200ms (3x navTimeoutMs -- long enough that a bug where paused time
  //                          still counts against the deadline would have already fired
  //                          the timeout WHILE frozen; asserted separately below)
  //   checkpoint A = +80ms  after resume  (well under the ~200ms remaining budget, with
  //                          ~120ms of margin) -> must still be "running".
  //                          Catches "paused time counts against the deadline" (no
  //                          shift): that bug's raw wall-clock deadline (set 200ms after
  //                          start) was crossed ~1000ms ago by the time resume happens,
  //                          so it would already ack "failed" here instead of "running".
  //   checkpoint B = +280ms after resume (80 + 200 more) -- past the ~200ms remaining
  //                          budget (~80ms margin) but well short of a fresh 400ms
  //                          (~120ms margin) -> must now be "failed".
  //                          Catches "deadline reset to a fresh navTimeoutMs on resume":
  //                          that bug needs the full 400ms post-resume before it fires,
  //                          so at +280ms it would still be "running" instead of
  //                          "failed".
  // Only the correct fix (shift the deadline forward by exactly the paused duration,
  // preserving the original ~200ms remaining budget) satisfies BOTH checkpoints; either
  // bug flips one of the two assertions below to the wrong ack state.
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 20,
      navTimeoutMs: 400,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    bridge.handleMessage(cmdTopic("virtual/20"), JSON.stringify(navigateCmd("cmd-20")));
    assert.deepEqual(client.acksFor("cmd-20"), ["received", "running"]);
    room.state.agents.set("virtual/20", { state: "moving" });

    // Burn a real, non-degenerate chunk (50%) of the timeout budget BEFORE pausing.
    await sleep(200);
    assert.deepEqual(
      client.acksFor("cmd-20"),
      ["received", "running"],
      "must still be running just before pause (sanity check on the 200ms pre-pause wait)",
    );

    // Pause, then hold the pause for 3x navTimeoutMs -- long enough that, without the
    // fix, the (unshifted) deadline would have been crossed while still frozen.
    room.pause();
    await sleep(1200);
    assert.deepEqual(
      client.acksFor("cmd-20"),
      ["received", "running"],
      "a navigate must NOT time out while the world is paused, no matter how long the pause lasts",
    );

    room.resume();

    // Checkpoint A: well under the ~200ms remaining budget -> must still be running.
    await sleep(80);
    assert.deepEqual(
      client.acksFor("cmd-20"),
      ["received", "running"],
      "80ms after resume must still be running -- the ~200ms preserved remaining budget isn't exhausted yet " +
        "(a bug where paused time counted against the deadline would already show failed here)",
    );

    // Checkpoint B: past the ~200ms remaining budget but short of a fresh 400ms ->
    // must now be failed.
    await sleep(200); // cumulative 280ms since resume
    assert.deepEqual(
      client.acksFor("cmd-20"),
      ["received", "running", "failed"],
      "~280ms after resume (> the ~200ms preserved remaining budget, < a fresh 400ms) must now be failed " +
        "(a bug that resets the deadline to a fresh navTimeoutMs on resume would still show running here)",
    );
    assert.equal(client.published.find((p) => p.payload.cmd_id === "cmd-20" && p.payload.state === "failed")!.payload.reason, "nav_timeout");

    bridge.stop();
    console.log(
      "PASS: pausing the world suspends a pending navigate's nav_timeout clock at its CURRENT remaining budget " +
        "(not reset to full, not already expired); it resumes counting from exactly that point once unpaused",
    );
  }

  // ---- an in-flight navigate that genuinely arrives WHILE paused (e.g. the world was
  // unpaused again by the very next poll tick) still resolves done normally -- arrival
  // detection is never gated on pause state, only the timeout check is ----
  {
    const client = new FakeMqttClient();
    const room = new FakeWorldRoom();
    const bridge = new IotBridge({
      getRoom: () => room,
      client,
      pollIntervalMs: 15,
      navTimeoutMs: 5000,
      log: { log() {}, warn() {}, error() {} },
    });
    bridge.start();

    bridge.handleMessage(cmdTopic("virtual/21"), JSON.stringify(navigateCmd("cmd-21")));
    room.state.agents.set("virtual/21", { state: "moving" });
    await sleep(30);

    room.pause();
    room.state.agents.set("virtual/21", { state: "idle" });
    await sleep(30);

    assert.deepEqual(
      client.acksFor("cmd-21"),
      ["received", "running", "done"],
      "arrival (moving -> idle) must still be detected even on a poll tick where the room reports paused",
    );

    bridge.stop();
    console.log("PASS: arrival detection is not gated on pause state, only the nav_timeout expiry check is");
  }

  console.log("\nALL PASS: bridge.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
