/**
 * GATED real IoT Core round trip for the Task 2.3 Node bridge -- the world-server-side
 * analogue of `agent_service/tests/integration/test_roundtrip.py` (same `GUIDEMATE_
 * INTEGRATION=1` gate, same dev cert, same real AWS IoT Core data plane). NOT part of the
 * default `npm run test:all` -- run explicitly with `npm run test:iot:integration` after
 * setting the env below. This must never run unattended in CI: it needs a real AWS
 * account, a provisioned dev cert, and it publishes/subscribes real MQTT traffic.
 *
 * PRECONDITIONS (fail loudly and explain, rather than silently skip, when unmet):
 *   - GUIDEMATE_INTEGRATION=1
 *   - GUIDEMATE_IOT_ENDPOINT   -- e.g. `aws iot describe-endpoint --endpoint-type iot:Data-ATS`
 *   - GUIDEMATE_CERT / GUIDEMATE_KEY -- a cert authorized for `guidemate/virtual/*` publish
 *     + subscribe (Task 2.2's Virtual-Fleet cert once `scripts/create_virtual_fleet_
 *     identity.sh --apply` has actually been run -- NOT yet true as of this task; the dev
 *     cert used by the Python integration test also works since its policy is broad
 *     enough for a `guidemate/virtual/999/*` smoke id, but prefer the real fleet cert once
 *     it exists).
 *   - GUIDEMATE_CA (optional -- falls back to the public AmazonRootCA1.pem, matching the
 *     Python integration test's own `_ensure_ca()` download-if-missing behavior)
 *
 * What it proves: publishing a real `navigate` Command JSON on `guidemate/virtual/999/cmd`
 * against a live IotBridge (backed by a FAKE WorldRoom -- this test does not want to pull
 * in the recast-navigation WASM navmesh over a real AWS round trip, that's what
 * WorldRoom.test.ts already covers offline) makes `moveAgentTo` fire and a full
 * received -> running -> done ack sequence land back on `guidemate/virtual/999/status`
 * over the real AWS IoT Core MQTT broker -- i.e. the wire format, mTLS auth, and topic
 * scope genuinely round-trip end to end, not just in-process.
 *
 * Run with: GUIDEMATE_INTEGRATION=1 npm run test:iot:integration
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import mqtt from "mqtt";

import { IotBridge, buildMqttClient, extractRobotId, type WorldRoomLike } from "../bridge.js";
import { cmdTopic, statusTopic, newCmdId, type Ack } from "../messages.js";

const DEV_CERT = process.env.GUIDEMATE_CERT ?? join(homedir(), ".aws", "guidemate-dev.cert.pem");
const DEV_KEY = process.env.GUIDEMATE_KEY ?? join(homedir(), ".aws", "guidemate-dev.private.key");
const CA_PATH = process.env.GUIDEMATE_CA ?? join(homedir(), "certs", "AmazonRootCA1.pem");
const CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem";

const ROBOT_ID = "virtual/999"; // smoke id -- guidemate/virtual/999/{cmd,status}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureCa(path: string): Promise<string> {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const res = await fetch(CA_URL);
  if (!res.ok) throw new Error(`failed to download AmazonRootCA1.pem: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  await import("node:fs/promises").then((fs) => fs.writeFile(path, body));
  return path;
}

class FakeWorldRoom implements WorldRoomLike {
  moveCalls: { agentId: string; target: unknown }[] = [];
  state = { agents: new Map<string, { state?: string }>() };

  moveAgentTo(agentId: string, target: string | { x: number; z: number }): boolean {
    this.moveCalls.push({ agentId, target });
    this.state.agents.set(agentId, { state: "idle" }); // step() below drives moving->idle
    return true;
  }

  // Task 4.2's assign path is exercised by bridge.test.ts's in-process fakes; this
  // real-broker round trip only needs `navigate`, so these are minimal stand-ins to
  // satisfy WorldRoomLike.
  requestGuide(): { robotId: string } | null {
    return null;
  }

  addAgent(): void {}

  getEntrancePoint(): { x: number; z: number } {
    return { x: 0, z: 0 };
  }

  // Task 5.2's fleet-stop path is exercised by bridge.test.ts's in-process fakes; this
  // real-broker round trip only needs `navigate`, so these are minimal stand-ins to
  // satisfy WorldRoomLike.
  pause(): void {}

  resume(): void {}

  /** Bug fix's `isPaused` addition to WorldRoomLike -- this round trip never pauses, so a
   * constant `false` is a sufficient stand-in. */
  get isPaused(): boolean {
    return false;
  }

  /** Simulates the Crowd actually moving the agent over a couple of ticks, for a test
   * that doesn't want to pull in a real navmesh -- see the file header. */
  async simulateArrival(agentId: string): Promise<void> {
    this.state.agents.set(agentId, { state: "moving" });
    await sleep(150);
    this.state.agents.set(agentId, { state: "idle" });
  }
}

