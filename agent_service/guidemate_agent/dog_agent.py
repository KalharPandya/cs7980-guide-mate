"""Robert the robot dog — Strands agent with emote + robot-truth tools."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

from pydantic import ValidationError
from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

log = logging.getLogger(__name__)

PERSONA = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies. "
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood. "
    "You also have run_motion (tricks: 'circle' or 'spin'), stop, and get_status "
    "tools. Use run_motion ONLY when the user asks for a trick by name. "
    "If the robot reports being docked or motion-locked (motion_enabled false), "
    "always mention that in your reply."
)

_OFFLINE = "robot did not respond — I'm probably napping offline"


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

    @staticmethod
    def _describe_acks(acks) -> str:
        """Model-facing summary of a command's ack outcome."""
        if not acks:
            return _OFFLINE
        last = acks[-1]
        if last.state == "failed":
            if last.reason == "docked":
                return "the robot refused: it is docked"
            if last.reason == "motion_disabled":
                return "the robot refused: motion is disabled"
            return f"the robot refused: {last.reason}"
        if last.simulated:
            return "delivered (simulated — dry-run, the robot stayed still)"
        return "delivered"

    def _emote_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands."""
        captured["emote"] = name
        if target is None:
            return _OFFLINE
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        captured["acks"].extend(a.model_dump() for a in acks)
        if not acks:
            return _OFFLINE
        if acks[-1].simulated:
            return "emote delivered (simulated)"
        return "emote delivered"

    def _motion_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        try:
            cmd = Command(type="motion", name=name)
        except ValidationError:
            return "unknown trick — I only know 'circle' and 'spin'"
        acks = self._registry.send_command(target, cmd)
        captured["acks"].extend(a.model_dump() for a in acks)
        return self._describe_acks(acks)

    def _stop_impl(self, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        acks = self._registry.send_command(target, Command(type="stop", name="stop"))
        captured["acks"].extend(a.model_dump() for a in acks)
        return self._describe_acks(acks)

    def _status_impl(self, target: Optional[str]) -> str:
        if target is None:
            return json.dumps({"presence": "unknown"})
        return json.dumps(self._registry.get_status(target), default=str)

    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}

        @tool
        def send_emote(name: str) -> str:
            """Play a physical emote on the dog. name is one of happy, yes, no."""
            return self._emote_impl(name, target, captured)

        @tool
        def run_motion(name: str) -> str:
            """Run a motion trick on the dog. name is one of: circle, spin."""
            return self._motion_impl(name, target, captured)

        @tool
        def stop() -> str:
            """Immediately stop the dog's current motion."""
            return self._stop_impl(target, captured)

        @tool
        def get_status() -> str:
            """Get the dog's live status: presence, battery, dock state, safety gates."""
            return self._status_impl(target)

        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(
            model=model,
            system_prompt=PERSONA,
            tools=[send_emote, run_motion, stop, get_status],
        )
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
