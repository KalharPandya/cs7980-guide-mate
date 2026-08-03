/**
 * Cross-language conformance fixture generator, TS half (Ack direction).
 *
 * Part of the Command/Ack wire-schema conformance test between `shared/guidemate_msgs/
 * guidemate_msgs/messages.py` (the pydantic single source of truth) and its TypeScript
 * mirror `./messages.ts`. This script is NOT run by `npm test` -- it is only invoked by
 * the fixture generator (`shared/guidemate_msgs/scripts/generate_conformance_fixture.py`)
 * as its "TS emits" half. See that file's module doc for the full two-hop generation flow
 * and the regeneration command.
 *
 * Deliberately lives beside `messages.ts` (not under `world/scripts/`, which is
 * concurrently owned by another workstream) since it is tooling for the wire-schema
 * fixture, not a standalone script.
 *
 * Calls the REAL `makeAck()` from `./messages.ts` for a corpus of partial Ack inputs
 * (covering every AckState, every optional field individually, all fields together, and
 * -- most importantly, since this is the field most likely to be dropped silently by a
 * pydantic model that ignores unknown keys -- `assigned_robot_id` set to a real value).
 * Strips the non-deterministic `ts` field and prints one JSON array to stdout:
 * `[{ name, partial, tsOutput }, ...]`.
 *
 * The generator's Python half then feeds each `tsOutput` through the REAL pydantic `Ack`
 * model (`Ack.model_validate(...).model_dump(...)`) and records the round-tripped result
 * in the committed fixture. The TS conformance test (`__tests__/wireConformance.test.ts`)
 * then re-calls `makeAck()` itself at test time (proving it exercises the real current
 * implementation, not a frozen string) and asserts its output matches the fixture's
 * Python-round-tripped value field-for-field.
 *
 * Run via: npx tsx src/iot/emitAckCases.ts   (cwd must be world/)
 */
import { makeAck, type Ack, type AckState } from "./messages.js";

interface AckCasePartial {
  cmd_id: string;
  state: AckState;
  reason?: string | null;
  simulated?: boolean;
  battery?: number | null;
  gates?: Record<string, unknown> | null;
  assigned_robot_id?: string | null;
}

interface AckCase {
  name: string;
  partial: AckCasePartial;
}

const CASES: AckCase[] = [
  { name: "minimal_received", partial: { cmd_id: "ack-1", state: "received" } },
  { name: "state_running", partial: { cmd_id: "ack-2", state: "running" } },
  { name: "state_done", partial: { cmd_id: "ack-3", state: "done" } },
  { name: "state_failed", partial: { cmd_id: "ack-4", state: "failed" } },
  { name: "reason_set", partial: { cmd_id: "ack-5", state: "failed", reason: "target_unresolved" } },
  { name: "reason_explicit_null", partial: { cmd_id: "ack-6", state: "done", reason: null } },
  { name: "simulated_true", partial: { cmd_id: "ack-7", state: "done", simulated: true } },
  { name: "simulated_false", partial: { cmd_id: "ack-8", state: "done", simulated: false } },
  { name: "battery_set", partial: { cmd_id: "ack-9", state: "running", battery: 0.73 } },
  { name: "battery_zero", partial: { cmd_id: "ack-10", state: "running", battery: 0 } },
  { name: "battery_explicit_null", partial: { cmd_id: "ack-11", state: "running", battery: null } },
  {
    name: "gates_set",
    partial: {
      cmd_id: "ack-12",
      state: "failed",
      reason: "docked",
      gates: { docked: true, motion_enabled: false, dry_run: true },
    },
  },
  { name: "gates_explicit_null", partial: { cmd_id: "ack-13", state: "done", gates: null } },
  // The field most likely to be silently dropped by a pydantic model that ignores
  // unknown keys by default -- this is the case that actually proves the round trip,
  // not just "some fields with the right names". See messages.py's Ack.assigned_robot_id
  // doc comment and messages.ts's mirrored one.
  { name: "assigned_robot_id_set", partial: { cmd_id: "ack-14", state: "done", assigned_robot_id: "virtual/3" } },
  {
    name: "assigned_robot_id_set_slash_id",
    partial: { cmd_id: "ack-15", state: "done", assigned_robot_id: "virtual/12" },
  },
  { name: "assigned_robot_id_explicit_null", partial: { cmd_id: "ack-16", state: "failed", assigned_robot_id: null } },
  {
    name: "all_fields_set_together",
    partial: {
      cmd_id: "ack-17",
      state: "done",
      reason: "ok",
      simulated: true,
      battery: 0.42,
      gates: { docked: false, motion_enabled: true, dry_run: false },
      assigned_robot_id: "virtual/7",
    },
  },
];

function stripTs(ack: Ack): Omit<Ack, "ts"> {
  const { ts: _ts, ...rest } = ack;
  return rest;
}

const output = CASES.map(({ name, partial }) => ({
  name,
  partial,
  tsOutput: stripTs(makeAck(partial)),
}));

process.stdout.write(JSON.stringify(output));
