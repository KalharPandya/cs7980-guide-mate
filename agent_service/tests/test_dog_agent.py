"""Unit tests for DogAgent's tool-closure body — no Bedrock, no network."""

from guidemate_msgs.messages import Ack

from guidemate_agent.dog_agent import DogAgent, PERSONA


class FakeRegistry:
    """Registry stand-in whose send_command always reports the robot unreachable."""

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        return []


def test_emote_impl_returns_napping_offline_when_no_acks():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )
    captured = {"emote": None, "acks": []}

    result = agent._emote_impl("happy", target="turtlebot468", captured=captured)

    assert result == "robot did not respond — I'm probably napping offline"
    assert captured["emote"] == "happy"
    assert captured["acks"] == []


def test_emote_impl_returns_napping_offline_when_no_target():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=[],
    )
    captured = {"emote": None, "acks": []}

    result = agent._emote_impl("no", target=None, captured=captured)

    assert result == "robot did not respond — I'm probably napping offline"
    assert captured["emote"] == "no"
    assert captured["acks"] == []


class ScriptedRegistry:
    """Registry stand-in returning a scripted ack list; records get_status calls."""

    def __init__(self, acks=None, status=None):
        self._acks = acks or []
        self._status = status or {"robot_id": "turtlebot468", "presence": "unknown"}
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.sent.append((robot_id, cmd))
        return list(self._acks)

    def get_status(self, robot_id):
        return dict(self._status)


def _agent(registry):
    return DogAgent(
        registry=registry,
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )


def _captured():
    return {"emote": None, "acks": []}


def test_motion_impl_refused_docked():
    acks = [Ack(cmd_id="c", state="received", simulated=False),
            Ack(cmd_id="c", state="failed", reason="docked", simulated=False,
                gates={"docked": True, "motion_enabled": True, "dry_run": False})]
    reg = ScriptedRegistry(acks=acks)
    captured = _captured()
    result = _agent(reg)._motion_impl("spin", target="turtlebot468", captured=captured)
    assert result == "the robot refused: it is docked"
    assert captured["acks"][-1]["reason"] == "docked"
    assert reg.sent[0][1].type == "motion"


def test_motion_impl_refused_motion_disabled():
    acks = [Ack(cmd_id="c", state="failed", reason="motion_disabled", simulated=False)]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "circle", target="turtlebot468", captured=_captured())
    assert result == "the robot refused: motion is disabled"


def test_motion_impl_simulated_done():
    acks = [Ack(cmd_id="c", state="done", simulated=True,
                gates={"docked": None, "motion_enabled": False, "dry_run": True})]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_motion_impl_unknown_trick_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("moonwalk", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []  # invalid name rejected client-side, nothing published


def test_motion_impl_offline():
    result = _agent(ScriptedRegistry(acks=[]))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "robot did not respond — I'm probably napping offline"


def test_stop_impl_sends_stop_command():
    acks = [Ack(cmd_id="c", state="done", simulated=True)]
    reg = ScriptedRegistry(acks=acks)
    result = _agent(reg)._stop_impl(target="turtlebot468", captured=_captured())
    assert reg.sent[0][1].type == "stop"
    assert reg.sent[0][1].name == "stop"
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_status_impl_returns_registry_status_json():
    import json as _json
    status = {"robot_id": "turtlebot468", "presence": "online", "battery": 0.9,
              "docked": True, "gates": {"docked": True, "motion_enabled": False,
                                        "dry_run": True}}
    result = _agent(ScriptedRegistry(status=status))._status_impl("turtlebot468")
    assert _json.loads(result)["battery"] == 0.9


def test_persona_mentions_new_tools_and_docked_rule():
    assert "run_motion" in PERSONA
    assert "docked" in PERSONA
