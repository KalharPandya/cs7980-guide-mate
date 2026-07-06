"""Robert the robot dog — Strands agent with per-turn flag gating.

Flags are read fresh from the ConfigStore every turn (a fresh Strands Agent is
already built per chat() call), so an admin flag flip takes effect on the very
next message: a disabled tool disappears from the model's tool list, and the
system prompt swaps persona / mutes emotes / drops the motion rules accordingly.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

from pydantic import ValidationError
from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

from guidemate_agent.store import DEFAULT_FLAGS

log = logging.getLogger(__name__)

PERSONA_BASE = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies."
)
EMOTE_INSTRUCTION = (
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood."
)
MOTION_INSTRUCTION = (
    "You also have run_motion (tricks: 'circle' or 'spin'), stop, and get_status "
    "tools. Use run_motion ONLY when the user asks for a trick by name. "
    "If the robot reports being docked or motion-locked (motion_enabled false), "
    "always mention that in your reply."
)
KB_INSTRUCTION = (
    "For factual questions about the project or about yourself, call the "
    "retrieve_kb tool and ground your answer in what it returns."
)
NEUTRAL_PROMPT = (
    "You are a helpful assistant for the CS7980 guide-mate project. "
    "Answer clearly and concisely."
)
# Kept for backward compatibility with the Phase-0/Phase-2 tests (they assert
# "Robert" + "send_emote" and "run_motion" + "docked" are present in PERSONA).
PERSONA = PERSONA_BASE + " " + EMOTE_INSTRUCTION + " " + MOTION_INSTRUCTION

_OFFLINE = "robot did not respond — I'm probably napping offline"


class DogAgent:
    def __init__(
        self,
        registry,
        model_id: str,
        robot_ids: list[str],
        region: str = "us-west-2",
        store=None,
    ) -> None:
        self._registry = registry
        self._model_id = model_id
        self._robot_ids = robot_ids
        self._region = region
        self._store = store

    # --- flag / prompt helpers -------------------------------------------
    def _flags(self) -> dict:
        return self._store.get_flags() if self._store is not None else dict(DEFAULT_FLAGS)

    def _enabled_tool_names(self, flags: dict) -> list:
        """Ordered names of the tools offered to the model this turn."""
        names: list = []
        if flags.get("emotes_enabled", True):
            names.append("send_emote")
        if flags.get("motion_tools_enabled", True):
            names.extend(["run_motion", "stop"])
        # get_status is a read-only truth tool with no flag — always available.
        names.append("get_status")
        if flags.get("kb_enabled", True):
            names.append("retrieve_kb")
        return names

    def _system_prompt(self, flags: dict) -> str:
        admin_prompt = self._store.get_prompt() if self._store is not None else None
        if admin_prompt:
            base = admin_prompt
        elif flags.get("persona_enabled", True):
            base = PERSONA_BASE
        else:
            base = NEUTRAL_PROMPT
        parts = [base]
        if flags.get("emotes_enabled", True):
            parts.append(EMOTE_INSTRUCTION)
        if flags.get("motion_tools_enabled", True):
            parts.append(MOTION_INSTRUCTION)
        # Only instruct the model to use retrieve_kb when the tool is actually
        # offered this turn (flag on AND the KB surface present) — no rule for a
        # tool that isn't in the list.
        if flags.get("kb_enabled", True) and self._kb_available():
            parts.append(KB_INSTRUCTION)
        return " ".join(parts)

    # --- tool bodies (testable without Strands) --------------------------
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

    @staticmethod
    def _load_retrieve_passages():
        """Lazily import the KB retrieval callable, or None if absent.

        Single source of truth for the lazy import used by both `_kb_available`
        (tool-offering / instruction gate) and `_kb_impl` (tool body), so the
        module stays importable before/without the kb.retrieve_passages surface."""
        try:
            from guidemate_agent.kb import retrieve_passages  # type: ignore
        except ImportError:
            return None
        return retrieve_passages

    def _kb_impl(self, query: str) -> str:
        """Body of the retrieve_kb tool. The tool is only ever offered to the
        model once the KB surface exists (see _kb_available), so this fallback
        string is a belt-and-suspenders guard."""
        retrieve_passages = self._load_retrieve_passages()
        if retrieve_passages is None:
            return "knowledge base is unavailable right now"
        return retrieve_passages(query, region=self._region)

    # --- tool construction (per-turn registry mechanism) -----------------
    def _build_tools(self, names: list, target: Optional[str], captured: dict) -> list:
        tools: list = []
        if "send_emote" in names:

            @tool
            def send_emote(name: str) -> str:
                """Play a physical emote on the dog. name is one of happy, yes, no."""
                return self._emote_impl(name, target, captured)

            tools.append(send_emote)
        if "run_motion" in names:

            @tool
            def run_motion(name: str) -> str:
                """Run a motion trick on the dog. name is one of: circle, spin."""
                return self._motion_impl(name, target, captured)

            tools.append(run_motion)
        if "stop" in names:

            @tool
            def stop() -> str:
                """Immediately stop the dog's current motion."""
                return self._stop_impl(target, captured)

            tools.append(stop)
        if "get_status" in names:

            @tool
            def get_status() -> str:
                """Get the dog's live status: presence, battery, dock state, safety gates."""
                return self._status_impl(target)

            tools.append(get_status)
        if "retrieve_kb" in names and self._kb_available():

            @tool
            def retrieve_kb(query: str) -> str:
                """Search Robert's knowledge base for facts about the project or Robert."""
                return self._kb_impl(query)

            tools.append(retrieve_kb)
        return tools

    @classmethod
    def _kb_available(cls) -> bool:
        """True when the retrieve_passages KB surface is importable. Keeps the
        model from being handed a KB tool that can't do anything, while the name
        still gates through _enabled_tool_names for admin/flag purposes."""
        return cls._load_retrieve_passages() is not None

    # --- main turn --------------------------------------------------------
    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        flags = self._flags()
        if flags.get("dog_muted", False):
            return {
                "reply_text": "(the dog is sleeping)",
                "emote": None,
                "robot": [],
                "turn_id": turn_id,
            }
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}
        names = self._enabled_tool_names(flags)
        tools = self._build_tools(names, target, captured)
        system_prompt = self._system_prompt(flags)
        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(model=model, system_prompt=system_prompt, tools=tools)
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
