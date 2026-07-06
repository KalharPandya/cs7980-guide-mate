import json

import pytest
from pydantic import ValidationError

from guidemate_msgs.messages import (
    Ack,
    Command,
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
