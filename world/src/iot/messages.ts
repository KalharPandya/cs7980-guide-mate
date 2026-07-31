/**
 * Command / Ack wire schema -- TypeScript mirror of `shared/guidemate_msgs/guidemate_msgs/
 * messages.py` (the single source of truth; this file must NOT drift from it). Field names
 * are the exact snake_case pydantic defaults -- the JS side produces/consumes the identical
 * JSON keys, not camelCase.
 *
 * `cmd_topic`/`status_topic` are byte-for-byte ports of the Python helpers so a robot id of
 * "virtual/1" still yields "guidemate/virtual/1/cmd" / "guidemate/virtual/1/status", exactly
 * like the Python bridge and RobotRegistry expect.
 */
import { randomUUID } from "node:crypto";

export type CommandType = "emote" | "motion" | "stop" | "navigate" | "assign";
export type AckState = "received" | "running" | "done" | "failed";

const EMOTE_NAMES = ["happy", "yes", "no"] as const;
const MOTION_NAMES = ["circle", "spin", "dock", "undock", "forward"] as const;
const NAVIGATE_NAMES = ["goto"] as const;
const ASSIGN_NAME = "assign";

export interface Command {
  cmd_id: string;
  type: CommandType;
  name: string;
  params: Record<string, unknown>;
  ts: string;
}

export interface Ack {
  cmd_id: string;
  state: AckState;
  reason?: string | null;
  simulated: boolean;
  battery?: number | null;
  gates?: Record<string, unknown> | null;
  /** The robot picked for an "assign" command (e.g. "virtual/3"). Only ever set on
   * the `done` ack of an assign; null for every other command/outcome. Mirrors
   * messages.py's Ack.assigned_robot_id -- see that field's doc comment. */
  assigned_robot_id?: string | null;
  ts: string;
}

export function newCmdId(): string {
  return randomUUID();
}

function utcNowIso(): string {
  return new Date().toISOString();
}

/** Builds a well-formed Ack with the ts/simulated defaults the Python side also applies. */
export function makeAck(partial: {
  cmd_id: string;
  state: AckState;
  reason?: string | null;
  simulated?: boolean;
  battery?: number | null;
  gates?: Record<string, unknown> | null;
  assigned_robot_id?: string | null;
}): Ack {
  return {
    cmd_id: partial.cmd_id,
    state: partial.state,
    reason: partial.reason ?? null,
    simulated: partial.simulated ?? false,
    battery: partial.battery ?? null,
    gates: partial.gates ?? null,
    assigned_robot_id: partial.assigned_robot_id ?? null,
    ts: utcNowIso(),
  };
}

export function cmdTopic(robotId: string): string {
  return `guidemate/${robotId}/cmd`;
}

export function statusTopic(robotId: string): string {
  return `guidemate/${robotId}/status`;
}

// Fleet-scoped topics (not per-robot): "assign" a visitor to a robot before any robot
// id is known. Mirrors messages.py's fleet_cmd_topic()/fleet_status_topic() -- kept as
// named helpers rather than a magic "fleet" robot id through cmd_topic/status_topic.
export function fleetCmdTopic(): string {
  return "guidemate/virtual/fleet/cmd";
}

export function fleetStatusTopic(): string {
  return "guidemate/virtual/fleet/status";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a parsed JSON payload against the Command schema (mirrors messages.py's
 * pydantic model_validator: type-specific name enums, and navigate's `room` XOR `x`/`z`
 * params requirement). Returns `null` (never throws) on any schema violation -- callers log
 * and drop the message, exactly like the Python bridge's `on_message` does for a
 * `ValidationError`.
 */
export function parseCommand(raw: unknown): Command | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.cmd_id !== "string" || obj.cmd_id.length === 0) return null;
  if (typeof obj.type !== "string") return null;
  if (typeof obj.name !== "string") return null;
  const params =
    typeof obj.params === "object" && obj.params !== null
      ? (obj.params as Record<string, unknown>)
      : {};
  const ts = typeof obj.ts === "string" ? obj.ts : utcNowIso();

  switch (obj.type) {
    case "emote":
      if (!EMOTE_NAMES.includes(obj.name as (typeof EMOTE_NAMES)[number])) return null;
      break;
    case "motion":
      if (!MOTION_NAMES.includes(obj.name as (typeof MOTION_NAMES)[number])) return null;
      break;
    case "stop":
      if (obj.name !== "stop") return null;
      break;
    case "navigate": {
      if (!NAVIGATE_NAMES.includes(obj.name as (typeof NAVIGATE_NAMES)[number])) return null;
      const hasRoom = typeof params.room === "string";
      const hasXz = isNumber(params.x) && isNumber(params.z);
      if (!hasRoom && !hasXz) return null;
      break;
    }
    case "assign": {
      // Fleet-scoped: no robot id anywhere on this command (see fleetCmdTopic's doc
      // comment) -- the payload instead carries WHO to assign (visitor_id) and WHERE
      // to guide them (room). `name` is a stable constant, exactly like `stop`.
      if (obj.name !== ASSIGN_NAME) return null;
      if (typeof params.visitor_id !== "string" || typeof params.room !== "string") return null;
      break;
    }
    default:
      return null;
  }

  return {
    cmd_id: obj.cmd_id,
    type: obj.type as CommandType,
    name: obj.name,
    params,
    ts,
  };
}
