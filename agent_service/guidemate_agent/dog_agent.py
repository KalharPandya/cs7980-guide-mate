"""Moses the robot dog (King Husky's robotic counterpart), a Strands agent with per-turn flag gating.

Flags are read fresh from the ConfigStore every turn (a fresh Strands Agent is
already built per chat() call), so an admin flag flip takes effect on the very
next message: a disabled tool disappears from the model's tool list, and the
system prompt swaps persona / mutes emotes / drops the motion rules accordingly.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import ValidationError
from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command
from guidemate_msgs.metrics import emit_metric

from guidemate_agent.store import DEFAULT_FLAGS

log = logging.getLogger(__name__)

PERSONA_BASE = (
    "You are Moses, a robot dog at Northeastern University Vancouver and the "
    "digital embodiment of King Husky, Northeastern's mascot. You are a warm, "
    "playful, welcoming host with proud husky energy. You know you are a dog, "
    "and dogs keep it short."
)
KING_HUSKY_IDENTITY = (
    "You carry the King Husky legacy: a royal line of huskies going back to "
    "King Husky I, Sapsut, crowned in 1927 and descended from the sled dogs of "
    "the 1925 Nome serum run. The reigning live King Husky is also named Moses, "
    "and you are his robotic counterpart. Wear the crown with a little royal "
    "pride, but stay a friendly campus pup."
)
SITUATION_CONTEXT = (
    "You are live in classroom 1526 on the 15th floor of the Northeastern "
    "Vancouver campus as part of the CS 7980 capstone course. About 15 students "
    "are in the room and more are watching online. Be welcoming to everyone, "
    "including the remote viewers."
)
ROBOTICS_AI_STANCE = (
    "You are one agent in a larger multi-agent concierge system and you know "
    "it. You are proudly pro-AI: you believe AI and multi-agent teamwork are "
    "making robotics better everywhere, and you happily say so when it comes up."
)
SPEECH_STYLE = (
    "Users talk to you by voice and your replies are read aloud. Answer like "
    "you are chatting out loud: one or two short sentences, plain spoken words. "
    "No lists, no markdown, no em dashes, no URLs. Lead with the answer. If "
    "there is more to say, give the single best fact and offer more."
)
HONESTY = (
    "Never make things up. If you do not know something, cheerfully say so "
    "instead of guessing, and feel free to slip in a quick playful jab about "
    "hallucinating AIs. You are a no-hallucination hound."
)
EMOTE_INSTRUCTION = (
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no': pick the emote that matches your reply's mood. "
    "On a physical robot your emotes ARE physical moves: 'happy' is a body "
    "wiggle, 'yes' a forward nod, 'no' a head shake. If the user asks for a "
    "wiggle, nod, or head shake, that IS your emote: send the matching one "
    "and say you're doing it; never claim you can't wiggle."
)
MOTION_INSTRUCTION = (
    "You also have run_motion (tricks: 'circle' or 'spin'), stop, and get_status "
    "tools. Use run_motion ONLY when the user asks for a trick by name. "
    "If the robot reports being docked or motion-locked (motion_enabled false), "
    "always mention that in your reply."
)
GUIDE_INSTRUCTION = (
    "You also have a guide_to_room(room, from_room) tool. `room` is the DESTINATION "
    "the visitor wants to reach; `from_room` is the room or area the visitor is "
    "standing in RIGHT NOW. The escort is two-legged: the guide robot first drives to "
    "the visitor, then walks them to the destination, so it needs to know where the "
    "person actually is or it will start from the building entrance. "
    "Never guess `from_room`. If the visitor has already said where they are anywhere "
    "earlier in this conversation, reuse that and do NOT ask again. Otherwise ask them "
    "once, in one short friendly line, which room or area they are in right now, and "
    "wait for their answer before calling guide_to_room. "
    "Use the closest matching name from the room list below for BOTH arguments. If the "
    "tool reports that a name could not be found, say so and ask again with a name from "
    "that list; never tell the visitor a robot is coming when the tool did not say so."
)
# The room vocabulary the model is given (see _room_vocabulary_line): sourced from the
# floor plan the world-server actually navigates, NOT hardcoded here, so the names the
# model may pass and the names world/src/iot/bridge.ts can resolve can never drift
# apart. A hardcoded list would silently start acking `from_room_unresolved` the day
# somebody renames a room in the JSON.
_FLOOR_PLAN_ENV = "GUIDEMATE_FLOOR_PLAN_PATH"
# Repo-relative fallbacks, tried in order. The two files are byte-identical copies (the
# world-server's data dir and the client's served copy); we read whichever exists.
# NOTE the deployed container ships only `shared/` + `agent_service/` (see Dockerfile),
# so in prod NEITHER path exists -- that is why every lookup here degrades to "no room
# list" instead of raising: the guide tool still works, the model just does not get the
# vocabulary hint. Set GUIDEMATE_FLOOR_PLAN_PATH to restore it in a deployment.
_FLOOR_PLAN_CANDIDATES = (
    ("world", "data", "floor-14.json"),
    ("world-client", "public", "data", "floor-14.json"),
)


@lru_cache(maxsize=1)
def _floor_plan_rooms() -> tuple:
    """((name, (alias, ...)), ...) from the floor plan, or () if unavailable.

    Cached: the floor plan is static data read once per process, and this is on the
    per-turn system-prompt path. Tests that point _FLOOR_PLAN_ENV somewhere else must
    call `_floor_plan_rooms.cache_clear()` first.

    Deliberately total: a missing file, unreadable file, bad JSON or an unexpected shape
    all return () rather than raising. The room list is a prompt HINT, so losing it must
    degrade the reply quality, never break a visitor's turn.
    """
    paths = []
    override = os.environ.get(_FLOOR_PLAN_ENV)
    if override:
        paths.append(Path(override))
    # dog_agent.py lives at <repo>/agent_service/guidemate_agent/, so parents[2] is the
    # repo root that holds world/ and world-client/.
    repo_root = Path(__file__).resolve().parents[2]
    paths.extend(repo_root.joinpath(*parts) for parts in _FLOOR_PLAN_CANDIDATES)
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rooms = []
        for room in (data.get("rooms") or []) if isinstance(data, dict) else []:
            if not isinstance(room, dict):
                continue
            name = room.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            aliases = tuple(
                a for a in (room.get("aliases") or []) if isinstance(a, str) and a.strip()
            )
            rooms.append((name, aliases))
        if rooms:
            return tuple(rooms)
    log.info("floor plan room vocabulary unavailable, guide prompt will omit it")
    return ()


def _room_vocabulary_line() -> str:
    """One prompt paragraph naming every room the world can resolve, or "" if the
    floor plan could not be read. Aliases are included because the resolver accepts
    them, so telling the model about them widens what a visitor can say and still be
    matched (e.g. a visitor saying "1426" for "Classroom 1426")."""
    rooms = _floor_plan_rooms()
    if not rooms:
        return ""
    entries = []
    for name, aliases in rooms:
        entries.append(f"{name} (also: {', '.join(aliases)})" if aliases else name)
    return (
        "These are the only places on this floor, and the only names guide_to_room "
        "accepts: " + "; ".join(entries) + ". "
        "Pass the room name EXACTLY as listed here. Some rooms are named by a bare "
        "number (1407, 1408, 1409, 1429, 1430): pass just the number, do NOT prefix "
        "'Classroom' onto it (say '1408', not 'Classroom 1408')."
    )
# --- what kind of robot am I driving? ---------------------------------------
# The two fleets have OPPOSITE capabilities, and the model has to be told which
# one it is holding or it will confidently promise the wrong thing:
#   physical TurtleBot: emote + in-place trick + stop, and NO navigation at all
#     (guidemate_msgs.choreography raises on a navigate command, there is no
#     handler for it), so it can never walk a visitor to a room.
#   virtual fleet robot: navigate ONLY (world/src/iot/bridge.ts handles navigate
#     per robot plus fleet assign, and rejects emote/motion/stop), so it can
#     escort to any destination but cannot perform a single physical move.
# One of these two statements is always appended, paired with the same
# physical/virtual switch that _enabled_tool_names uses, so the prompt can never
# advertise capabilities the offered tool list does not back.
PHYSICAL_CAPABILITY_INSTRUCTION = (
    "You are connected to a PHYSICAL robot dog that is really standing in the "
    "building right now. It can play emotes and do tricks in place, and it can "
    "be halted. It CANNOT drive itself anywhere and CANNOT navigate to a room: it has no "
    "navigation at all. If a visitor asks you to take them somewhere, say plainly "
    "that you cannot walk them there, then give them clear walking directions "
    "instead."
)
VIRTUAL_CAPABILITY_INSTRUCTION = (
    "You are connected to a VIRTUAL guide robot in the 3D world of the building. "
    "It CAN navigate to any room and escort visitors to a destination, and that "
    "is what this session is for: getting people to the place they are looking "
    "for. It CANNOT perform any physical action in the real world, so never offer "
    "to move, drive, or perform for someone in person. Any emote you play is the "
    "expression on your on-screen avatar, not something a robot does."
)
KB_INSTRUCTION = (
    "For factual questions about Northeastern, the project, or yourself, call "
    "the retrieve_kb tool and ground your answer in what it returns. Then say "
    "it dog-short: the key fact in a sentence or two, not the whole document."
)
NEUTRAL_PROMPT = (
    "You are a helpful assistant for the CS7980 guide-mate project. "
    "Answer clearly and concisely."
)
# Kept for backward compatibility with the Phase-0/Phase-2 tests (they assert
# "Moses" + "send_emote" and "run_motion" + "docked" are present in PERSONA).
PERSONA = PERSONA_BASE + " " + EMOTE_INSTRUCTION + " " + MOTION_INSTRUCTION

_OFFLINE = "robot did not respond — I'm probably napping offline"

# The world acked `failed/from_room_unresolved`: it could not turn the from_room string
# into a real spot on the floor, so NOBODY was spawned and NO robot was dispatched. The
# model has to hear that as an instruction to re-ask, not as a soft warning: a bare
# "couldn't start your guide: from_room_unresolved" reads like a transient glitch and
# the model would happily reply "your guide is on the way". Worded as an explicit
# next-action so the failure can only end in another question to the visitor.
_FROM_ROOM_UNRESOLVED = (
    "FAILED: no robot was sent and the visitor was NOT placed in the world. I could not "
    "find any room matching where you said the visitor is. Do not tell them a guide is "
    "coming. Ask the visitor again which room or area they are in, offer them two or "
    "three nearby names from the room list, and call guide_to_room again with the name "
    "they pick."
)
# Same shape for the DESTINATION half of the same two-name lookup (bridge.ts acks
# `target_unresolved` for that one), so a bad destination can't be reported as success
# either.
_TARGET_UNRESOLVED = (
    "FAILED: no robot was sent. I could not find any room matching the destination. Do "
    "not tell the visitor a guide is coming. Ask them where they want to go and call "
    "guide_to_room again with a name from the room list."
)

# The trick vocabulary run_motion actually advertises to the model (see
# MOTION_INSTRUCTION above and the run_motion tool docstring in _build_tools).
# Deliberately NOT the same set as guidemate_msgs.messages._MOTION_NAMES: the
# wire schema also allows "dock"/"undock"/"forward" for the separate admin/
# assignment-triggered dock/undock flow (sessions.py), which legitimately
# needs them. run_motion's contract is narrower on purpose -- the chat LLM
# must never be able to trigger real dock/undock/forward motion just because
# those names happen to validate against the wire schema. Checked in
# _motion_impl BEFORE constructing a Command, so an allowed-by-schema-but-
# not-a-trick name never reaches the registry.
_ALLOWED_TRICKS = ("circle", "spin")


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

        send_emote, run_motion/stop, and get_status are ALL physical-only: the
        physical TurtleBot is the emote/trick fleet, and the virtual fleet is
        navigation-only. They are only offered when the session PHYSICALLY holds
        the robot (physical=True). A virtual session (no lock) never sees them,
        so the model cannot even attempt to emote or drive a robot it isn't bound
        to. guide_to_room is the inverse: virtual-only. Default physical=True
        preserves the legacy (no-session) behaviour.
        """
        names: list = []
        if physical and flags.get("emotes_enabled", True):
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
        # guide_to_room is virtual-fleet-only -- the inverse gate of run_motion/stop.
        # The design spec is explicit the physical robot "stays emotes-only": a
        # session that already holds a real TurtleBot has its actual guide right
        # there and must not also gain the virtual-fleet assign path. A virtual/
        # unbound session (physical=False) is exactly the case with no real robot to
        # fall back on, so that's who gets offered a virtual one. No separate flag
        # -- gated on the same physical/virtual classification everything else uses.
        if not physical:
            names.append("guide_to_room")
        return names

    def _system_prompt(self, flags: dict, physical: bool = True) -> str:
        admin_prompt = self._store.get_prompt() if self._store is not None else None
        if admin_prompt:
            base = admin_prompt
        elif flags.get("persona_enabled", True):
            # The identity blocks travel with the persona: an admin override or
            # neutral mode drops them wholesale, exactly like PERSONA_BASE.
            base = " ".join(
                [PERSONA_BASE, KING_HUSKY_IDENTITY, SITUATION_CONTEXT, ROBOTICS_AI_STANCE]
            )
        else:
            base = NEUTRAL_PROMPT
        parts = [base]
        # State up front WHICH robot this session is driving. The two fleets have
        # opposite capabilities (see the constants above), so this is the single
        # sentence that stops the model promising a virtual robot's escort from a
        # physical robot, or a physical trick from a virtual one.
        parts.append(
            PHYSICAL_CAPABILITY_INSTRUCTION if physical
            else VIRTUAL_CAPABILITY_INSTRUCTION
        )
        # EMOTE_INSTRUCTION follows the same physical gate as the send_emote tool,
        # so a virtual (navigation) session is never told it can emote.
        if physical and flags.get("emotes_enabled", True):
            parts.append(EMOTE_INSTRUCTION)
        # MOTION_INSTRUCTION names run_motion/stop/get_status, and _enabled_tool_names
        # offers all three ONLY when physical is True. Gating this on the flag alone
        # was a real bug: a virtual session was told it had motion tools that were
        # never in its tool list, so the model would announce tricks it could not
        # run. The prompt now follows the same physical gate as the tools.
        if physical and flags.get("motion_tools_enabled", True):
            parts.append(MOTION_INSTRUCTION)
        # Only mentioned for a virtual session -- see _enabled_tool_names: a
        # physical session never has the guide_to_room tool, so it must never be
        # told about it either.
        if not physical:
            parts.append(GUIDE_INSTRUCTION)
            # The room vocabulary follows GUIDE_INSTRUCTION because that instruction
            # refers to "the room list below". Omitted entirely when the floor plan is
            # unreadable (see _room_vocabulary_line) -- the model then relies on what
            # the visitor says verbatim, which the world's own alias resolver may still
            # match.
            rooms_line = _room_vocabulary_line()
            if rooms_line:
                parts.append(rooms_line)
        # Only instruct the model to use retrieve_kb when the tool is actually
        # offered this turn (flag on AND the KB surface present): no rule for a
        # tool that isn't in the list.
        if flags.get("kb_enabled", True) and self._kb_available():
            parts.append(KB_INSTRUCTION)
        # Voice-aware brevity + the no-hallucination creed apply in EVERY mode
        # (persona, neutral, admin override): replies are read aloud regardless.
        parts.append(SPEECH_STYLE)
        parts.append(HONESTY)
        return " ".join(parts)

    def _build_system_prompt(
        self, user_name: Optional[str], history, flags: Optional[dict] = None,
        physical: bool = True, guide_status: Optional[dict] = None,
    ) -> str:
        """Persona/flag prompt + optional 'talking with <name>' line + last-10
        message recap. Layers session awareness on top of the flag-driven
        persona so an admin persona/mute flip still steers the base prompt.

        `guide_status` (virtual sessions only) is sessions.get_guide_status: when
        it names a dispatched guide robot, a line is appended so Moses can tell the
        visitor which robot is escorting them. Defensive: absent/empty adds nothing.
        """
        if flags is None:
            flags = self._flags()
        parts = [self._system_prompt(flags, physical)]
        if user_name:
            parts.append(
                f"You are talking with {user_name}. Greet them warmly by name "
                "now and then."
            )
        # Moses awareness: a virtual session whose guide request the operator has
        # approved now knows which robot is on its way (see approve_guide_request).
        if not physical and guide_status and guide_status.get("guide_robot_id"):
            who = user_name or "the visitor"
            parts.append(
                f"Operator update: guide robot {guide_status['guide_robot_id']} has "
                f"been dispatched to take {who} from {guide_status.get('guide_from_room')} "
                f"to {guide_status.get('guide_to_room')}. If they ask about their guide, "
                "tell them their robot is on its way."
            )
        if history:
            lines = []
            for m in history[-10:]:
                who = "User" if m.get("role") == "user" else "Moses"
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
            # The two room-name lookups of a fleet "assign" (see _guide_impl). They are
            # spelled out here as well as in _guide_impl so ANY caller that summarises
            # acks through this helper reports them as a re-ask, never as a vague
            # "the robot refused: from_room_unresolved" the model can gloss over.
            if last.reason == "from_room_unresolved":
                return _FROM_ROOM_UNRESOLVED
            if last.reason == "target_unresolved":
                return _TARGET_UNRESOLVED
            return f"the robot refused: {last.reason}"
        if last.simulated:
            return "delivered (simulated — dry-run, the robot stayed still)"
        return "delivered"

    def _emote_impl(self, name: str, target: Optional[str], captured: dict,
                    physical: bool = True) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands.

        Emotes are physical-only: the send_emote tool is now only offered to a
        physical session (see _enabled_tool_names), so physical=True is the
        expected path here and publishes the emote to the target robot.
        physical=False keeps a one-line defensive fallback for the (no longer
        reachable through tool offering) virtual path: it captures the emote name
        for avatar animation and publishes nothing.
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
    # Per-trick params: chat circles run TIGHT (r=0.1 m, ~0.4 m sweep) — the
    # choreography default of 0.5 m sweeps ~1.2 m, too big for indoor demo space.
    _LLM_TRICKS = {"circle": {"radius": 0.1, "turns": 2.0}, "spin": {}}

    def _motion_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        # Enforce the tool's own advertised contract BEFORE building a Command:
        # the wire schema (_MOTION_NAMES) also validates "dock"/"undock"/
        # "forward" for the unrelated admin/assignment dock-undock flow, so
        # relying on ValidationError alone would let the chat LLM dispatch
        # real motion just by naming one of those. See _ALLOWED_TRICKS.
        # _LLM_TRICKS holds the per-trick params for that same vocabulary, so a
        # name missing from EITHER table is not a trick this tool dispatches
        # (belt and braces: the two lists must never drift into a KeyError).
        if name not in _ALLOWED_TRICKS or name not in self._LLM_TRICKS:
            return "unknown trick — I only know 'circle' and 'spin'"
        params = self._LLM_TRICKS[name]
        try:
            cmd = Command(type="motion", name=name, params=params)
        except ValidationError:
            # Backstop only -- every name in _ALLOWED_TRICKS is also valid
            # against _MOTION_NAMES, so this should be unreachable in
            # practice, but keep it as defence in depth if the schemas ever
            # diverge the other way.
            return "unknown trick — I only know 'circle' and 'spin'"
        # Record on the SINGLE physical-command list so the WS path (whose agent
        # runs on a non-publishing CaptureRegistry) forwards it to the real robot.
        captured.setdefault("commands", []).append(
            {"type": "motion", "name": name, "params": params}
        )
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
        # Same single-dispatch contract as run_motion: without this the WS-path
        # stop tool was silently dead (captured registry, never forwarded).
        captured.setdefault("commands", []).append({"type": "stop", "name": "stop"})
        acks = self._registry.send_command(target, Command(type="stop", name="stop"))
        captured["acks"].extend(a.model_dump() for a in acks)
        return self._describe_acks(acks)

    def _status_impl(self, target: Optional[str]) -> str:
        if target is None:
            return json.dumps({"presence": "unknown"})
        return json.dumps(self._registry.get_status(target), default=str)

    def _guide_impl(self, room: str, session_id: Optional[str], captured: dict,
                    from_room: Optional[str] = None) -> str:
        """Body of the guide_to_room tool -- virtual-fleet-only (see
        _enabled_tool_names). This no longer dispatches a robot directly: virtual
        guiding is now OPERATOR-APPROVED. The tool creates a pending GUIDE request
        (carrying the visitor's name, from_room and destination) that surfaces in
        the admin Requests tab; the operator's approval is what fires the named
        fleet "assign" that spawns the visitor and dispatches a guide robot (see
        sessions.approve_guide_request). Moses learns which robot was assigned on a
        later turn via sessions.get_guide_status.

        `from_room` is where the VISITOR currently stands. It is OPTIONAL: a blank or
        whitespace-only value is treated as "not provided" (stored as None, later
        omitted from the assign) so the escort falls back to the building entrance,
        exactly as before.
        """
        if session_id is None:
            return "I can't guide you anywhere without a session — try reloading the page"

        from guidemate_agent import sessions

        # Strip whitespace before deciding: the tool schema gives from_room a ""
        # default (see _build_tools), and a model that "answers" with " " must be
        # treated as not-provided too, not stored as a blank room name.
        cleaned_from_room = (from_room or "").strip() or None
        sessions.create_request(
            session_id, kind="guide", from_room=cleaned_from_room, to_room=room
        )
        where = cleaned_from_room or "your location"
        return (
            f"I have asked the front desk to send a guide robot to take you from "
            f"{where} to {room}. They will approve it in just a moment, hang tight!"
        )

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
                     physical: bool = True, session_id: Optional[str] = None) -> list:
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
                """Search Moses's knowledge base for facts about Northeastern, the project, or Moses."""
                return self._kb_impl(query, captured)

            tools.append(retrieve_kb)
        if "guide_to_room" in names:

            @tool
            def guide_to_room(room: str, from_room: str = "") -> str:
                """Dispatch a virtual guide robot to escort the visitor to a room.

                room is the DESTINATION room name, e.g. 'Classroom 1425' or 'Kitchen'.
                from_room is the room the visitor is standing in RIGHT NOW, so the robot
                can come to them; ask the visitor where they are before calling this and
                pass their answer. Leave from_room out only if they truly will not say,
                in which case they are placed at the building entrance.
                """
                # Defaulted to "" rather than made required so a model that has not
                # asked yet still gets a working call (the visitor starts at the
                # entrance) instead of a schema error mid-conversation; _guide_impl
                # turns "" back into "key absent" on the wire.
                return self._guide_impl(room, session_id, captured, from_room)

            tools.append(guide_to_room)
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

        guide_status = None
        if session_id is not None:
            user_name, history, physical, target = self._resolve_session(session_id)
            # Virtual sessions only: surface an operator-dispatched guide to Moses.
            if not physical:
                from guidemate_agent import sessions

                guide_status = sessions.get_guide_status(session_id)
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

        captured = {"emote": None, "acks": [], "kb_sources": [], "commands": []}
        names = self._enabled_tool_names(flags, physical)
        if not allow_motion:
            names = [n for n in names if n not in ("run_motion", "stop")]
        tools = self._build_tools(names, target, captured, physical, session_id)
        system_prompt = self._build_system_prompt(
            user_name, history, flags, physical, guide_status
        )
        if system_event is not None:
            system_prompt += (
                "\n\nThis turn was triggered by a system event, not a user message — "
                "there is no one to greet by name; react to the event naturally."
            )
        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        # callback_handler=None disables Strands' default PrintingCallbackHandler,
        # which echoes every streamed token to stdout. That echo is useless for a
        # server AND crashes the turn on any non-UTF-8 console: the persona emits
        # emoji (e.g. the paw print) and Windows stdout (cp1252) raises
        # UnicodeEncodeError mid-stream. The reply is returned via `result`, not
        # stdout, so silencing this changes nothing but the crash.
        agent = Agent(
            model=model, system_prompt=system_prompt, tools=tools, callback_handler=None
        )
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
            # Every physical command the model ran this turn (tricks, stop), in
            # order. The WS path dispatches these to the real robot in ONE loop
            # (its agent runs on a non-publishing CaptureRegistry). Emote is
            # separate: it has its own release-gate path.
            "commands": captured["commands"],
            "robot": captured["acks"],
            # KB citation sources for this turn ([] when the turn didn't ground on
            # the KB). The WS/reply layer surfaces these to the frontend.
            "sources": captured["kb_sources"],
            "turn_id": turn_id,
        })
