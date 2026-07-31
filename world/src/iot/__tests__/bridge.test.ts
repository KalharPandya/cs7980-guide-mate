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
import { cmdTopic, statusTopic, parseCommand, type Ack, type Command } from "../messages.js";

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
  state = { agents: new Map<string, { state?: string }>() };

  moveAgentTo(agentId: string, target: string | { x: number; z: number }): boolean {
    this.moveCalls.push({ agentId, target });
    if (this.moveResult && !this.state.agents.has(agentId)) {
      this.state.agents.set(agentId, { state: "idle" });
    }
    return this.moveResult;
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
    console.log("PASS: parseCommand schema validation");
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

  // ---- arrival never observed -> failed/nav_timeout ----
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
    // Agent stays "idle" forever (never actually starts moving in this fake) -> should
    // time out rather than hang.
    await sleep(120);

    assert.deepEqual(client.acksFor("cmd-6"), ["received", "running", "failed"]);
    assert.equal(client.published.find((p) => p.payload.state === "failed")!.payload.reason, "nav_timeout");
    bridge.stop();
    console.log("PASS: arrival never observed -> failed/nav_timeout, does not hang forever");
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

  console.log("\nALL PASS: bridge.test.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
