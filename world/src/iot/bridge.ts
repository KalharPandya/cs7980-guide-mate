/**
 * Node MQTT bridge between the virtual fleet's AWS IoT Core topics and `WorldRoom`'s
 * Detour Crowd (Task 2.3 of the virtual-world guide fleet plan).
 *
 * ---- Topic / robot-id scheme (DESIGN DECISION, confirms Task 2.2's assumption) ----
 * Task 2.2 (`scripts/create_virtual_fleet_identity.sh`) mints ONE IoT thing/cert
 * ("Virtual-Fleet") shared by every virtual robot, with its policy scoped to the topic
 * root `guidemate/virtual/*`. That only works if each virtual robot's `robot_id` (as fed
 * into the unmodified `cmd_topic`/`status_topic` helpers) is itself namespaced like
 * "virtual/1", "virtual/2", ... so `cmd_topic("virtual/1")` -> "guidemate/virtual/1/cmd".
 * This bridge subscribes with the wildcard `guidemate/virtual/+/cmd` and extracts the
 * FULL "virtual/<n>" segment (not just the bare "<n>") back out of the topic via
 * `extractRobotId`.
 *
 * That extracted string is used, UNCHANGED, as both the IoT `robot_id` (for building the
 * ack's status topic) AND the `WorldRoom` agent id passed to `moveAgentTo`. Keeping the
 * two identical avoids inventing a second id-mapping table this task doesn't own -- a
 * later fleet-spawner task (not yet built) just needs to name its Colyseus agents
 * "virtual/1", "virtual/2", ... to match. If a future task wants shorter in-world agent
 * ids, add an explicit id-mapping layer there rather than smuggling a rename in here.
 *
 * ---- running/done ack semantics for async Crowd navigation (DESIGN DECISION) ----
 * `WorldRoom.moveAgentTo` returns synchronously the moment the Crowd ACCEPTS the move
 * request (a valid target was resolved and handed to Detour) -- it does not mean the
 * agent has arrived. Modeling that acceptance as `done` would be dishonest: the Python
 * bridge's `done` means "execution genuinely concluded" (see `guide_mate_bridge/
 * executor.py`'s `_handle_realdrive`), and for a physical robot the analogous concept is
 * "reached the destination", not "started driving". So here:
 *   - `received`  as soon as a valid `navigate` command is parsed and the robot id maps
 *                 to a live WorldRoom (mirrors the Python bridge's "parsed and accepted").
 *   - `running`   once `moveAgentTo` returns `true` (the Crowd accepted the goal).
 *   - `done`      once this bridge OBSERVES the agent's synced schema state transition
 *                 from "moving" back to "idle" (WorldRoom.update() already treats that
 *                 transition as "arrived": see WorldRoom.ts's `updateAgentRoute`/`update`
 *                 and the convergence check in WorldRoom.test.ts). Polled via `state.
 *                 agents.get(id).state`, not re-derived navigation math -- this bridge
 *                 does not own the sim loop.
 *   - `failed`    if `moveAgentTo` returns `false` (target/agent unresolved), if the
 *                 WorldRoom is disposed while a nav is in flight, if arrival isn't
 *                 observed within `navTimeoutMs`, or if a NEW `navigate` command for the
 *                 same robot id supersedes an in-flight one (the superseded command's
 *                 outcome is now unknowable, so it acks failed/"superseded" instead of
 *                 hanging until timeout).
 * A command type other than `navigate` acks `failed`/"unsupported_command_type" --
 * emote/motion/stop have no meaning for a virtual agent with no physical motor (per the
 * design spec's "virtual fleet has no physical motor" note); wiring those up is future
 * work, not silently dropped.
 *
 * ---- multi-robot, one connection ----
 * Unlike the Python bridge (one process = one robot id = one MQTT client identity), this
 * runs ONE process for potentially dozens of virtual robots under the single shared
 * "Virtual-Fleet" cert: one MQTT connection, one wildcard subscribe, per-message robot-id
 * routing via `extractRobotId`. Never spin up a connection per robot.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import mqtt from "mqtt";
import type { MqttClient, IClientOptions } from "mqtt";

import { type Ack, type Command, cmdTopic, statusTopic, makeAck, parseCommand } from "./messages.js";

/** Minimal surface of `WorldRoom` this bridge depends on -- kept structural (not an
 * import of the concrete class) so unit tests can inject a fake room without building a
 * real navmesh, and so this file never needs to modify WorldRoom.ts. The real WorldRoom
 * satisfies this without any change: `moveAgentTo`'s signature already matches, and
 * Colyseus rooms expose `state` publicly with a MapSchema (Map-compatible `.get`). */
