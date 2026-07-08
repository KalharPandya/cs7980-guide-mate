from guidemate_msgs.messages import Ack, Command

from guidemate_agent.emote_sync import GATE_STATES, emote_sync, gate_released


def _acks(*states):
    return [Ack(cmd_id="c1", state=s, simulated=True) for s in states]


def test_gate_states_are_running_and_done():
    assert GATE_STATES == ("running", "done")


def test_gate_not_released_on_empty():
    assert gate_released([]) is False


def test_gate_not_released_on_received_only():
    assert gate_released(_acks("received")) is False


def test_gate_not_released_on_failed_only():
    # A refused emote (received -> failed, no running/done) must NOT release the
    # gate — else the voice reply fires for a motion the robot rejected. Only the
    # caller's timeout fallback releases here.
    assert gate_released(_acks("failed")) is False
    assert gate_released(_acks("received", "failed")) is False


def test_gate_released_on_running():
    assert gate_released(_acks("received", "running")) is True


def test_gate_released_when_done_arrives_before_running():
    # QoS1 out-of-order: done can land before running. Order must not matter.
    assert gate_released(_acks("received", "done", "running")) is True
    assert gate_released(_acks("done", "running")) is True


def test_gate_released_on_done_without_running():
    # received -> done, running never delivered. Still released.
    assert gate_released(_acks("received", "done")) is True


class _FakeRegistry:
    def __init__(self, acks):
        self._acks = acks
        self.published = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.published.append((robot_id, cmd.name, timeout_s))
        return list(self._acks)


def test_emote_sync_virtual_releases_immediately_without_publishing():
    reg = _FakeRegistry(_acks("received", "running", "done"))
    released, acks = emote_sync(reg, None, Command(type="emote", name="happy"))
    assert released is True
    assert acks == []
    assert reg.published == []  # virtual path never touches the robot


def test_emote_sync_physical_happy_path():
    reg = _FakeRegistry(_acks("received", "running", "done"))
    released, acks = emote_sync(reg, "turtlebot468", Command(type="emote", name="happy"))
    assert released is True
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert reg.published == [("turtlebot468", "happy", 2.0)]


def test_emote_sync_timeout_fallback_returns_not_released():
    # Robot silent -> send_command times out with an empty list -> gate not released,
    # but we still return so the caller can release the reply anyway (2.0 s fallback).
    reg = _FakeRegistry([])
    released, acks = emote_sync(reg, "turtlebot468", Command(type="emote", name="no"))
    assert released is False
    assert acks == []
