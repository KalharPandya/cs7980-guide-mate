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
 *   - `done`      EITHER (a) immediately, synchronously right after `running`, if the
 *                 agent is already within ARRIVAL_TOLERANCE_M of the resolved target (see
 *                 that constant's doc comment -- a repeat/idempotent navigate, e.g. Moses
 *                 re-issuing the same room target, never crosses IDLE_SPEED_THRESHOLD_MPS
 *                 so the moving->idle edge below would never fire and this would
 *                 wrongly hang to nav_timeout); OR (b) once this bridge OBSERVES the
 *                 agent's synced schema state transition from "moving" back to "idle"
 *                 (WorldRoom.update() already treats that transition as "arrived": see
 *                 WorldRoom.ts's `updateAgentRoute`/`update` and the convergence check in
 *                 WorldRoom.test.ts). Polled via `state.agents.get(id).state`, not
 *                 re-derived navigation math -- this bridge does not own the sim loop.
 *   - `failed`    if `moveAgentTo` returns `false` (target/agent unresolved), if the
 *                 WorldRoom is disposed while a nav is in flight, if arrival isn't
 *                 observed within `navTimeoutMs`, or if a NEW `navigate` command for the
 *                 same robot id supersedes an in-flight one (the superseded command's
 *                 outcome is now unknowable, so it acks failed/"superseded" instead of
 *                 hanging until timeout).
 * A command type other than `navigate` acks `failed`/"unsupported_command_type" --
 * emote/motion/stop have no meaning for a virtual agent with no physical motor (per the
 * design spec's "virtual fleet has no physical motor" note); wiring those up is future
 * work, not silently dropped. This is per-robot-topic only: a `stop` on the FLEET topic
 * means something else entirely -- see Task 5.2's note below.
 *
 * ---- Task 5.2: fleet-wide `stop` = pause/resume the whole world ----
 * A `stop` arriving on the fleet topic (not a per-robot topic) is a DIFFERENT thing: it
 * freezes/un-freezes the whole simulated world (`WorldRoom.pause`/`resume`), not "stop
 * this one virtual agent" (which per-robot `stop` still doesn't support, unchanged).
 * See `handleFleetStop` for the full wire format, including how a `params.resume: true`
 * overload of the same `stop` command distinguishes resume from pause.
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

import {
  type Ack,
  type Command,
  cmdTopic,
  statusTopic,
  fleetCmdTopic,
  fleetStatusTopic,
  makeAck,
  parseCommand,
} from "./messages.js";
import { AGENT_RADIUS_M } from "../nav/agentProfile.js";

/** Minimal surface of `WorldRoom` this bridge depends on -- kept structural (not an
 * import of the concrete class) so unit tests can inject a fake room without building a
 * real navmesh, and so this file never needs to modify WorldRoom.ts. The real WorldRoom
 * satisfies this without any change: `moveAgentTo`'s signature already matches, and
 * Colyseus rooms expose `state` publicly with a MapSchema (Map-compatible `.get`). */
export interface WorldRoomLike {
  moveAgentTo(agentId: string, target: string | { x: number; z: number }): boolean;
  /**
   * Task 4.2: picks the nearest idle robot, binds it to `visitorId`, and sends it to
   * `roomNameOrCoords` -- see `WorldRoom.requestGuide` (Task 4.1). Requires `visitorId`
   * to already be a tracked agent (this bridge's `addAgent` call ensures that for a
   * brand-new real visitor before calling this). Returns `null` if no robot is idle.
   */
  requestGuide(visitorId: string, roomNameOrCoords: string | { x: number; z: number }): { robotId: string } | null;
  /** Adds a new tracked agent (Crowd + synced schema) -- see `WorldRoom.addAgent`. Used
   * here to spawn a brand-new "real" visitor at the entrance before its first `assign`. */
  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): void;
  /** Nav-space entrance point to spawn a fresh real visitor at -- see
   * `WorldRoom.getEntrancePoint`. */
  getEntrancePoint(): { x: number; z: number };
  /**
   * Task 5.2: freezes/un-freezes the whole simulated world (the Crowd tick AND the
   * simulated-visitor spawner/lifecycle -- see `WorldRoom.pause`'s doc comment for why
   * both are frozen together). Wired to a fleet-scoped `stop` command; see
   * `handleFleetStop` below for the wire format this bridge overloads to distinguish
   * pause from resume.
   */
  pause(): void;
  resume(): void;
  /**
   * Bug fix (found by code review of Task 5.2's commit f6b79f2): exposes WorldRoom's
   * pause flag so pollPending() can stop a pending navigate's nav_timeout deadline from
   * advancing while the whole world is frozen -- see pollPending()'s doc comment for the
   * full story. Without this, pausing the world for longer than the remaining timeout
   * window (e.g. an admin narrating over a demo) would cause a spurious failed/
   * nav_timeout ack for a navigate that was never actually stuck, just paused along with
   * everything else -- directly undermining the reliability of Task 5.2's own kill
   * switch. The real WorldRoom already has this as a public getter (see WorldRoom.ts's
   * `isPaused`, added alongside pause()/resume() in Task 5.2) -- this is purely a
   * structural addition to the fake-friendly interface so the fix can reach it; no change
   * to WorldRoom.ts was needed.
   */
  readonly isPaused: boolean;
  state: {
    agents: {
      /** `x`/`z`/`route` are optional in this structural type (a fake test double may
       * omit them -- see resolveIfAlreadyArrived()'s doc comment: it treats their absence
       * as "can't determine, fall back to polling" rather than "resolved to nowhere").
       * The real WorldRoom's `Agent` schema (WorldState.ts) always has all four. */
      get(
        id: string,
      ): { state?: string; x?: number; z?: number; route?: ArrayLike<number> } | undefined;
    };
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

// Task 4.2's fleet-scoped topic ("guidemate/virtual/fleet/cmd") happens to also
// structurally match CMD_TOPIC_RE above (one path segment after "virtual/") -- it would
// be misread as a per-robot command for a robot literally named "virtual/fleet". This
// exact topic is therefore checked FIRST in handleMessage(), before extractRobotId ever
// runs, so it is always routed to the fleet handler instead.
const FLEET_CMD_TOPIC = fleetCmdTopic();

export function extractRobotId(topic: string): string | null {
  const match = CMD_TOPIC_RE.exec(topic);
  return match ? match[1] : null;
}

const DEFAULT_NAV_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEDUPE_MAXLEN = 2048;

/** Fast-path arrival tolerance in meters (code-review fix for Task 2.3: see
 * resolveIfAlreadyArrived()). If, at the moment a `navigate` goal is accepted, the agent
 * is already this close to the resolved target, the Crowd will never cross
 * WorldRoom.ts's IDLE_SPEED_THRESHOLD_MPS on the way there -- so the moving->idle EDGE
 * pollPending() waits for literally never fires, and the request would otherwise hang
 * until navTimeoutMs and wrongly ack failed/nav_timeout for a request that actually
 * succeeded instantly (e.g. Moses re-issuing the same room target the agent is already
 * standing in).
 *
 * Reuses AGENT_RADIUS_M (../nav/agentProfile.js) -- the same footprint radius the navmesh
 * is eroded by and the crowd agent is sized with -- instead of inventing a new tolerance
 * concept: anything closer than the agent's own footprint isn't a meaningful navigation,
 * it's re-snapping to (about) the same point. */
const ARRIVAL_TOLERANCE_M = AGENT_RADIUS_M;

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
  /** Wall-clock timestamp of the previous pollPending() tick (any tick, not just ones
   * with pending navs) -- used only to measure how much real time elapsed since the last
   * tick, so a paused tick can shift every pending deadline forward by exactly that much.
   * See pollPending()'s doc comment. */
  private lastPollAt: number | undefined;

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
      // Task 4.2: the fleet-scoped `assign` topic, in addition to the per-robot
      // wildcard above. Already structurally covered by CMD_TOPIC_FILTER's wildcard,
      // but subscribed explicitly per the design decision (a broker MAY deliver one
      // copy per matching subscription; handleMessage()'s existing cmd_id dedupe
      // already tolerates that, same as any other duplicate delivery).
      this.client.subscribe(FLEET_CMD_TOPIC, { qos: 1 }, (err) => {
        if (err) {
          this.log.error(`[iot-bridge] subscribe to ${FLEET_CMD_TOPIC} failed: ${err.message}`);
        } else {
          this.log.log(`[iot-bridge] subscribed to ${FLEET_CMD_TOPIC}`);
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
   * real mqtt 'message' event. topic must be the FULL received topic (not the filter).
   *
   * The fleet topic is checked FIRST, by exact string equality, before extractRobotId
   * ever runs -- see FLEET_CMD_TOPIC's doc comment for why (it would otherwise parse as
   * a per-robot command for a robot literally named "virtual/fleet"). */
  handleMessage(topic: string, payload: Buffer | string): void {
    if (topic === FLEET_CMD_TOPIC) {
      const cmd = this.parseAndDedupe(topic, payload);
      if (cmd) this.handleFleetCommand(cmd);
      return;
    }

    const robotId = extractRobotId(topic);
    if (!robotId) {
      this.log.warn(`[iot-bridge] ignoring message on unexpected topic: ${topic}`);
      return;
    }

    const cmd = this.parseAndDedupe(topic, payload);
    if (cmd) this.handleCommand(robotId, cmd);
  }

  /** Shared JSON-parse + schema-validate + cmd_id-dedupe pipeline for both the per-robot
   * and fleet message paths (factored out of handleMessage() when the fleet path was
   * added -- behavior is unchanged from before for the per-robot path). Returns `null`
   * (having already logged why) for anything that should be dropped silently. */
  private parseAndDedupe(topic: string, payload: Buffer | string): Command | null {
    let raw: unknown;
    try {
      const text = typeof payload === "string" ? payload : payload.toString("utf-8");
      raw = JSON.parse(text);
    } catch (err) {
      this.log.warn(`[iot-bridge] ignoring non-JSON payload on ${topic}: ${(err as Error).message}`);
      return null;
    }

    const cmd = parseCommand(raw);
    if (!cmd) {
      this.log.warn(`[iot-bridge] ignoring invalid command on ${topic}`);
      return null;
    }

    if (this.seenSet.has(cmd.cmd_id)) {
      this.log.log(`[iot-bridge] duplicate cmd_id ignored: ${cmd.cmd_id}`);
      return null;
    }
    this.recordSeen(cmd.cmd_id);
    return cmd;
  }

  /**
   * Task 4.2/5.2: handles a command received on the fleet-scoped topic. Two command
   * types are meaningful there today: `assign` (Task 4.2) and `stop` (Task 5.2, see
   * `handleFleetStop` below). Both are synchronous, unlike `navigate`'s
   * received -> running -> (poll) done lifecycle on the per-robot topic: there is no
   * async Crowd movement to wait on for either, so both go straight from `received` to
   * a terminal `done`/`failed`, no polling needed.
   */
  private handleFleetCommand(cmd: Command): void {
    this.publishFleetAck(makeAck({ cmd_id: cmd.cmd_id, state: "received", simulated: true }));

    if (cmd.type === "stop") {
      this.handleFleetStop(cmd);
      return;
    }

    if (cmd.type !== "assign") {
      this.publishFleetAck(
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
      this.publishFleetAck(
        makeAck({ cmd_id: cmd.cmd_id, state: "failed", reason: "world_not_ready", simulated: true }),
      );
      return;
    }

    // parseCommand already guarantees these are strings for a valid "assign" command.
    const visitorId = cmd.params.visitor_id as string;
    const roomName = cmd.params.room as string;

    // requestGuide requires visitorId to already be a tracked agent (it only lazily
    // creates its own bookkeeping record, not the Crowd/schema agent -- see
    // VisitorManager.requestGuide's doc comment) -- spawn a brand-new real visitor at
    // the entrance the first time this bridge sees this visitor_id. A visitor that
    // already exists (e.g. a retried/second assign for the same session) is left as-is.
    if (!room.state.agents.get(visitorId)) {
      room.addAgent(visitorId, "visitor", room.getEntrancePoint());
    }

    const result = room.requestGuide(visitorId, roomName);
    if (!result) {
      this.publishFleetAck(
        makeAck({ cmd_id: cmd.cmd_id, state: "failed", reason: "no_idle_robot", simulated: true }),
      );
      return;
    }

    this.publishFleetAck(
      makeAck({
        cmd_id: cmd.cmd_id,
        state: "done",
        simulated: true,
        assigned_robot_id: result.robotId,
      }),
    );
  }

  /**
   * Task 5.2: fleet-wide kill switch. Reuses the EXISTING `stop` Command
   * (type="stop", name="stop" -- already valid per messages.ts's parseCommand /
   * messages.py's pydantic model, no schema change needed) arriving on the FLEET topic
   * to mean "freeze the whole virtual world" -- completely distinct from a `stop`
   * arriving on a PER-ROBOT topic (handleCommand() below), which still always acks
   * failed/"unsupported_command_type" exactly as before this task: a per-robot stop is
   * unrelated to this fleet-wide pause and is left untouched (see handleCommand's
   * existing doc comment -- emote/motion/stop have no meaning for a single virtual
   * agent with no physical motor).
   *
   * ---- resume-signal design decision ----
   * There is no existing generic "resume"/"go" Command type or name in the shared wire
   * schema (shared/guidemate_msgs/guidemate_msgs/messages.py + this file's messages.ts),
   * and adding one would mean extending both Literal unions in lockstep for a single
   * boolean bit of information. Instead this overloads the SAME `type="stop"`/
   * `name="stop"` command's already-free-form `params` dict (`Command.params: dict` on
   * the Python side, `Record<string, unknown>` here -- both already accept arbitrary
   * keys, so no schema change is needed either way):
   *   - `stop` with no `params.resume` (or any falsy value)  -> PAUSE  (room.pause()).
   *   - `stop` with `params.resume === true`                 -> RESUME (room.resume()).
   * This is a slightly unusual overload of "stop" (a command literally named "stop"
   * un-freezing the world), which is why it's documented here AND at the admin route
   * that publishes it (agent_service/guidemate_agent/admin.py's `/api/admin/world/stop`
   * and `/api/admin/world/resume`) rather than left to be inferred from the wire alone.
   */
  private handleFleetStop(cmd: Command): void {
    const room = this.getRoom();
    if (!room) {
      this.publishFleetAck(
        makeAck({ cmd_id: cmd.cmd_id, state: "failed", reason: "world_not_ready", simulated: true }),
      );
      return;
    }

    if (cmd.params.resume === true) {
      room.resume();
    } else {
      room.pause();
    }

    this.publishFleetAck(makeAck({ cmd_id: cmd.cmd_id, state: "done", simulated: true }));
  }

  private publishFleetAck(ack: Ack): void {
    const topic = fleetStatusTopic();
    this.client.publish(topic, JSON.stringify(ack), { qos: 1 }, (err) => {
      if (err) this.log.warn(`[iot-bridge] publish to ${topic} failed: ${err.message}`);
    });
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
    this.resolveIfAlreadyArrived(robotId, cmd.cmd_id, target, room);
  }

  /**
   * Code-review fix for Task 2.3: closes the "already at/near target" hang described on
   * ARRIVAL_TOLERANCE_M. Called synchronously right after trackArrival() registers the
   * pending nav -- still inside the same synchronous handleCommand call moveAgentTo
   * returned into, so the agent's `x`/`z`/`route` are guaranteed fresh for THIS request
   * (WorldRoom.moveAgentTo's own doc: it rewrites `route` synchronously, before
   * returning, off the agent's position at request time -- never a stale tick's data).
   *
   * Resolves the target to compare against: a raw `{x, z}` command param is used as-is;
   * a room-name target has no resolved point available to this bridge (moveAgentTo only
   * returns a boolean, and this bridge deliberately does not depend on WorldRoom's
   * internal `nav`/`findRoomTarget` -- see the class doc comment on keeping WorldRoomLike
   * structural), so it's read back out of the agent's synced `route` polyline instead
   * (the route WorldRoom just (re)computed ends at that same resolved target). If neither
   * is available (e.g. computePath failed, or a test double that doesn't populate a
   * route/position), this is a no-op and the existing poll-for-moving->idle / timeout
   * path is the only way the command resolves -- unchanged from before this fix.
   *
   * DESIGN DECISION -- does NOT special-case "the agent was already idle before this
   * request" vs. "the agent was moving toward a DIFFERENT target that happens to land
   * near this new one": both produce the same physical outcome (the Crowd is already
   * within its own footprint of the goal, so it settles effectively instantly regardless
   * of what it was doing a moment ago), and distinguishing them would require tracking
   * "was this agent moving before this call", which is strictly more fragile than just
   * asking "is it there now". A genuinely far-off PRIOR pending nav for this robot was
   * already resolved failed/"superseded" by trackArrival() above, so this check only ever
   * evaluates proximity to the target of the command that is actually in flight.
   */
  private resolveIfAlreadyArrived(
    robotId: string,
    cmdId: string,
    target: string | { x: number; z: number },
    room: WorldRoomLike,
  ): void {
    const agent = room.state.agents.get(robotId);
    if (!agent || typeof agent.x !== "number" || typeof agent.z !== "number") return;

    const resolved = typeof target === "object" ? target : resolvedTargetFromRoute(agent.route);
    if (!resolved) return;

    const distance = Math.hypot(resolved.x - agent.x, resolved.z - agent.z);
    if (distance <= ARRIVAL_TOLERANCE_M) {
      this.resolvePending(cmdId, "done");
    }
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

  /**
   * Bug fix (code review of Task 5.2's commit f6b79f2, confirmed real): this poll loop
   * used to track each pending navigate's expiry with a plain WALL-CLOCK deadline
   * (`Date.now() + navTimeoutMs`, set once in trackArrival()), completely unaware of
   * `WorldRoom.pause()` (also Task 5.2) freezing the Crowd tick on a totally independent
   * timer. So pausing the world while a navigate was in flight -- e.g. an admin pausing
   * to narrate over a demo for a minute -- did nothing to this deadline: it kept expiring
   * on real wall-clock time, so pollPending() would fire a SPURIOUS failed/nav_timeout
   * ack for a command that was legitimately still in progress, just frozen along with
   * everything else. That directly undermined the reliability of the kill switch this
   * bridge itself wires up (handleFleetStop above).
   *
   * DESIGN DECISION (documented here per the task): while paused, wall-clock time does
   * NOT count against navTimeoutMs at all -- i.e. the timeout clock pauses and resumes
   * together with the world, rather than continuing to run out in the background. This
   * is the least-surprising behavior for an admin pausing a live demo: nothing about a
   * paused navigate should look more "at risk of timing out" than it did the moment the
   * pause began. (The alternative -- letting paused time count, just deferring the
   * failed ack until resume -- would still be wrong: it would immediately fail a nav the
   * instant the world resumes, for a delay the admin caused, not the robot.)
   *
   * Mechanism: every poll tick (paused or not) measures how much real time elapsed since
   * the previous tick. If the room reports `isPaused`, every CURRENTLY pending nav's
   * absolute deadline is shifted forward by that elapsed amount, before the
   * expiry check below runs -- so the deadline's position relative to "now" never moves
   * while paused, and the original remaining budget is exactly what's left once resumed.
   * While unpaused this shift is simply never applied, so behavior is byte-for-byte
   * unchanged from before this fix (verified by the pre-existing nav_timeout /
   * already-arrived tests in bridge.test.ts, none of which touch pause/resume).
   *
   * Arrival detection (the moving->idle edge) is intentionally NOT skipped while paused
   * -- it's cheap, it's already keyed off the agent's synced `state` rather than time,
   * and if the world happens to already be unpaused again by the time this tick runs
   * (pause/resume can race an in-flight poll interval), a genuine arrival should still be
   * caught immediately rather than waiting for the next tick. In practice no arrival will
   * be observed while GENUINELY paused, since WorldRoom.update() -- the only thing that
   * ever moves an agent from "moving" to "idle" -- is itself frozen by the same pause.
   */
  private pollPending(): void {
    const now = Date.now();
    const elapsedSinceLastPoll = this.lastPollAt !== undefined ? now - this.lastPollAt : 0;
    this.lastPollAt = now;

    if (this.pending.size === 0) return;
    const room = this.getRoom();

    if (room?.isPaused) {
      for (const nav of this.pending.values()) {
        nav.deadline += elapsedSinceLastPoll;
      }
    }

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

/** Reads the resolved target point back out of an agent's synced `route` (flattened x,z
 * pairs -- see WorldState.ts's `Agent.route` / WorldRoom.ts's `updateAgentRoute`, which
 * always ends the route at the resolved nav-space target). Used by
 * resolveIfAlreadyArrived() for a room-name `navigate` target, since this bridge has no
 * other way to learn what point a room name resolved to. Returns `null` (not a throw) if
 * there's nothing usable to read -- e.g. computePath failed and WorldRoom cleared the
 * route, or a test double that never populated one -- callers must treat that as "can't
 * determine the resolved target", not "resolved to nowhere". */
function resolvedTargetFromRoute(route: ArrayLike<number> | undefined): { x: number; z: number } | null {
  if (!route || route.length < 2) return null;
  const x = route[route.length - 2];
  const z = route[route.length - 1];
  if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }
  return { x, z };
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