export interface WorldRoomLike {
  moveAgentTo(agentId: string, target: string | { x: number; z: number }): boolean;
  state: {
    agents: { get(id: string): { state?: string } | undefined };
  };
}

/** Minimal surface of an mqtt.js `MqttClient` this bridge depends on -- kept structural so
 * unit tests can inject a fake in-memory client (mirrors the Python `IotClient`'s
 * injectable `connection` param / the tests' `FakeConnection`) instead of a real socket. */
export interface MqttClientLike {
  on(event: "connect", listener: () => void): void;
  on(event: "message", listener: (topic: string, payload: Buffer) => void): void;
  on(event: "error" | "close" | "reconnect" | "offline", listener: (...args: unknown[]) => void): void;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void;
  publish(
    topic: string,
    message: string,
    opts: { qos: 0 | 1 | 2 },
    cb?: (err?: Error) => void,
  ): void;
  end(force?: boolean, cb?: () => void): void;
}

const CMD_TOPIC_FILTER = "guidemate/virtual/+/cmd";
// Matches "guidemate/virtual/<id>/cmd" and captures "virtual/<id>" (the full robot_id, per
// the design decision above) -- deliberately requires exactly one path segment after
// "virtual/" so it never accidentally matches a deeper/foreign topic shape.
const CMD_TOPIC_RE = /^guidemate\/(virtual\/[^/]+)\/cmd$/;

export function extractRobotId(topic: string): string | null {
  const match = CMD_TOPIC_RE.exec(topic);
  return match ? match[1] : null;
}

const DEFAULT_NAV_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEDUPE_MAXLEN = 2048;

interface PendingNav {
  robotId: string;
  deadline: number;
  sawMoving: boolean;
}

export interface IotBridgeOptions {
  /** Live accessor for the current WorldRoom instance. A virtual world may have no room
   * yet (no client has joined) or a disposed one (last client left) at any moment -- the
   * bridge must tolerate both rather than caching a stale reference. */
  getRoom: () => WorldRoomLike | undefined;
  client: MqttClientLike;
  navTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export class IotBridge {
  private readonly getRoom: () => WorldRoomLike | undefined;
  private readonly client: MqttClientLike;
  private readonly navTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly log: Pick<Console, "log" | "warn" | "error">;

  private readonly seenOrder: string[] = [];
  private readonly seenSet = new Set<string>();

  private readonly pending = new Map<string, PendingNav>();
  private readonly pendingByRobot = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: IotBridgeOptions) {
    this.getRoom = opts.getRoom;
    this.client = opts.client;
    this.navTimeoutMs = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.log = opts.log ?? console;
  }

