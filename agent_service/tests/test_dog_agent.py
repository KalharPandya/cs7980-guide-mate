"""Unit tests for DogAgent's tool-closure body — no Bedrock, no network."""

from guidemate_agent.dog_agent import DogAgent


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
