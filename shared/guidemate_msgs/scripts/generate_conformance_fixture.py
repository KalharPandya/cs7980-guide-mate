"""Cross-language conformance fixture generator (Command/Ack wire schema).

Generates `world/src/test/fixtures/wireConformance.json`, the single committed fixture
consumed by `world/src/iot/__tests__/wireConformance.test.ts` to prove
`shared/guidemate_msgs/guidemate_msgs/messages.py` (pydantic, the single source of truth)
and `world/src/iot/messages.ts` (its TypeScript mirror) agree on the wire shape.

This is NOT a hand-written table of cases duplicated in each language -- that would drift
the exact same way the schemas themselves can. Instead:

  Command direction (Python generates, TypeScript verifies):
    For every command `type`, every valid `name`, the boundary cases the validator cares
    about (navigate with only `room`, only `x`/`z`, both; assign with both required
    params), plus invalid payloads pydantic rejects (bad name for a type, navigate
    missing both targets, assign missing `visitor_id`, unknown type) -- this script tries
    to construct each one through the REAL `Command` pydantic model and records whether
    Python accepted it. The TS test feeds the same payload through the REAL
    `parseCommand()` and asserts the accept/reject verdict matches.

  Ack direction (TypeScript generates, Python verifies), the other way around:
    `world/src/iot/emitAckCases.ts` calls the REAL `makeAck()` for a corpus of partial Ack
    inputs (see that file for the full case list, including `assigned_robot_id` -- the
    field most likely to be dropped silently by a pydantic model that ignores unknown
    keys by default). This script invokes that TS script via `npx tsx` (real Node
    process, real current implementation, not a frozen string), then feeds each emitted
    Ack JSON through the REAL pydantic `Ack` model (`model_validate` -> `model_dump`) and
    records the round-tripped result. The TS test re-calls `makeAck()` itself at test time
    and asserts its output matches this Python-round-tripped value field-for-field.

  Topic helpers:
    Byte-identical string cases for `cmd_topic`/`status_topic`/`fleet_cmd_topic`/
    `fleet_status_topic`, including a "virtual/1"-style robot id containing a slash,
    computed here with the REAL Python helpers. The TS test computes the same with the
    REAL TS helpers and asserts an exact string match.

Regenerate with (from the repo root):

    python shared/guidemate_msgs/scripts/generate_conformance_fixture.py

Requires: a Python environment with `pydantic` importable (the plain `python` on PATH in
this repo's dev environment already has it -- see `python -c "import pydantic"`), and
`node`/`npx` on PATH with `world/`'s dependencies installed (`npx tsx` must work from the
`world/` directory).

The committed fixture lets `world`'s test suite (`npm run test:all`) stay runnable on a
machine with no Python environment at all -- only regeneration needs both languages.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SHARED_MSGS_DIR = REPO_ROOT / "shared" / "guidemate_msgs"
WORLD_DIR = REPO_ROOT / "world"
FIXTURE_PATH = WORLD_DIR / "src" / "test" / "fixtures" / "wireConformance.json"

sys.path.insert(0, str(SHARED_MSGS_DIR))

import pydantic  # noqa: E402  (needs the sys.path insert above for guidemate_msgs, not this)
from pydantic import ValidationError  # noqa: E402

from guidemate_msgs.messages import (  # noqa: E402
    Ack,
    Command,
    cmd_topic,
    fleet_cmd_topic,
    fleet_status_topic,
    status_topic,
)

FIXED_TS = "2026-08-03T00:00:00+00:00"


def _try_command(case_name: str, **kwargs) -> dict:
    """Attempt to construct a Command through the real pydantic model. Records the exact
    payload attempted (with a fixed cmd_id/ts so the fixture is deterministic) and
    whether Python accepted it -- this is the ground truth the TS test's parseCommand()
    verdict must match."""
    cmd_id = kwargs.pop("cmd_id", f"fixture-{case_name}")
    payload = {"cmd_id": cmd_id, "ts": FIXED_TS, **kwargs}
    try:
        Command(**payload)
        accepted = True
    except ValidationError:
        accepted = False
    return {"name": case_name, "payload": payload, "pythonAccepted": accepted}


def generate_command_cases() -> list[dict]:
    cases: list[dict] = []

    # ---- emote: every valid name + one invalid ----
    for emote_name in ("happy", "yes", "no"):
        cases.append(_try_command(f"emote_valid_{emote_name}", type="emote", name=emote_name, params={}))
    cases.append(_try_command("emote_invalid_bad_name", type="emote", name="sad", params={}))

    # ---- motion: every valid name + one invalid ----
    for motion_name in ("circle", "spin", "dock", "undock", "forward"):
        cases.append(_try_command(f"motion_valid_{motion_name}", type="motion", name=motion_name, params={}))
    cases.append(_try_command("motion_invalid_bad_name", type="motion", name="teleport", params={}))

    # ---- stop: only "stop" is valid ----
    cases.append(_try_command("stop_valid", type="stop", name="stop", params={}))
    cases.append(_try_command("stop_invalid_bad_name", type="stop", name="halt", params={}))

    # ---- navigate: name must be "goto"; params need room OR x+z (boundary cases) ----
    cases.append(_try_command("navigate_valid_room_only", type="navigate", name="goto", params={"room": "1425"}))
    cases.append(_try_command("navigate_valid_xz_only", type="navigate", name="goto", params={"x": 1.5, "z": -2.0}))
    cases.append(_try_command("navigate_valid_xz_ints", type="navigate", name="goto", params={"x": 1, "z": 2}))
    cases.append(
        _try_command(
            "navigate_valid_room_and_xz_both",
            type="navigate",
            name="goto",
            params={"room": "1425", "x": 1.0, "z": 2.0},
        )
    )
    cases.append(_try_command("navigate_invalid_neither_room_nor_xz", type="navigate", name="goto", params={}))
    cases.append(_try_command("navigate_invalid_x_only", type="navigate", name="goto", params={"x": 1.0}))
    cases.append(_try_command("navigate_invalid_z_only", type="navigate", name="goto", params={"z": 1.0}))
    cases.append(
        _try_command("navigate_invalid_non_string_room", type="navigate", name="goto", params={"room": 1425})
    )
    cases.append(
        _try_command("navigate_invalid_bad_name", type="navigate", name="warp", params={"room": "1425"})
    )

    # ---- assign: name must be "assign"; params need both visitor_id and room ----
    cases.append(
        _try_command(
            "assign_valid_both_params",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425"},
        )
    )
    cases.append(
        _try_command("assign_invalid_missing_visitor_id", type="assign", name="assign", params={"room": "Classroom 1425"})
    )
    cases.append(
        _try_command("assign_invalid_missing_room", type="assign", name="assign", params={"visitor_id": "visitor-1"})
    )
    cases.append(_try_command("assign_invalid_empty_params", type="assign", name="assign", params={}))
    cases.append(
        _try_command(
            "assign_invalid_non_string_visitor_id",
            type="assign",
            name="assign",
            params={"visitor_id": 123, "room": "Classroom 1425"},
        )
    )
    cases.append(
        _try_command(
            "assign_invalid_non_string_room",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": 1425},
        )
    )
    # optional `from_room` (where the visitor currently is): absent and null are both
    # "not provided"; a string is accepted; anything else is a schema violation. The
    # null case is the one most likely to drift between the two languages (Python's
    # None vs. TypeScript's undefined), so it is a fixture case, not just a unit test.
    cases.append(
        _try_command(
            "assign_valid_with_from_room",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425", "from_room": "Kitchen"},
        )
    )
    cases.append(
        _try_command(
            "assign_valid_null_from_room",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425", "from_room": None},
        )
    )
    cases.append(
        _try_command(
            "assign_invalid_non_string_from_room",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425", "from_room": 1425},
        )
    )
    cases.append(
        _try_command(
            "assign_invalid_object_from_room",
            type="assign",
            name="assign",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425", "from_room": {"name": "Kitchen"}},
        )
    )
    cases.append(
        _try_command(
            "assign_invalid_bad_name",
            type="assign",
            name="dispatch",
            params={"visitor_id": "visitor-1", "room": "Classroom 1425"},
        )
    )

    # ---- unknown command type ----
    cases.append(_try_command("unknown_type", type="teleport", name="goto", params={}))

    return cases


def generate_ack_cases() -> list[dict]:
    """Runs the TS half (`world/src/iot/emitAckCases.ts`) as a real subprocess, then feeds
    each emitted Ack JSON through the real pydantic Ack model and records the round trip."""
    result = subprocess.run(
        ["npx", "tsx", "src/iot/emitAckCases.ts"],
        cwd=str(WORLD_DIR),
        capture_output=True,
        text=True,
        check=False,
        shell=(sys.platform == "win32"),
    )
    if result.returncode != 0:
        raise RuntimeError(
            "world/src/iot/emitAckCases.ts failed (npx tsx exit "
            f"{result.returncode}):\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
    ts_cases = json.loads(result.stdout)

    ack_cases: list[dict] = []
    for case in ts_cases:
        ts_output = case["tsOutput"]
        try:
            ack = Ack.model_validate(ts_output)
            python_accepted = True
            python_round_trip = json.loads(ack.model_dump_json(exclude={"ts"}))
        except ValidationError:
            python_accepted = False
            python_round_trip = None
        ack_cases.append(
            {
                "name": case["name"],
                "partial": case["partial"],
                "tsOutput": ts_output,
                "pythonAccepted": python_accepted,
                "pythonRoundTrip": python_round_trip,
            }
        )
    return ack_cases


def generate_topic_cases() -> dict:
    robot_ids = ["turtlebot468", "virtual/1", "virtual/12"]
    per_robot = [
        {"robotId": robot_id, "cmdTopic": cmd_topic(robot_id), "statusTopic": status_topic(robot_id)}
        for robot_id in robot_ids
    ]
    return {
        "perRobot": per_robot,
        "fleetCmdTopic": fleet_cmd_topic(),
        "fleetStatusTopic": fleet_status_topic(),
    }


def main() -> None:
    command_cases = generate_command_cases()
    ack_cases = generate_ack_cases()
    topic_cases = generate_topic_cases()

    fixture = {
        "_comment": (
            "GENERATED FILE -- do not hand-edit. Regenerate with: "
            "python shared/guidemate_msgs/scripts/generate_conformance_fixture.py "
            "(see that script's module doc for the full two-hop generation flow)."
        ),
        "pydanticVersion": pydantic.VERSION,
        "commandCases": command_cases,
        "ackCases": ack_cases,
        "topicCases": topic_cases,
    }

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")

    accepted = sum(1 for c in command_cases if c["pythonAccepted"])
    rejected = len(command_cases) - accepted
    print(f"Wrote {FIXTURE_PATH}")
    print(f"  commandCases: {len(command_cases)} ({accepted} accepted, {rejected} rejected)")
    print(f"  ackCases: {len(ack_cases)}")
    print(f"  topicCases: {len(topic_cases['perRobot'])} per-robot + 2 fleet")


if __name__ == "__main__":
    main()
