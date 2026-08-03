/**
 * Cross-language conformance test for the Command/Ack wire schema between
 * `shared/guidemate_msgs/guidemate_msgs/messages.py` (pydantic, the single source of
 * truth) and its TypeScript mirror `../messages.ts`. The two files are hand-maintained in
 * lockstep and nothing enforces that -- this test is that enforcement.
 *
 * It does NOT hand-write a table of cases in each language (that could drift the same way
 * the schemas themselves can). Instead it reads a fixture generated from the REAL
 * pydantic models: `world/src/test/fixtures/wireConformance.json`, produced by
 * `shared/guidemate_msgs/scripts/generate_conformance_fixture.py`. See that script's
 * module doc for the full two-hop generation flow (Python generates the Command corpus;
 * TypeScript's own `makeAck()` generates the Ack corpus via `../emitAckCases.ts`, which
 * Python then round-trips through the real `Ack` model).
 *
 * Regenerate the fixture with (from the repo root):
 *
 *     python shared/guidemate_msgs/scripts/generate_conformance_fixture.py
 *
 * This test itself never spawns Python -- it only reads the committed fixture -- so
 * `npm run test:all` stays runnable on a machine with no Python environment at all. If the
 * fixture is missing, this test fails loudly with the regeneration command rather than
 * silently passing on zero cases.
 *
 * Run with: npx tsx src/iot/__tests__/wireConformance.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  cmdTopic,
  statusTopic,
  fleetCmdTopic,
  fleetStatusTopic,
  parseCommand,
  makeAck,
  type AckState,
} from "../messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "../../test/fixtures/wireConformance.json");
const REGEN_CMD = "python shared/guidemate_msgs/scripts/generate_conformance_fixture.py";

interface CommandCase {
  name: string;
  payload: Record<string, unknown>;
  pythonAccepted: boolean;
}

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
  tsOutput: Record<string, unknown>;
  pythonAccepted: boolean;
  pythonRoundTrip: Record<string, unknown> | null;
}

interface TopicCase {
  robotId: string;
  cmdTopic: string;
  statusTopic: string;
}

interface Fixture {
  pydanticVersion: string;
  commandCases: CommandCase[];
  ackCases: AckCase[];
  topicCases: { perRobot: TopicCase[]; fleetCmdTopic: string; fleetStatusTopic: string };
}

function loadFixture(): Fixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Wire-conformance fixture not found at ${FIXTURE_PATH}.\n` +
        `It is a GENERATED file (not hand-written) and must be committed. Generate it with:\n\n` +
        `    ${REGEN_CMD}\n`,
    );
  }
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as Fixture;
}

function main(): void {
  const fixture = loadFixture();

  // A test that silently exercises zero cases passes trivially -- guard against a fixture
  // that loads but is empty (e.g. a bad regeneration run) just as hard as a missing file.
  assert.ok(fixture.commandCases.length > 0, "fixture.commandCases must be non-empty");
  assert.ok(fixture.ackCases.length > 0, "fixture.ackCases must be non-empty");
  assert.ok(fixture.topicCases.perRobot.length > 0, "fixture.topicCases.perRobot must be non-empty");

  // ---- Command direction: Python generated, real parseCommand() verifies ----
  let commandAccepted = 0;
  let commandRejected = 0;
  for (const testCase of fixture.commandCases) {
    const parsed = parseCommand(testCase.payload);
    const tsAccepted = parsed !== null;
    assert.equal(
      tsAccepted,
      testCase.pythonAccepted,
      `command case "${testCase.name}": Python accepted=${testCase.pythonAccepted} but ` +
        `TypeScript's parseCommand() accepted=${tsAccepted} for payload ` +
        `${JSON.stringify(testCase.payload)}`,
    );
    if (tsAccepted) commandAccepted++;
    else commandRejected++;
  }
  console.log(
    `PASS: ${fixture.commandCases.length} command cases agree with Python ` +
      `(${commandAccepted} accepted, ${commandRejected} rejected)`,
  );

  // ---- Ack direction: real makeAck() generated (at fixture-generation time), Python
  // round-tripped it through the real Ack model. Re-run makeAck() here (proving this test
  // exercises the CURRENT real implementation, not a frozen string) and compare against
  // the fixture's recorded Python round trip, field for field. ----
  let assignedRobotIdCasesChecked = 0;
  for (const testCase of fixture.ackCases) {
    assert.ok(testCase.pythonAccepted, `ack case "${testCase.name}": Python must have accepted it`);
    assert.ok(testCase.pythonRoundTrip, `ack case "${testCase.name}": missing pythonRoundTrip`);

    const liveAck = makeAck(testCase.partial);
    const { ts: _ts, ...liveFields } = liveAck;

    // Sanity: the fixture's frozen tsOutput must match what makeAck() produces right now
    // for the same partial input -- if this ever diverges, either the fixture is stale or
    // makeAck() changed behavior without regenerating.
    assert.deepEqual(
      liveFields,
      testCase.tsOutput,
      `ack case "${testCase.name}": live makeAck() output no longer matches the fixture's ` +
        `frozen tsOutput -- regenerate with: ${REGEN_CMD}`,
    );

    // The actual cross-language assertion: Python's real Ack model, parsing exactly what
    // TypeScript emitted, must round-trip every field unchanged.
    assert.deepEqual(
      liveFields,
      testCase.pythonRoundTrip,
      `ack case "${testCase.name}": Python's Ack model round-trip does not match TypeScript's ` +
        `makeAck() output -- a field was dropped, renamed, or changed value crossing languages`,
    );

    if (testCase.partial.assigned_robot_id != null) {
      assert.equal(
        liveFields.assigned_robot_id,
        testCase.partial.assigned_robot_id,
        `ack case "${testCase.name}": assigned_robot_id must survive the TS->Python round trip unchanged`,
      );
      assignedRobotIdCasesChecked++;
    }
  }
  assert.ok(
    assignedRobotIdCasesChecked > 0,
    "at least one ack case must exercise a non-null assigned_robot_id (the field most likely to be dropped silently)",
  );
  console.log(
    `PASS: ${fixture.ackCases.length} ack cases round-trip identically through Python ` +
      `(${assignedRobotIdCasesChecked} exercising a non-null assigned_robot_id)`,
  );

  // ---- Topic helpers: byte-identical strings on both sides ----
  for (const topicCase of fixture.topicCases.perRobot) {
    assert.equal(
      cmdTopic(topicCase.robotId),
      topicCase.cmdTopic,
      `cmdTopic("${topicCase.robotId}") must byte-match the Python cmd_topic() helper`,
    );
    assert.equal(
      statusTopic(topicCase.robotId),
      topicCase.statusTopic,
      `statusTopic("${topicCase.robotId}") must byte-match the Python status_topic() helper`,
    );
  }
  assert.equal(fleetCmdTopic(), fixture.topicCases.fleetCmdTopic);
  assert.equal(fleetStatusTopic(), fixture.topicCases.fleetStatusTopic);
  assert.ok(
    fixture.topicCases.perRobot.some((c) => c.robotId.includes("/")),
    "topic fixture must include a robot id containing a slash (e.g. 'virtual/1')",
  );
  console.log(
    `PASS: ${fixture.topicCases.perRobot.length} per-robot + 2 fleet topic-helper cases are byte-identical with Python`,
  );

  const totalCases = fixture.commandCases.length + fixture.ackCases.length + fixture.topicCases.perRobot.length + 2;
  assert.ok(totalCases > 0, "must have exercised a non-zero number of conformance cases");
  console.log(`\nALL PASS: wireConformance.test.ts (${totalCases} total cases, pydantic ${fixture.pydanticVersion})`);
}

main();