  start(): void {
    this.client.on("connect", () => {
      this.client.subscribe(CMD_TOPIC_FILTER, { qos: 1 }, (err) => {
        if (err) {
          this.log.error(`[iot-bridge] subscribe to ${CMD_TOPIC_FILTER} failed: ${err.message}`);
        } else {
          this.log.log(`[iot-bridge] subscribed to ${CMD_TOPIC_FILTER}`);
        }
      });
    });
    this.client.on("message", (topic, payload) => this.handleMessage(topic, payload));
    this.client.on("error", (err) => this.log.error("[iot-bridge] mqtt error:", err));

    this.pollTimer = setInterval(() => this.pollPending(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.client.end(true);
  }

  /** Core message-handling logic, exposed directly so unit tests can drive it without a
   * real mqtt 'message' event. topic must be the FULL received topic (not the filter). */
  handleMessage(topic: string, payload: Buffer | string): void {
    const robotId = extractRobotId(topic);
    if (!robotId) {
      this.log.warn(`[iot-bridge] ignoring message on unexpected topic: ${topic}`);
      return;
    }

    let raw: unknown;
    try {
      const text = typeof payload === "string" ? payload : payload.toString("utf-8");
      raw = JSON.parse(text);
    } catch (err) {
      this.log.warn(`[iot-bridge] ignoring non-JSON payload on ${topic}: ${(err as Error).message}`);
      return;
    }

    const cmd = parseCommand(raw);
    if (!cmd) {
      this.log.warn(`[iot-bridge] ignoring invalid command on ${topic}`);
      return;
    }

    if (this.seenSet.has(cmd.cmd_id)) {
      this.log.log(`[iot-bridge] duplicate cmd_id ignored: ${cmd.cmd_id}`);
      return;
    }
    this.recordSeen(cmd.cmd_id);

    this.handleCommand(robotId, cmd);
  }

  private recordSeen(cmdId: string): void {
    this.seenOrder.push(cmdId);
    this.seenSet.add(cmdId);
    if (this.seenOrder.length > DEDUPE_MAXLEN) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seenSet.delete(evicted);
    }
  }

  private handleCommand(robotId: string, cmd: Command): void {
    this.publishAck(robotId, makeAck({ cmd_id: cmd.cmd_id, state: "received", simulated: true }));

    if (cmd.type !== "navigate") {
      this.publishAck(
        robotId,
        makeAck({
          cmd_id: cmd.cmd_id,
          state: "failed",
          reason: "unsupported_command_type",
          simulated: true,
        }),
      );
      return;
    }

    const room = this.getRoom();
    if (!room) {
      this.publishAck(
        robotId,
        makeAck({ cmd_id: cmd.cmd_id, state: "failed", reason: "world_not_ready", simulated: true }),
      );
      return;
    }

    const target = navigateTarget(cmd);
    const accepted = room.moveAgentTo(robotId, target);
    if (!accepted) {
      this.publishAck(
        robotId,
        makeAck({ cmd_id: cmd.cmd_id, state: "failed", reason: "target_unresolved", simulated: true }),
      );
      return;
    }

    this.publishAck(robotId, makeAck({ cmd_id: cmd.cmd_id, state: "running", simulated: true }));
    this.trackArrival(robotId, cmd.cmd_id);
  }

  private trackArrival(robotId: string, cmdId: string): void {
    const prevCmdId = this.pendingByRobot.get(robotId);
    if (prevCmdId && prevCmdId !== cmdId) {
      this.resolvePending(prevCmdId, "failed", "superseded");
    }
    this.pending.set(cmdId, {
      robotId,
      deadline: Date.now() + this.navTimeoutMs,
      sawMoving: false,
    });
    this.pendingByRobot.set(robotId, cmdId);
  }

  private pollPending(): void {
    if (this.pending.size === 0) return;
    const room = this.getRoom();
    const now = Date.now();

    for (const [cmdId, nav] of this.pending) {
      if (!room) {
        this.resolvePending(cmdId, "failed", "world_disposed");
        continue;
      }
      const agent = room.state.agents.get(nav.robotId);
      if (!agent) {
        this.resolvePending(cmdId, "failed", "agent_missing");
        continue;
      }
      if (agent.state === "moving") {
        nav.sawMoving = true;
      } else if (nav.sawMoving && agent.state === "idle") {
        this.resolvePending(cmdId, "done");
        continue;
      }
      if (now >= nav.deadline) {
        this.resolvePending(cmdId, "failed", "nav_timeout");
      }
    }
  }

  private resolvePending(cmdId: string, state: "done" | "failed", reason?: string): void {
    const nav = this.pending.get(cmdId);
    if (!nav) return;
    this.pending.delete(cmdId);
    if (this.pendingByRobot.get(nav.robotId) === cmdId) {
      this.pendingByRobot.delete(nav.robotId);
    }
    this.publishAck(
      nav.robotId,
      makeAck({ cmd_id: cmdId, state, reason: reason ?? null, simulated: true }),
    );
  }

  private publishAck(robotId: string, ack: Ack): void {
    const topic = statusTopic(robotId);
    this.client.publish(topic, JSON.stringify(ack), { qos: 1 }, (err) => {
      if (err) this.log.warn(`[iot-bridge] publish to ${topic} failed: ${err.message}`);
    });
  }
}

function navigateTarget(cmd: Command): string | { x: number; z: number } {
  const params = cmd.params;
  if (typeof params.room === "string") return params.room;
  return { x: params.x as number, z: params.z as number };
}

export interface BuildMqttClientOptions {
  endpoint: string;
  cert: string;
  key: string;
  ca?: string;
  clientId?: string;
}

/** Builds the real mqtt.js client (mTLS) from cert/key file paths, mirroring the Python
 * `IotClient`'s `mqtt_connection_builder.mtls_from_path` construction: same account/region
 * pattern (an AWS IoT Core custom endpoint on port 8883), `clean_session=False` so a
 * reconnect doesn't drop the wildcard subscription, and a 30s keepalive. */
export function buildMqttClient(opts: BuildMqttClientOptions): MqttClient {
  const options: IClientOptions = {
    host: opts.endpoint,
    port: 8883,
    protocol: "mqtts",
    cert: readFileSync(opts.cert),
    key: readFileSync(opts.key),
    ca: opts.ca ? readFileSync(opts.ca) : undefined,
    clientId: opts.clientId ?? `guidemate-world-bridge-${randomUUID().slice(0, 8)}`,
    clean: false,
    keepalive: 30,
    reconnectPeriod: 2000,
  };
  return mqtt.connect(options);
}

/** Reads GUIDEMATE_IOT_ENDPOINT/GUIDEMATE_CERT/GUIDEMATE_KEY (+ optional GUIDEMATE_CA /
 * GUIDEMATE_VIRTUAL_CLIENT_ID / GUIDEMATE_NAV_TIMEOUT_MS) from `env` and starts the bridge.
 * Mirrors the graceful missing-env pattern `agent_service/guidemate_agent/app.py`'s
 * `lifespan()` uses for `RobotRegistry` (env absent or connect failing must never crash
 * the world-server -- the world still simulates and serves clients over WebSocket without
 * a live MQTT link; only virtual robots stop responding to IoT commands). Returns
 * `undefined` (after logging why) when the required env vars aren't all set; throws are
 * the caller's problem to catch (index.ts wraps this in try/catch) since `readFileSync` /
 * `mqtt.connect` can still fail for a present-but-bad cert path. */
export function startIotBridgeFromEnv(
  env: NodeJS.ProcessEnv,
  getRoom: () => WorldRoomLike | undefined,
  log: Pick<Console, "log" | "warn" | "error"> = console,
): IotBridge | undefined {
  const endpoint = env.GUIDEMATE_IOT_ENDPOINT;
  const cert = env.GUIDEMATE_CERT;
  const key = env.GUIDEMATE_KEY;
  if (!endpoint || !cert || !key) {
    log.log(
      "[iot-bridge] GUIDEMATE_IOT_ENDPOINT/GUIDEMATE_CERT/GUIDEMATE_KEY not all set -- " +
        "virtual fleet MQTT bridge NOT started (dev mode: navigate commands over MQTT are a no-op; " +
        "the world still serves WebSocket clients normally)",
    );
    return undefined;
  }

  const client = buildMqttClient({
    endpoint,
    cert,
    key,
    ca: env.GUIDEMATE_CA,
    clientId: env.GUIDEMATE_VIRTUAL_CLIENT_ID,
  });
  const navTimeoutMs = env.GUIDEMATE_NAV_TIMEOUT_MS
    ? Number(env.GUIDEMATE_NAV_TIMEOUT_MS)
    : undefined;

  const bridge = new IotBridge({ getRoom, client, navTimeoutMs, log });
  bridge.start();
  log.log(`[iot-bridge] connecting to ${endpoint} ...`);
  return bridge;
}
