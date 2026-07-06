"""Robert the robot dog — Strands agent that emotes exactly once per reply."""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

log = logging.getLogger(__name__)

PERSONA = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies. "
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood."
)


class DogAgent:
    def __init__(
        self,
        registry,
        model_id: str,
        robot_ids: list[str],
        region: str = "us-west-2",
    ) -> None:
        self._registry = registry
        self._model_id = model_id
        self._robot_ids = robot_ids
        self._region = region

    def _emote_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands."""
        captured["emote"] = name
        if target is None:
            return "robot did not respond — I'm probably napping offline"
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        captured["acks"] = [a.model_dump() for a in acks]
        if not acks:
            return "robot did not respond — I'm probably napping offline"
        return "emote delivered (simulated)"

    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}

        @tool
        def send_emote(name: str) -> str:
            """Play a physical emote on the dog. name is one of happy, yes, no."""
            return self._emote_impl(name, target, captured)

        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(model=model, system_prompt=PERSONA, tools=[send_emote])
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
