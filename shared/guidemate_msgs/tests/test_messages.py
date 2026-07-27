import json

import pytest
from pydantic import ValidationError

from guidemate_msgs.messages import (
    Ack,
    Command,
    Heartbeat,
    cmd_topic,
    new_cmd_id,
    status_topic,
)


def test_command_defaults_and_roundtrip():
    cmd = Command(type="emote", name="happy")
    assert cmd.cmd_id
    assert cmd.params == {}
    assert cmd.ts.endswith("+00:00")
    restored = Command.model_validate_json(cmd.model_dump_json())
    assert restored == cmd


def test_command_rejects_bad_emote_name():
    with pytest.raises(ValidationError):
        Command(type="emote", name="sad")


def test_command_rejects_bad_motion_name():
    with pytest.raises(ValidationError):
        Command(type="motion", name="teleport")


def test_command_stop_requires_stop_name():
    Command(type="stop", name="stop")
    with pytest.raises(ValidationError):
        Command(type="stop", name="halt")


def test_command_accepts_all_emote_names_unchanged():
    for name in ("happy", "yes", "no"):
        cmd = Command(type="emote", name=name)
        assert cmd.type == "emote"
        assert cmd.name == name


def test_command_accepts_all_motion_names_unchanged():
    for name in ("circle", "spin", "dock", "undock", "forward"):
        cmd = Command(type="motion", name=name)
        assert cmd.type == "motion"
        assert cmd.name == name


def test_command_stop_unchanged():
    cmd = Command(type="stop", name="stop")
    assert cmd.type == "stop"
    assert cmd.name == "stop"
    with pytest.raises(ValidationError):
        Command(type="stop", name="halt")


def test_command_navigate_valid_with_room():
    cmd = Command(type="navigate", name="goto", params={"room": "1425"})
    assert cmd.type == "navigate"
    assert cmd.name == "goto"
    assert cmd.params == {"room": "1425"}
    restored = Command.model_validate_json(cmd.model_dump_json())
    assert restored == cmd


def test_command_navigate_valid_with_xz():
    cmd = Command(type="navigate", name="goto", params={"x": 1.5, "z": -2.0})
    assert cmd.type == "navigate"
    assert cmd.params == {"x": 1.5, "z": -2.0}
    restored = Command.model_validate_json(cmd.model_dump_json())
    assert restored == cmd


def test_command_navigate_valid_with_int_xz():
    cmd = Command(type="navigate", name="goto", params={"x": 1, "z": 2})
    assert cmd.params == {"x": 1, "z": 2}


def test_command_navigate_rejects_neither_room_nor_xz():
    with pytest.raises(ValidationError):
        Command(type="navigate", name="goto", params={})
    with pytest.raises(ValidationError):
        Command(type="navigate", name="goto", params={"x": 1.0})
    with pytest.raises(ValidationError):
        Command(type="navigate", name="goto", params={"z": 1.0})


def test_command_navigate_rejects_non_string_room():
    with pytest.raises(ValidationError):
        Command(type="navigate", name="goto", params={"room": 1425})


def test_command_navigate_rejects_bad_name():
    with pytest.raises(ValidationError):
        Command(type="navigate", name="warp", params={"room": "1425"})


def test_ack_defaults():
    ack = Ack(cmd_id="abc", state="done", simulated=True)
    assert ack.reason is None
    assert ack.battery is None
    assert ack.simulated is True
    data = json.loads(ack.model_dump_json())
    assert data["state"] == "done"


def test_new_cmd_id_unique():
    assert new_cmd_id() != new_cmd_id()


def test_topic_helpers():
    assert cmd_topic("turtlebot468") == "guidemate/turtlebot468/cmd"
    assert status_topic("turtlebot468") == "guidemate/turtlebot468/status"


def test_ack_gates_default_none_and_roundtrip():
    ack = Ack(cmd_id="a", state="done")
    assert ack.gates is None
    gates = {"docked": True, "motion_enabled": False, "dry_run": True}
    ack2 = Ack(cmd_id="a", state="failed", reason="docked", gates=gates)
    restored = Ack.model_validate_json(ack2.model_dump_json())
    assert restored.gates == gates


def test_motion_accepts_dock_and_undock_roundtrip():
    for name in ("dock", "undock"):
        cmd = Command(type="motion", name=name)
        restored = Command.model_validate_json(cmd.model_dump_json())
        assert restored == cmd
        assert restored.type == "motion"
        assert restored.name == name


def test_heartbeat_defaults_and_roundtrip():
    hb = Heartbeat(
        robot_id="turtlebot468",
        uptime_s=12.5,
        gates={"docked": None, "motion_enabled": False, "dry_run": True},
    )
    assert hb.event == "heartbeat"
    assert hb.battery is None
    assert hb.docked is None
    assert hb.ts.endswith("+00:00")
    data = json.loads(hb.model_dump_json())
    assert data["event"] == "heartbeat"
    restored = Heartbeat.model_validate(data)
    assert restored == hb
