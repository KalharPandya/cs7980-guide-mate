import pytest

from guidemate_agent.dog_agent import DogAgent


class FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        from guidemate_msgs.messages import Ack
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="running", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True),
        ]


@pytest.mark.live
def test_live_bedrock_smoke():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )
    result = agent.chat("do a happy wiggle")
    assert result["reply_text"].strip()
    assert result["emote"] is not None
