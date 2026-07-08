"""Robert the robot dog — Strands agent with per-turn flag gating.

Flags are read fresh from the ConfigStore every turn (a fresh Strands Agent is
already built per chat() call), so an admin flag flip takes effect on the very
next message: a disabled tool disappears from the model's tool list, and the
system prompt swaps persona / mutes emotes / drops the motion rules accordingly.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Optional

from pydantic import ValidationError
from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command
from guidemate_msgs.metrics import emit_metric

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


def _usage_from_result(result) -> Optional[tuple[int, int]]:
    """Pull (input_tokens, output_tokens) out of a Strands AgentResult, or None.

    Guarded so a missing/odd-shaped `metrics.accumulated_usage` (or a plain str
    result, as returned by the test fakes) never crashes a turn — metrics are
    best-effort, never load-bearing.
    """
    metrics = getattr(result, "metrics", None)
    usage = getattr(metrics, "accumulated_usage", None) if metrics is not None else None
    if not usage:
        return None
    try:
        return int(usage["inputTokens"]), int(usage["outputTokens"])
    except (KeyError, TypeError, ValueError):
        return None


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

    def _enabled_tool_names(self, flags: dict, physical: bool = True) -> list:
        """Ordered names of the tools offered to the model this turn.

        The motion tools (run_motion/stop) are lock-gated: they are only offered
        when the session PHYSICALLY holds the robot (physical=True). A virtual
        session (no lock) never sees them, so the model cannot even attempt to
        drive a robot it isn't bound to. Default physical=True preserves the
        legacy (no-session) behaviour.
        """
        names: list = []
        if flags.get("emotes_enabled", True):
            names.append("send_emote")
        if physical and flags.get("motion_tools_enabled", True):
            names.extend(["run_motion", "stop"])
        # get_status is a read-only truth tool with no flag, but it is still
        # PHYSICAL-only: a virtual/unbound session must not read another robot's
        # live status. The legacy no-session path is physical=True and keeps it.
        if physical:
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

    def _build_system_prompt(
        self, user_name: Optional[str], history, flags: Optional[dict] = None
    ) -> str:
        """Persona/flag prompt + optional 'talking with <name>' line + last-10
        message recap. Layers session awareness on top of the flag-driven
        persona so an admin persona/mute flip still steers the base prompt."""
        if flags is None:
            flags = self._flags()
        parts = [self._system_prompt(flags)]
        if user_name:
            parts.append(
                f"You are talking with {user_name}. Greet them warmly by name "
                "now and then."
            )
        if history:
            lines = []
            for m in history[-10:]:
                who = "User" if m.get("role") == "user" else "Robert"
                lines.append(f"{who}: {m.get('text', '')}")
            parts.append("Recent conversation so far:\n" + "\n".join(lines))
        return "\n\n".join(parts)

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

    def _emote_impl(self, name: str, target: Optional[str], captured: dict,
                    physical: bool = True) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands.

        physical=False is the VIRTUAL path (session holds no robot lock): the
        emote name is captured for avatar animation but nothing is published to
        MQTT. physical=True (the default, and the legacy no-session behaviour)
        publishes to the target robot. This is the lock gate — a virtual session
        can wag the avatar but can never move a physical dog.
        """
        captured["emote"] = name
        if not physical:
            return "virtual emote played (avatar only — not connected to a robot)"
        if target is None:
            return _OFFLINE
        t0 = time.perf_counter()
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        emit_metric(
            "AckRoundTripMs",
            (time.perf_counter() - t0) * 1000.0,
            "Milliseconds",
            {"robot_id": target},
        )
        captured["acks"].extend(a.model_dump() for a in acks)
        if not acks:
            return _OFFLINE
        if acks[-1].simulated:
            return "emote delivered (simulated)"
        return "emote delivered"

    # The LLM run_motion tool may only trigger tricks. dock/undock/forward are
    # valid Command names but belong to the assignment lifecycle (sessions.py) —
    # never LLM-reachable, so the model can't move the robot off/onto its dock.
    _LLM_TRICKS = ("circle", "spin")

    def _motion_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        if name not in self._LLM_TRICKS:
            return "unknown trick — I only know 'circle' and 'spin'"
        try:
            cmd = Command(type="motion", name=name)
        except ValidationError:
            return "unknown trick — I only know 'circle' and 'spin'"
        t0 = time.perf_counter()
        acks = self._registry.send_command(target, cmd)
        emit_metric(
            "AckRoundTripMs",
            (time.perf_counter() - t0) * 1000.0,
            "Milliseconds",
            {"robot_id": target},
        )
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

    def _kb_impl(self, query: str, captured: Optional[dict] = None) -> str:
        """Body of the retrieve_kb tool. The tool is only ever offered to the
        model once the KB surface exists (see _kb_available), so the fallback
        string is a belt-and-suspenders guard.

        When ``captured`` is provided, the citation sources for this retrieval
        are accumulated onto ``captured["kb_sources"]`` (de-duplicated by title
        across multiple retrieve_kb calls in one turn) so the WS/reply layer can
        surface them to the frontend. A turn that never grounds leaves the list
        empty. Sources capture is best-effort — any failure there degrades to the
        plain-text passages so the turn still answers.
        """
        if captured is None:
            retrieve_passages = self._load_retrieve_passages()
            if retrieve_passages is None:
                return "knowledge base is unavailable right now"
            return retrieve_passages(query, region=self._region)
        try:
            from guidemate_agent.kb import retrieve_passages_with_sources
        except ImportError:
            return "knowledge base is unavailable right now"
        text, sources = retrieve_passages_with_sources(query, region=self._region)
        existing = {s.get("title") for s in captured.get("kb_sources", [])}
        for src in sources:
            if src.get("title") not in existing:
                existing.add(src.get("title"))
                captured.setdefault("kb_sources", []).append(src)
        return text

    # --- tool construction (per-turn registry mechanism) -----------------
    def _build_tools(self, names: list, target: Optional[str], captured: dict,
                     physical: bool = True) -> list:
        tools: list = []
        if "send_emote" in names:

            @tool
            def send_emote(name: str) -> str:
                """Play an emote on the dog. name is one of happy, yes, no."""
                return self._emote_impl(name, target, captured, physical)

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
                return self._kb_impl(query, captured)

            tools.append(retrieve_kb)
        return tools

    @classmethod
    def _kb_available(cls) -> bool:
        """True when the retrieve_passages KB surface is importable. Keeps the
        model from being handed a KB tool that can't do anything, while the name
        still gates through _enabled_tool_names for admin/flag purposes."""
        return cls._load_retrieve_passages() is not None

    # --- session resolution ----------------------------------------------
    def _resolve_session(self, session_id: str):
        """Look a session up in the sessions layer. Returns
        (user_name, history, physical, target):

        - user_name / history come from the session record + its message log
          (last 10 messages injected into the system prompt).
        - target/physical come from sessions.robot_for_session, which is
          authoritative: it returns a robot id ONLY when the session both binds
          that robot AND currently holds its lock. None => virtual mode (avatar
          only; emotes are captured but not published, motion tools withheld).

        Imported lazily so dog_agent stays importable without the DynamoDB-backed
        sessions surface (mirrors the KB lazy import).
        """
        from guidemate_agent import sessions

        session = sessions.get_session(session_id) or {}
        user_name = session.get("name")
        history = sessions.get_messages(session_id, limit=10)
        bound = sessions.robot_for_session(session_id)
        physical = bound is not None
        target = bound if physical else (self._robot_ids[0] if self._robot_ids else None)
        return user_name, history, physical, target

    # --- main turn --------------------------------------------------------
    def chat(
        self,
        message: Optional[str] = None,
        session_id: Optional[str] = None,
        robot_id: Optional[str] = None,
        system_event: Optional[str] = None,
        allow_motion: bool = True,
    ) -> dict:
        """Run one turn.

        Normal (user-driven) turns pass `message`. Agent-initiated ("autonomy")
        turns pass `system_event` instead (message=None) — there is no user
        utterance, just a fact the dog reacts to unprompted (e.g. low battery,
        morning stretch). `allow_motion=False` strips run_motion/stop from the
        tool list regardless of flags/lock state, so autonomy turns can never
        drive the robot — only speak/emote.
        """
        turn_id = str(uuid.uuid4())
        flags = self._flags()

        if session_id is not None:
            user_name, history, physical, target = self._resolve_session(session_id)
        else:
            # Legacy (no session): physical against the caller-named / first robot.
            user_name, history, physical = None, None, True
            target = robot_id or (self._robot_ids[0] if self._robot_ids else None)

        def _wrap(reply: dict) -> dict:
            # Echo session_id ONLY when the caller passed one, so the legacy
            # return shape (4 keys) stays byte-for-byte identical.
            if session_id is not None:
                reply["session_id"] = session_id
            return reply

        if flags.get("dog_muted", False):
            return _wrap({
                "reply_text": "(the dog is sleeping)",
                "emote": None,
                "robot": [],
                "turn_id": turn_id,
                # Keep the "sources always present" contract on BOTH transports:
                # /api/chat returns this dict directly, so a muted turn must still
                # carry sources (WS is guarded by .get, but /api/chat is not).
                "sources": [],
            })

        captured = {"emote": None, "acks": [], "kb_sources": []}
        names = self._enabled_tool_names(flags, physical)
        if not allow_motion:
            names = [n for n in names if n not in ("run_motion", "stop")]
        tools = self._build_tools(names, target, captured, physical)
        system_prompt = self._build_system_prompt(user_name, history, flags)
        if system_event is not None:
            system_prompt += (
                "\n\nThis turn was triggered by a system event, not a user message — "
                "there is no one to greet by name; react to the event naturally."
            )
        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(model=model, system_prompt=system_prompt, tools=tools)
        agent_input = message if system_event is None else system_event
        result = agent(agent_input)
        reply_text = str(result)
        usage = _usage_from_result(result)
        if usage is not None:
            emit_metric("BedrockInputTokens", usage[0])
            emit_metric("BedrockOutputTokens", usage[1])

        if session_id is not None:
            from guidemate_agent import sessions

            if message is not None:
                sessions.append_message(session_id, "user", message)
            sessions.append_message(session_id, "dog", reply_text)

        return _wrap({
            "reply_text": reply_text,
            "emote": captured["emote"],
            "robot": captured["acks"],
            # KB citation sources for this turn ([] when the turn didn't ground on
            # the KB). The WS/reply layer surfaces these to the frontend.
            "sources": captured["kb_sources"],
            "turn_id": turn_id,
        })