async function main(): Promise<void> {
  if (process.env.GUIDEMATE_INTEGRATION !== "1") {
    console.log("SKIP: set GUIDEMATE_INTEGRATION=1 to run bridge.integration.test.ts (needs real AWS IoT Core + a dev cert)");
    return;
  }
  const endpoint = process.env.GUIDEMATE_IOT_ENDPOINT;
  if (!endpoint) {
    throw new Error("GUIDEMATE_INTEGRATION=1 but GUIDEMATE_IOT_ENDPOINT is not set");
  }
  if (!existsSync(DEV_CERT) || !existsSync(DEV_KEY)) {
    throw new Error(
      `GUIDEMATE_INTEGRATION=1 but cert/key not found at ${DEV_CERT} / ${DEV_KEY} -- ` +
        "set GUIDEMATE_CERT/GUIDEMATE_KEY or provision the dev cert (see agent_service/tests/integration/test_roundtrip.py)",
    );
  }
  const ca = await ensureCa(CA_PATH);

  const room = new FakeWorldRoom();
  const bridgeClient = buildMqttClient({ endpoint, cert: DEV_CERT, key: DEV_KEY, ca, clientId: `guidemate-world-bridge-it-${Date.now()}` });
  const bridge = new IotBridge({ getRoom: () => room, client: bridgeClient, pollIntervalMs: 50, navTimeoutMs: 15000 });
  bridge.start();

  // Independent "test harness" MQTT connection playing the role of a Moses-side sender,
  // subscribing to the status topic and publishing the command -- proves the round trip
  // over the real broker, not just in-process method calls.
  const harness = mqtt.connect({
    host: endpoint,
    port: 8883,
    protocol: "mqtts",
    cert: await import("node:fs/promises").then((fs) => fs.readFile(DEV_CERT)),
    key: await import("node:fs/promises").then((fs) => fs.readFile(DEV_KEY)),
    ca: await import("node:fs/promises").then((fs) => fs.readFile(ca)),
    clientId: `guidemate-world-bridge-it-harness-${Date.now()}`,
    clean: true,
  });

  const acks: Ack[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out connecting/subscribing harness client")), 15000);
    harness.on("connect", () => {
      harness.subscribe(statusTopic(ROBOT_ID), { qos: 1 }, (err) => {
        if (err) return reject(err);
        clearTimeout(timeout);
        resolve();
      });
    });
    harness.on("error", reject);
  });
  harness.on("message", (_topic, payload) => {
    acks.push(JSON.parse(payload.toString("utf-8")) as Ack);
  });

  // Wait for the bridge's own wildcard subscribe to be live before publishing, otherwise
  // the command can race the SUBACK and be missed (QoS1 does not retro-deliver).
  await sleep(2000);

  const cmdId = newCmdId();
  const commandJson = JSON.stringify({
    cmd_id: cmdId,
    type: "navigate",
    name: "goto",
    params: { room: "Classroom 1425" },
    ts: new Date().toISOString(),
  });
  assert.equal(cmdTopic(ROBOT_ID), "guidemate/virtual/999/cmd");
  assert.equal(extractRobotId(cmdTopic(ROBOT_ID)), ROBOT_ID);

  await new Promise<void>((resolve, reject) => {
    harness.publish(cmdTopic(ROBOT_ID), commandJson, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });

  // Let received+running land, then simulate the crowd actually moving so the bridge's
  // polling loop can observe the arrival transition and ack `done`.
  await sleep(1000);
  await room.simulateArrival(ROBOT_ID);
  await sleep(1000);

  const states = acks.filter((a) => a.cmd_id === cmdId).map((a) => a.state);
  console.log(`[evidence] acks received over real IoT Core for cmd_id=${cmdId}: ${JSON.stringify(states)}`);
  assert.ok(states.includes("received"), `expected a 'received' ack, got ${JSON.stringify(states)}`);
  assert.ok(states.includes("done"), `expected a terminal 'done' ack, got ${JSON.stringify(states)}`);
  assert.deepEqual(room.moveCalls, [{ agentId: ROBOT_ID, target: "Classroom 1425" }]);

  console.log("PASS: real navigate Command published over AWS IoT Core moved the agent and produced a done ack on the status topic");

  bridge.stop();
  harness.end(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
